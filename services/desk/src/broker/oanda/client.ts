import { request } from 'undici';

/**
 * The v20 HTTP transport, and the classification of what its failures mean.
 *
 * This module exists to answer one question correctly: *did the venue act on
 * our request?* Every other part of the adapter depends on that answer, and the
 * cost of the two possible mistakes is wildly asymmetric.
 *
 * - Calling a real execution a rejection tells the operator they are flat when
 *   they are not. They then re-enter, and now hold double the intended risk.
 * - Calling a non-execution ambiguous costs a few seconds of resolver traffic
 *   before the venue confirms the order does not exist.
 *
 * So the rule is: only a response in which OANDA explicitly evaluated the
 * request and declined it counts as a rejection. Everything else — timeout,
 * socket reset, 5xx, rate limit, a 2xx body we cannot parse — is
 * `indeterminate`, and the caller must resolve it against the venue rather than
 * assume.
 */

export type OandaEnvironment = 'practice' | 'live';

const HOSTS: Record<OandaEnvironment, { rest: string; stream: string }> = {
  practice: {
    rest: 'https://api-fxpractice.oanda.com',
    stream: 'https://stream-fxpractice.oanda.com',
  },
  live: { rest: 'https://api-fxtrade.oanda.com', stream: 'https://stream-fxtrade.oanda.com' },
};

export interface OandaHttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs: number;
}

export interface OandaHttpResponse {
  readonly status: number;
  readonly body: string;
}

/** Injected so every failure branch below can be exercised without a network. */
export type OandaTransport = (req: OandaHttpRequest) => Promise<OandaHttpResponse>;

export type OandaResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  /** OANDA evaluated the request and declined it. Safe to treat as "did not happen". */
  | {
      readonly ok: false;
      readonly certainty: 'definite';
      readonly status: number;
      readonly errorCode?: string;
      readonly errorMessage: string;
      readonly data?: unknown;
    }
  /** We do not know whether it happened. Never collapse this into a rejection. */
  | { readonly ok: false; readonly certainty: 'indeterminate'; readonly reason: string };

/**
 * Status codes where OANDA has definitively not acted.
 *
 * 400 and 422 are validation failures — the request never reached execution.
 * 404 means the addressed order, trade or account does not exist. 401 and 403
 * are authentication and authorisation, both of which are decided before any
 * routing to the execution engine, so an order cannot have been placed.
 *
 * Deliberately absent: 408, 429 and every 5xx. A gateway timeout or a rate
 * limiter can sit in front of an engine that already accepted the order.
 */
const DEFINITE_STATUSES = new Set([400, 401, 403, 404, 405, 422]);

export interface OandaClientOptions {
  readonly token: string;
  readonly accountId: string;
  readonly environment: OandaEnvironment;
  readonly requestTimeoutMs?: number;
  readonly transport?: OandaTransport;
}

export class OandaClient {
  private readonly timeoutMs: number;
  private readonly transport: OandaTransport;

  constructor(private readonly opts: OandaClientOptions) {
    this.timeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.transport = opts.transport ?? undiciTransport;
  }

  get restHost(): string {
    return HOSTS[this.opts.environment].rest;
  }

  get streamHost(): string {
    return HOSTS[this.opts.environment].stream;
  }

  get accountId(): string {
    return this.opts.accountId;
  }

  get environment(): OandaEnvironment {
    return this.opts.environment;
  }

  /** Exposed so the stream module can authenticate with identical headers. */
  get requestTimeout(): number {
    return this.timeoutMs;
  }

  /**
   * Headers for every call.
   *
   * `Accept-Datetime-Format: RFC3339` is pinned rather than left to the account
   * default. The alternative, UNIX, returns fractional-second strings whose
   * meaning changes with the account setting — and a timestamp format that
   * depends on remote configuration is a parsing bug waiting for a bad day.
   */
  headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.token}`,
      'content-type': 'application/json',
      'accept-datetime-format': 'RFC3339',
    };
  }

  accountPath(suffix: string): string {
    return `/v3/accounts/${encodeURIComponent(this.opts.accountId)}${suffix}`;
  }

  async get<T>(path: string): Promise<OandaResult<T>> {
    return this.send<T>('GET', path);
  }

  async post<T>(path: string, body: unknown): Promise<OandaResult<T>> {
    return this.send<T>('POST', path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<OandaResult<T>> {
    return this.send<T>('PUT', path, body);
  }

  private async send<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<OandaResult<T>> {
    const req: OandaHttpRequest = {
      method,
      url: `${this.restHost}${path}`,
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };

    let res: OandaHttpResponse;
    try {
      res = await this.transport(req);
    } catch (err) {
      // Transport-level failure: DNS, TLS, connection reset, timeout. The
      // request may have been fully delivered and executed before the socket
      // died, so this is the canonical indeterminate case.
      return {
        ok: false,
        certainty: 'indeterminate',
        reason: `${method} ${path} failed at the transport: ${errorText(err)}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = res.body === '' ? {} : JSON.parse(res.body);
    } catch {
      // A body we cannot read tells us nothing about what the venue did with
      // the request — including on a 2xx, where the order may well have filled.
      return {
        ok: false,
        certainty: 'indeterminate',
        reason:
          `${method} ${path} returned HTTP ${res.status} with a body that is not JSON, so the ` +
          'outcome cannot be read from it',
      };
    }

    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, data: parsed as T };
    }

    const { errorCode, errorMessage } = readError(parsed, res.status);

    if (DEFINITE_STATUSES.has(res.status)) {
      return {
        ok: false,
        certainty: 'definite',
        status: res.status,
        errorMessage,
        data: parsed,
        ...(errorCode === undefined ? {} : { errorCode }),
      };
    }

    return {
      ok: false,
      certainty: 'indeterminate',
      reason:
        `${method} ${path} returned HTTP ${res.status} (${errorMessage}). This status does not ` +
        'establish whether the request was acted on.',
    };
  }
}

function readError(parsed: unknown, status: number): { errorCode?: string; errorMessage: string } {
  const obj = parsed as { errorCode?: unknown; errorMessage?: unknown } | null;
  const code = typeof obj?.errorCode === 'string' ? obj.errorCode : undefined;
  const message =
    typeof obj?.errorMessage === 'string'
      ? obj.errorMessage
      : `HTTP ${status} with no error message`;
  return code === undefined
    ? { errorMessage: message }
    : { errorCode: code, errorMessage: message };
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const undiciTransport: OandaTransport = async (req) => {
  const res = await request(req.url, {
    method: req.method,
    headers: req.headers,
    // Both timeouts are set. `headersTimeout` alone leaves a response that
    // begins and then stalls hanging until the process notices, which during
    // order submission is the worst possible place to block.
    headersTimeout: req.timeoutMs,
    bodyTimeout: req.timeoutMs,
    ...(req.body === undefined ? {} : { body: req.body }),
  });
  return { status: res.statusCode, body: await res.body.text() };
};
