import type { Logger } from 'pino';
import { request } from 'undici';
import type { Clock } from '../../sim/clock.js';
import type { OandaClient } from './client.js';
import { errorText } from './client.js';
import type { OandaClientPrice, OandaTransaction, OandaTransactionPage } from './types.js';

/**
 * The two v20 streams, and the reason a stream alone is not enough.
 *
 * OANDA pushes transactions and prices over long-lived chunked HTTP responses.
 * That works until it does not: a dropped connection loses every event that
 * occurs before the reconnect completes, and the events most likely to occur
 * during a network wobble are precisely the ones that matter — a stop being
 * hit, an order filling.
 *
 * So the transaction stream is paired with a catch-up: every reconnect replays
 * everything since the last transaction id actually seen. A stream without that
 * is a stream that silently drops fills, which would let the desk believe a
 * position is still open after the venue closed it.
 */

const HEARTBEAT_TYPES = new Set(['HEARTBEAT', 'PRICING_HEARTBEAT']);

/** Backoff between reconnects. Capped so a long outage still recovers promptly. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type StreamChunkSource = (req: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
}) => Promise<AsyncIterable<string>>;

export interface OandaStreamsOptions {
  readonly client: OandaClient;
  readonly clock: Clock;
  readonly log: Logger;
  readonly instruments: readonly string[];
  readonly lastTransactionId?: string;
  readonly onTransaction: (tx: OandaTransaction) => void;
  readonly onPrice: (price: OandaClientPrice) => void;
  readonly onDisconnected: (reason: string) => void;
  readonly onReconnected: () => void;
  /** Injected in tests so reconnect and catch-up can run without a network. */
  readonly source?: StreamChunkSource;
}

/**
 * Split a growing byte stream into complete JSON lines.
 *
 * Kept as a pure function with an explicit carry because this is where naive
 * stream parsers break: a chunk boundary lands mid-object, the partial line is
 * parsed, it throws, and the event is gone. The carry is returned rather than
 * hidden in a closure so a test can drive it one awkward split at a time.
 */
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const combined = buffer + chunk;
  const parts = combined.split('\n');
  // The final element is whatever came after the last newline — possibly a
  // complete line with no terminator yet, so it must be carried, not emitted.
  const rest = parts.pop() ?? '';
  return { lines: parts.map((l) => l.trim()).filter((l) => l !== ''), rest };
}

export class OandaStreams {
  private readonly controllers = new Set<AbortController>();
  private running = false;
  private lastTransactionId: string | undefined;
  private readonly source: StreamChunkSource;

  constructor(private readonly opts: OandaStreamsOptions) {
    this.lastTransactionId = opts.lastTransactionId;
    this.source = opts.source ?? undiciStreamSource;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.runTransactions();
    if (this.opts.instruments.length > 0) void this.runPricing();
  }

  stop(): void {
    this.running = false;
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
  }

  // --- Transactions ----------------------------------------------------------

  private async runTransactions(): Promise<void> {
    let attempt = 0;
    let reportedDown = false;

    while (this.running) {
      const url = `${this.opts.client.streamHost}${this.opts.client.accountPath('/transactions/stream')}`;

      const opened = await this.consume(
        url,
        (obj) => {
          const tx = obj as OandaTransaction;
          if (tx.id !== undefined) this.lastTransactionId = tx.id;
          this.opts.onTransaction(tx);
        },
        () => {
          attempt = 0;
          if (reportedDown) {
            reportedDown = false;
            this.opts.onReconnected();
          }
          // Catch up *while* the stream is live rather than before opening it.
          // Replaying the gap concurrently can only duplicate transactions —
          // which the fill dedupe already handles — whereas catching up first
          // leaves everything between the replay and the subscription unseen.
          void this.catchUp();
        },
      );

      if (!this.running) return;

      if (!reportedDown) {
        reportedDown = true;
        this.opts.onDisconnected(
          opened
            ? 'the OANDA transaction stream ended'
            : 'the OANDA transaction stream could not be opened',
        );
      }

      attempt += 1;
      await this.opts.clock.sleep(backoffMs(attempt));
    }
  }

  /**
   * Replay every transaction since the last one seen.
   *
   * Without a known id there is nothing to replay *from*, and asking for
   * everything would flood the ledger with historical fills that were already
   * accounted for. In that case the gap is reported rather than papered over.
   */
  private async catchUp(): Promise<void> {
    const since = this.lastTransactionId;
    if (since === undefined) {
      this.opts.log.warn(
        'reconnected with no last transaction id, so no catch-up is possible; ' +
          'reconciliation will have to establish what happened during the gap',
      );
      return;
    }

    const res = await this.opts.client.get<OandaTransactionPage>(
      `${this.opts.client.accountPath('/transactions/sinceid')}?id=${encodeURIComponent(since)}`,
    );
    if (!res.ok) {
      this.opts.log.warn(
        { reason: res.certainty === 'indeterminate' ? res.reason : res.errorMessage },
        'transaction catch-up failed; reconciliation must cover the gap',
      );
      return;
    }

    let replayed = 0;
    for (const tx of res.data.transactions) {
      // sinceid is inclusive of the anchor on some paths; skipping it here
      // keeps the fill dedupe in the state machine from having to.
      if (tx.id === since) continue;
      this.lastTransactionId = tx.id;
      this.opts.onTransaction(tx);
      replayed += 1;
    }
    if (replayed > 0) this.opts.log.info({ replayed, since }, 'replayed missed transactions');
  }

  // --- Pricing ---------------------------------------------------------------

  private async runPricing(): Promise<void> {
    let attempt = 0;
    while (this.running) {
      const instruments = this.opts.instruments.map((i) => encodeURIComponent(i)).join('%2C');
      const url =
        `${this.opts.client.streamHost}${this.opts.client.accountPath('/pricing/stream')}` +
        `?instruments=${instruments}`;

      await this.consume(
        url,
        (obj) => {
          const price = obj as OandaClientPrice;
          if (price.instrument !== undefined && price.time !== undefined) this.opts.onPrice(price);
        },
        () => {
          attempt = 0;
        },
      );

      if (!this.running) return;
      attempt += 1;
      await this.opts.clock.sleep(backoffMs(attempt));
    }
  }

  // --- Shared consumption ----------------------------------------------------

  /**
   * Read one NDJSON stream to its end. Returns whether it ever opened.
   *
   * A line that will not parse is logged and skipped rather than killing the
   * stream: one malformed frame should not cost every subsequent fill.
   */
  private async consume(
    url: string,
    onObject: (obj: unknown) => void,
    onOpen: () => void,
  ): Promise<boolean> {
    const controller = new AbortController();
    this.controllers.add(controller);
    let carry = '';
    try {
      const chunks = await this.source({
        url,
        headers: this.opts.client.headers(),
        signal: controller.signal,
      });
      // The stream is open only once the source has resolved without throwing.
      // Announcing it any earlier would report a connection that does not exist.
      onOpen();
      for await (const chunk of chunks) {
        if (!this.running) break;
        const { lines, rest } = splitLines(carry, chunk);
        carry = rest;
        for (const line of lines) {
          let obj: unknown;
          try {
            obj = JSON.parse(line);
          } catch {
            this.opts.log.warn({ line: line.slice(0, 200) }, 'unparseable line on OANDA stream');
            continue;
          }
          const type = (obj as { type?: unknown }).type;
          if (typeof type === 'string' && HEARTBEAT_TYPES.has(type)) continue;
          try {
            onObject(obj);
          } catch (err) {
            // A handler that throws must not take the stream down with it.
            this.opts.log.error({ reason: errorText(err) }, 'stream handler threw');
          }
        }
      }
      return true;
    } catch (err) {
      if (this.running) {
        this.opts.log.warn({ url, reason: errorText(err) }, 'OANDA stream failed');
      }
      return false;
    } finally {
      this.controllers.delete(controller);
    }
  }
}

/** Exponential backoff with a ceiling. */
export function backoffMs(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

const undiciStreamSource: StreamChunkSource = async (req) => {
  const res = await request(req.url, {
    method: 'GET',
    headers: req.headers,
    signal: req.signal,
    // No body timeout: a healthy stream is mostly silent between heartbeats,
    // and a body timeout would tear it down every five seconds.
    headersTimeout: 30_000,
  });
  if (res.statusCode >= 400) {
    const body = await res.body.text();
    throw new Error(`stream returned HTTP ${res.statusCode}: ${body.slice(0, 200)}`);
  }
  return toStringChunks(res.body);
};

async function* toStringChunks(body: AsyncIterable<unknown>): AsyncIterable<string> {
  for await (const chunk of body) {
    yield typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
  }
}
