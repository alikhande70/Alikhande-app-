import type {
  Mt5HostCancelRequest,
  Mt5HostCloseRequest,
  Mt5HostModifyRequest,
  Mt5HostOrderRequest,
  Mt5HostReconcileRequest,
  Mt5HostReconcileResponse,
  Mt5HostSnapshot,
  Mt5HostSubmitResult,
} from './host-types.js';
import { validateMt5HostReconcileResponse } from './reconcile-validation.js';

export interface Mt5HostHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export type Mt5HostRequest = (
  url: string,
  init: {
    readonly method: 'GET' | 'POST';
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<Mt5HostHttpResponse>;

async function defaultRequest(
  url: string,
  init: {
    readonly method: 'GET' | 'POST';
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
): Promise<Mt5HostHttpResponse> {
  const res = await fetch(url, init);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

export class Mt5HostError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = 'Mt5HostError';
  }
}

export interface Mt5HostClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly request?: Mt5HostRequest;
}

/**
 * Narrow HTTP client for the Windows execution host.
 *
 * The host is deliberately a separate process from the desktop UI. Closing the
 * UI must not tear down the MT5 execution authority or reconciliation loop.
 */
export class Mt5HostClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly requestFn: Mt5HostRequest;

  constructor(options: Mt5HostClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Mt5HostError('MT5 execution host URL must use http or https');
    }
    this.baseUrl = url.toString().replace(/\/$/, '');
    if (options.token.length < 16) {
      throw new Mt5HostError('MT5 execution host token must be at least 16 characters');
    }
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.requestFn = options.request ?? defaultRequest;
  }

  snapshot(): Promise<Mt5HostSnapshot> {
    return this.call<Mt5HostSnapshot>('GET', '/v1/snapshot');
  }

  placeOrder(request: Mt5HostOrderRequest): Promise<Mt5HostSubmitResult> {
    return this.call<Mt5HostSubmitResult>('POST', '/v1/orders/place', request);
  }

  cancelOrder(request: Mt5HostCancelRequest): Promise<Mt5HostSubmitResult> {
    return this.call<Mt5HostSubmitResult>('POST', '/v1/orders/cancel', request);
  }

  modifyPosition(request: Mt5HostModifyRequest): Promise<Mt5HostSubmitResult> {
    return this.call<Mt5HostSubmitResult>('POST', '/v1/positions/modify', request);
  }

  closePosition(request: Mt5HostCloseRequest): Promise<Mt5HostSubmitResult> {
    return this.call<Mt5HostSubmitResult>('POST', '/v1/positions/close', request);
  }

  async reconcile(request: Mt5HostReconcileRequest): Promise<Mt5HostReconcileResponse> {
    const raw = await this.call<unknown>('POST', '/v1/reconcile', request);
    try {
      return validateMt5HostReconcileResponse(raw);
    } catch (error) {
      throw new Mt5HostError(
        `MT5 execution host returned invalid reconcile evidence: ${
          error instanceof Error ? error.message : String(error)
        }`,
        200,
        raw,
      );
    }
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
    };
    let encoded: string | undefined;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      encoded = JSON.stringify(body);
    }

    let response: Mt5HostHttpResponse;
    try {
      response = await this.requestFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(encoded === undefined ? {} : { body: encoded }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Mt5HostError(
        `MT5 execution host request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Mt5HostError(
        `MT5 execution host returned HTTP ${response.status}`,
        response.status,
        response.body,
      );
    }
    if (
      response.body === undefined ||
      response.body === null ||
      typeof response.body !== 'object'
    ) {
      throw new Mt5HostError(
        'MT5 execution host returned an invalid JSON body',
        response.status,
        response.body,
      );
    }
    return response.body as T;
  }
}
