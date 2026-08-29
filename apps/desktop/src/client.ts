export interface DesktopSigner {
  sign(message: string, reason: string, consequential: boolean): Promise<string>;
}

export interface DesktopClientOptions {
  readonly baseUrl: string;
  readonly deviceId: string;
  readonly signer: DesktopSigner;
  readonly hashBody: (body: string) => Promise<string>;
  readonly randomId: () => string;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly clockOffsetMs?: () => number;
}

export interface DesktopStreamAuthentication {
  readonly deviceId: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly signature: string;
}

export type DesktopResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly title: string;
      readonly detail: string;
      readonly retryable: boolean;
      readonly outcomeUnknown: boolean;
    };

interface SignatureParts {
  readonly method: string;
  readonly path: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly bodyHash: string;
  readonly commandNonce?: string;
}

export function canonicalString(parts: SignatureParts): string {
  return [
    'keel-v1',
    parts.method.toUpperCase(),
    parts.path,
    String(parts.timestamp),
    parts.nonce,
    parts.bodyHash,
    parts.commandNonce ?? '-',
  ].join('\n');
}

const COMMAND_PATHS = [
  /^\/scans$/,
  /^\/missions\/[^/]+\/(plan|abandon|review|orders)$/,
  /^\/orders\/[^/]+\/cancel$/,
  /^\/positions\/[^/]+\/(modify|close)$/,
  /^\/panic$/,
  /^\/policy$/,
  /^\/guard\/(lockout|release)$/,
];

function isCommandPath(path: string): boolean {
  return COMMAND_PATHS.some((pattern) => pattern.test(path));
}

function commandReason(path: string, summary?: string): string {
  if (summary !== undefined && summary.length > 0) return summary;
  if (/^\/missions\/[^/]+\/orders$/.test(path)) return 'Send this Mission-bound order';
  if (/^\/missions\/[^/]+\/plan$/.test(path)) return 'Seal this Mission plan';
  if (/^\/missions\/[^/]+\/abandon$/.test(path)) return 'Abandon this Mission';
  if (/^\/missions\/[^/]+\/review$/.test(path)) return 'Seal this Mission review';
  return 'Authorise this trading-desk command';
}

/**
 * Signed Windows/Desktop transport for the Desk.
 *
 * It deliberately refuses the legacy Mission-less POST /orders route. Desktop
 * code therefore cannot accidentally bypass ADR-0018 while the server keeps
 * that compatibility route temporarily for older clients.
 */
export class DesktopDeskClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: DesktopClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  async get<T>(path: string, attempts = 3): Promise<DesktopResult<T>> {
    let last: DesktopResult<T> | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      last = await this.request<T>('GET', path);
      if (last.ok || !last.retryable) return last;
    }
    return last as DesktopResult<T>;
  }

  async command<T>(path: string, body: unknown, summary?: string): Promise<DesktopResult<T>> {
    if (path === '/orders') {
      return {
        ok: false,
        status: 0,
        code: 'MISSION_REQUIRED',
        title: 'Trade Mission required',
        detail:
          'Windows/Desktop orders must use /missions/:missionId/orders. Legacy /orders is disabled in this client.',
        retryable: false,
        outcomeUnknown: false,
      };
    }
    return this.request<T>('POST', path, body, summary);
  }

  async preview<T>(body: unknown): Promise<DesktopResult<T>> {
    return this.request<T>('POST', '/preview', body);
  }

  /**
   * Build the read-only proof used by the authenticated `/stream` hello.
   *
   * Realtime and REST deliberately share one identity, clock-offset and
   * canonical signing contract. A reconnect always gets a fresh nonce; callers
   * must never cache this proof across sockets.
   */
  async streamAuthentication(): Promise<DesktopStreamAuthentication> {
    const timestamp = this.now() + (this.options.clockOffsetMs?.() ?? 0);
    const nonce = this.options.randomId();
    const bodyHash = await this.options.hashBody('');
    const signature = await this.options.signer.sign(
      canonicalString({
        method: 'GET',
        path: '/stream',
        timestamp,
        nonce,
        bodyHash,
      }),
      'Connect to your trading desk',
      false,
    );
    return { deviceId: this.options.deviceId, timestamp, nonce, signature };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    summary?: string,
  ): Promise<DesktopResult<T>> {
    const text = body === undefined ? '' : JSON.stringify(body);
    const consequential = isCommandPath(path);
    let commandNonce: string | undefined;

    if (consequential) {
      const nonce = await this.request<{ nonce: string }>('GET', '/command-nonce');
      if (!nonce.ok) {
        return {
          ok: false,
          status: nonce.status,
          code: 'NO_COMMAND_NONCE',
          title: 'Could not reach the desk',
          detail: `The desk did not issue an authorisation nonce: ${nonce.detail}`,
          retryable: true,
          outcomeUnknown: false,
        };
      }
      commandNonce = nonce.data.nonce;
    }

    const signatureParts: SignatureParts = {
      method,
      path,
      timestamp: this.now() + (this.options.clockOffsetMs?.() ?? 0),
      nonce: this.options.randomId(),
      bodyHash: await this.options.hashBody(text),
      ...(commandNonce === undefined ? {} : { commandNonce }),
    };

    let signature: string;
    try {
      signature = await this.options.signer.sign(
        canonicalString(signatureParts),
        commandReason(path, summary),
        consequential,
      );
    } catch (error) {
      return {
        ok: false,
        status: 0,
        code: 'NOT_AUTHORISED',
        title: 'Not authorised',
        detail: error instanceof Error ? error.message : String(error),
        retryable: false,
        outcomeUnknown: false,
      };
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-keel-device': this.options.deviceId,
      'x-keel-timestamp': String(signatureParts.timestamp),
      'x-keel-nonce': signatureParts.nonce,
      'x-keel-signature': signature,
    };
    if (commandNonce !== undefined) headers['x-keel-command-nonce'] = commandNonce;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    try {
      const response = await this.fetchFn(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        signal: controller.signal,
        ...(body === undefined ? {} : { body: text }),
      });
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok) return { ok: true, status: response.status, data: json as T };
      return {
        ok: false,
        status: response.status,
        code: (json.code as string) ?? `HTTP_${response.status}`,
        title: (json.title as string) ?? 'The desk refused this request',
        detail: (json.detail as string) ?? `HTTP ${response.status}`,
        retryable: (json.retryable as boolean) ?? response.status >= 500,
        outcomeUnknown: (json.outcomeUnknown as boolean) ?? false,
      };
    } catch (error) {
      const command = consequential;
      return {
        ok: false,
        status: 0,
        code: error instanceof Error && error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK',
        title: command ? 'Outcome unknown' : 'Could not reach the desk',
        detail: command
          ? 'The command may or may not have reached the desk. Do not resend automatically; reconcile first.'
          : error instanceof Error
            ? error.message
            : String(error),
        retryable: !command,
        outcomeUnknown: command,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
