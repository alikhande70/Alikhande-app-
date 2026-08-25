import { biometricReason, canonicalString, isCommandPath } from './signing.js';
import type { SecureSigner } from './signer.js';

/**
 * The signed HTTP client.
 *
 * Three behaviours here are load-bearing, and all three exist because this is a
 * trading client rather than a CRUD app:
 *
 * 1. **The intent id is generated once, by the caller, and survives retries.**
 *    A retry of the same human decision must carry the same id or the desk
 *    cannot deduplicate it (ADR-0006). The client therefore never generates one
 *    on the client's behalf inside a retry loop.
 *
 * 2. **Commands are never retried automatically.** A read that times out can be
 *    reissued freely. A command that times out has an unknown outcome, and
 *    reissuing it — even with the same intent id — is the operator's decision,
 *    not the network layer's.
 *
 * 3. **A timeout is reported as unknown, not as failure.** The UI needs the
 *    distinction to avoid telling the operator an order failed when it may be
 *    live.
 */

export interface ClientOptions {
  readonly baseUrl: string;
  readonly signer: SecureSigner;
  readonly deviceId: string;
  readonly hashBody: (body: string) => Promise<string>;
  readonly randomId: () => string;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export type ClientResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly title: string;
      readonly detail: string;
      readonly retryable: boolean;
      /**
       * The request may or may not have taken effect. The UI must not render
       * this as a failure.
       */
      readonly outcomeUnknown: boolean;
    };

export class DeskClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: ClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Reads are safe to retry, so they are, with a small bounded schedule. */
  async get<T>(path: string, attempts = 3): Promise<ClientResult<T>> {
    let last: ClientResult<T> | undefined;
    for (let i = 0; i < attempts; i++) {
      last = await this.request<T>('GET', path);
      if (last.ok) return last;
      if (!last.retryable) return last;
      await sleep(200 * 2 ** i);
    }
    return last as ClientResult<T>;
  }

  /**
   * Commands are sent exactly once.
   *
   * The absence of a retry loop is the feature. If this returns
   * `outcomeUnknown`, the desk is already resolving it and the app shows the
   * order as UNKNOWN; a second send would be a second human decision and must
   * be made by the human.
   */
  async command<T>(path: string, body: unknown, summary?: string): Promise<ClientResult<T>> {
    return this.request<T>('POST', path, body, summary);
  }

  /** A preview has no side effects, so it is an ordinary read. */
  async preview<T>(body: unknown): Promise<ClientResult<T>> {
    return this.request<T>('POST', '/preview', body);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    summary?: string,
  ): Promise<ClientResult<T>> {
    const text = body === undefined ? '' : JSON.stringify(body);
    const needsCommandNonce = isCommandPath(path);

    let commandNonce: string | undefined;
    if (needsCommandNonce) {
      const nonceRes = await this.request<{ nonce: string }>('GET', '/command-nonce');
      if (!nonceRes.ok) {
        return {
          ok: false,
          status: nonceRes.status,
          code: 'NO_COMMAND_NONCE',
          title: 'Could not reach the desk',
          detail: `The desk did not issue an authorisation nonce: ${nonceRes.detail}`,
          retryable: true,
          // Nothing was sent, so the outcome is not unknown — it is "did not
          // happen". Getting this right is what lets the UI say so plainly.
          outcomeUnknown: false,
        };
      }
      commandNonce = nonceRes.data.nonce;
    }

    const parts = {
      method,
      path,
      timestamp: this.now(),
      nonce: this.opts.randomId(),
      bodyHash: await this.opts.hashBody(text),
      ...(commandNonce !== undefined ? { commandNonce } : {}),
    };

    let signature: string;
    try {
      signature = await this.opts.signer.sign(
        canonicalString(parts),
        biometricReason(path, summary),
        needsCommandNonce,
      );
    } catch (err) {
      return {
        ok: false,
        status: 0,
        code: 'NOT_AUTHORISED',
        title: 'Not authorised',
        detail: err instanceof Error ? err.message : String(err),
        retryable: false,
        outcomeUnknown: false,
      };
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-keel-device': this.opts.deviceId,
      'x-keel-timestamp': String(parts.timestamp),
      'x-keel-nonce': parts.nonce,
      'x-keel-signature': signature,
    };
    if (commandNonce !== undefined) headers['x-keel-command-nonce'] = commandNonce;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15_000);
    try {
      const res = await this.fetchFn(`${this.opts.baseUrl}${path}`, {
        method,
        headers,
        signal: controller.signal,
        ...(body === undefined ? {} : { body: text }),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) return { ok: true, status: res.status, data: json as T };
      return {
        ok: false,
        status: res.status,
        code: (json.code as string) ?? `HTTP_${res.status}`,
        title: (json.title as string) ?? 'The desk refused this request',
        detail: (json.detail as string) ?? `HTTP ${res.status}`,
        retryable: (json.retryable as boolean) ?? res.status >= 500,
        outcomeUnknown: (json.outcomeUnknown as boolean) ?? false,
      };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      // A command that timed out may well have been executed. Saying "failed"
      // here is the single most dangerous thing this client could do.
      const wasCommand = needsCommandNonce;
      return {
        ok: false,
        status: 0,
        code: aborted ? 'TIMEOUT' : 'NETWORK',
        title: wasCommand ? 'Outcome unknown' : 'Could not reach the desk',
        detail: wasCommand
          ? 'The request did not complete. It may or may not have reached the broker. ' +
            'The desk is resolving it — do not resend.'
          : err instanceof Error
            ? err.message
            : String(err),
        retryable: !wasCommand,
        outcomeUnknown: wasCommand,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
