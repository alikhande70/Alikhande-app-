import * as D from '@keel/core';
import WebSocket from 'ws';
import { request } from 'undici';
import type { Clock } from '../sim/clock.js';
import type { Bar, MarketDataEvent, MarketDataProvider, Tick, Timeframe } from './port.js';
import { isCrossed } from './port.js';

/**
 * Crypto.com public market data — the reference plane's live implementation.
 *
 * Chosen because it needs no credentials, which makes it the one data path that
 * can be genuinely verified end to end rather than only simulated. It is the
 * reference plane only: nothing here ever prices an order.
 *
 * Protocol facts confirmed against the live service, not taken from docs:
 *
 * - REST prices are **strings** (`"78720.1"`), so they parse straight into `Dec`
 *   with no float in the path. This is the whole reason to prefer a venue that
 *   quotes as text.
 * - Ticker fields are single letters: `i` instrument, `b` bid, `k` ask,
 *   `a` last, `t` venue timestamp in ms, `v` 24h volume.
 * - The socket sends `public/heartbeat` and expects `public/respond-heartbeat`
 *   with the same id, or it closes the connection.
 * - Subscribing immediately after `open` is rejected; the service wants roughly
 *   a second first.
 */

const REST_BASE = 'https://api.crypto.com/exchange/v1';
const WS_URL = 'wss://stream.crypto.com/exchange/v1/market';
/** The service asks for a pause between connect and the first request. */
const SUBSCRIBE_DELAY_MS = 1_200;

const TIMEFRAME_MAP: Readonly<Record<Timeframe, string>> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1D',
};

interface TickerRow {
  i?: string;
  b?: string;
  k?: string;
  a?: string;
  t?: number;
}

interface CandleRow {
  o?: string;
  h?: string;
  l?: string;
  c?: string;
  v?: string;
  t?: number;
}

export interface CryptoComOptions {
  readonly clock: Clock;
  /** Maps this venue's instrument names to canonical ids, e.g. BTCUSD-PERP -> BTCUSD. */
  readonly canonicalOf?: (venueSymbol: string) => string;
  readonly venueSymbolOf?: (canonical: string) => string;
  readonly requestTimeoutMs?: number;
  readonly maxReconnectDelayMs?: number;
  /** Injected for tests; defaults to a real socket. */
  readonly socketFactory?: (url: string) => WebSocketLike;
}

/** The slice of the WebSocket API this adapter uses, so tests can substitute one. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'message' | 'close' | 'error', fn: (arg?: unknown) => void): void;
}

export class CryptoComProvider implements MarketDataProvider {
  readonly name = 'crypto.com';
  readonly plane = 'reference' as const;

  private ws: WebSocketLike | undefined;
  private connected = false;
  private closing = false;
  private reconnectAttempt = 0;
  private readonly handlers = new Set<(e: MarketDataEvent) => void>();
  private readonly subscriptions = new Set<string>();
  private nextId = 1;
  private cancelReconnect: (() => void) | undefined;

  constructor(private readonly opts: CryptoComOptions) {}

  // --- Symbol mapping -------------------------------------------------------

  private canonical(venueSymbol: string): string {
    if (this.opts.canonicalOf !== undefined) return this.opts.canonicalOf(venueSymbol);
    // BTCUSD-PERP -> BTCUSD, BTC_USDT -> BTCUSDT
    return venueSymbol.replace(/-PERP$/, '').replace(/_/g, '');
  }

  private venueSymbol(canonical: string): string {
    if (this.opts.venueSymbolOf !== undefined) return this.opts.venueSymbolOf(canonical);
    return `${canonical}-PERP`;
  }

  // --- Lifecycle ------------------------------------------------------------

  isConnected(): boolean {
    return this.connected;
  }

  on(handler: (e: MarketDataEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(e: MarketDataEvent): void {
    for (const h of this.handlers) {
      // A throwing handler must never take the feed down with it.
      try {
        h(e);
      } catch {
        /* deliberately swallowed: a consumer's bug is not a feed failure */
      }
    }
  }

  async connect(): Promise<void> {
    this.closing = false;
    await this.openSocket();
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve) => {
      const factory = this.opts.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
      let settled = false;
      let ws: WebSocketLike;
      try {
        ws = factory(WS_URL);
      } catch (err) {
        this.emit({
          type: 'error',
          at: this.opts.clock.now(),
          detail: `could not create socket: ${errText(err)}`,
          fatal: false,
        });
        this.scheduleReconnect();
        resolve();
        return;
      }
      this.ws = ws;

      ws.on('open', () => {
        this.connected = true;
        this.reconnectAttempt = 0;
        this.emit({ type: 'connected', at: this.opts.clock.now() });
        // The service rejects a subscribe sent immediately after open.
        this.opts.clock.setTimeout(() => {
          void this.replaySubscriptions();
        }, SUBSCRIBE_DELAY_MS);
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on('message', (raw) => {
        this.onMessage(String(raw));
      });

      ws.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        if (wasConnected) {
          this.emit({
            type: 'disconnected',
            at: this.opts.clock.now(),
            reason: 'socket closed',
          });
        }
        if (!this.closing) this.scheduleReconnect();
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on('error', (err) => {
        this.emit({
          type: 'error',
          at: this.opts.clock.now(),
          detail: errText(err),
          fatal: false,
        });
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  }

  /**
   * Reconnect with exponential backoff and jitter.
   *
   * Jitter matters even for a single client: without it, a provider outage
   * produces a synchronised retry storm across every client that was connected,
   * which is what turns a brief outage into a long one.
   */
  private scheduleReconnect(): void {
    if (this.closing) return;
    this.cancelReconnect?.();
    const attempt = Math.min(this.reconnectAttempt++, 8);
    const base = Math.min(this.opts.maxReconnectDelayMs ?? 30_000, 500 * 2 ** attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    this.cancelReconnect = this.opts.clock.setTimeout(() => {
      void this.openSocket();
    }, delay);
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.cancelReconnect?.();
    this.cancelReconnect = undefined;
    this.connected = false;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = undefined;
  }

  // --- Subscriptions --------------------------------------------------------

  async subscribe(canonicals: readonly string[]): Promise<void> {
    for (const c of canonicals) this.subscriptions.add(c);
    if (this.connected) await this.replaySubscriptions();
  }

  async unsubscribe(canonicals: readonly string[]): Promise<void> {
    const channels = canonicals.map((c) => `ticker.${this.venueSymbol(c)}`);
    for (const c of canonicals) this.subscriptions.delete(c);
    if (!this.connected || channels.length === 0) return;
    this.send({ id: this.nextId++, method: 'unsubscribe', params: { channels }, nonce: this.opts.clock.now() });
  }

  /**
   * Re-send every subscription.
   *
   * Called after each (re)connect. A reconnect that does not replay leaves a
   * socket that is open, healthy-looking, and silent — which is exactly the
   * failure the staleness budget exists to catch, but it should not happen in
   * the first place.
   */
  private async replaySubscriptions(): Promise<void> {
    if (this.subscriptions.size === 0) return;
    const channels = [...this.subscriptions].map((c) => `ticker.${this.venueSymbol(c)}`);
    this.send({ id: this.nextId++, method: 'subscribe', params: { channels }, nonce: this.opts.clock.now() });
  }

  private send(payload: unknown): void {
    try {
      this.ws?.send(JSON.stringify(payload));
    } catch (err) {
      this.emit({ type: 'error', at: this.opts.clock.now(), detail: `send failed: ${errText(err)}`, fatal: false });
    }
  }

  // --- Messages -------------------------------------------------------------

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.emit({
        type: 'error',
        at: this.opts.clock.now(),
        detail: 'unparseable frame',
        fatal: false,
      });
      return;
    }

    // The heartbeat is not optional: no response, and the service disconnects.
    if (msg.method === 'public/heartbeat') {
      this.send({ id: msg.id, method: 'public/respond-heartbeat' });
      return;
    }

    const result = msg.result as Record<string, unknown> | undefined;
    if (result === undefined) return;
    if (result.channel !== 'ticker') return;

    const rows = result.data;
    if (!Array.isArray(rows)) return;
    for (const row of rows as TickerRow[]) {
      const tick = this.toTick(row, result.instrument_name as string | undefined);
      if (tick !== undefined) this.emit({ type: 'tick', tick });
    }
  }

  private toTick(row: TickerRow, fallbackSymbol: string | undefined): Tick | undefined {
    const symbol = row.i ?? fallbackSymbol;
    if (symbol === undefined || row.b === undefined || row.k === undefined) return undefined;
    let bid: D.Dec;
    let ask: D.Dec;
    let last: D.Dec | undefined;
    try {
      bid = D.dec(row.b);
      ask = D.dec(row.k);
      last = row.a === undefined ? undefined : D.dec(row.a);
    } catch {
      // A price we cannot parse exactly is a price we will not use. Dropping it
      // is correct: the staleness budget will notice if they all stop parsing.
      return undefined;
    }
    const tick: Tick = {
      canonical: this.canonical(symbol),
      bid,
      ask,
      asOf: row.t ?? this.opts.clock.now(),
      plane: this.plane,
      origin: this.name,
      ...(last !== undefined ? { last } : {}),
    };
    // A crossed book is impossible and would produce a negative stop distance
    // downstream. Refuse it here rather than let it reach sizing.
    if (isCrossed(tick)) return undefined;
    return tick;
  }

  // --- REST -----------------------------------------------------------------

  async getBars(canonical: string, timeframe: Timeframe, limit: number): Promise<readonly Bar[]> {
    const symbol = this.venueSymbol(canonical);
    const url =
      `${REST_BASE}/public/get-candlestick?instrument_name=${encodeURIComponent(symbol)}` +
      `&timeframe=${TIMEFRAME_MAP[timeframe]}&count=${Math.min(limit, 1000)}`;
    const body = await this.getJson(url);
    const rows = ((body.result as Record<string, unknown> | undefined)?.data ?? []) as CandleRow[];
    const bars: Bar[] = [];
    for (const r of rows) {
      if (r.o === undefined || r.h === undefined || r.l === undefined || r.c === undefined) continue;
      try {
        bars.push({
          t: r.t ?? 0,
          o: D.dec(r.o),
          h: D.dec(r.h),
          l: D.dec(r.l),
          c: D.dec(r.c),
          v: D.dec(r.v ?? '0'),
        });
      } catch {
        /* skip a row we cannot parse exactly rather than approximate it */
      }
    }
    return bars.sort((a, b) => a.t - b.t);
  }

  /** Instrument names the venue currently trades. */
  async getInstrumentNames(): Promise<readonly string[]> {
    const body = await this.getJson(`${REST_BASE}/public/get-instruments`);
    const rows = ((body.result as Record<string, unknown> | undefined)?.data ?? []) as Array<{
      symbol?: string;
      tradable?: boolean;
    }>;
    return rows.filter((r) => r.tradable !== false && r.symbol !== undefined).map((r) => r.symbol as string);
  }

  /** A one-shot ticker read, used to prime state before the socket delivers. */
  async getTicker(canonical: string): Promise<Tick | undefined> {
    const symbol = this.venueSymbol(canonical);
    const body = await this.getJson(
      `${REST_BASE}/public/get-tickers?instrument_name=${encodeURIComponent(symbol)}`,
    );
    const rows = ((body.result as Record<string, unknown> | undefined)?.data ?? []) as TickerRow[];
    const first = rows[0];
    return first === undefined ? undefined : this.toTick(first, symbol);
  }

  private async getJson(url: string): Promise<Record<string, unknown>> {
    const res = await request(url, {
      method: 'GET',
      headersTimeout: this.opts.requestTimeoutMs ?? 10_000,
      bodyTimeout: this.opts.requestTimeoutMs ?? 10_000,
    });
    if (res.statusCode >= 400) {
      throw new Error(`crypto.com ${url} returned HTTP ${res.statusCode}`);
    }
    const body = (await res.body.json()) as Record<string, unknown>;
    if (typeof body.code === 'number' && body.code !== 0) {
      throw new Error(`crypto.com ${url} returned code ${body.code}`);
    }
    return body;
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
