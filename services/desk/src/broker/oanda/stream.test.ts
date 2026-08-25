import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { Clock } from '../../sim/clock.js';
import type { OandaHttpRequest, OandaHttpResponse } from './client.js';
import { OandaClient } from './client.js';
import type { StreamChunkSource } from './stream.js';
import { backoffMs, OandaStreams, splitLines } from './stream.js';
import type { OandaTransaction } from './types.js';

const log = pino({ level: 'silent' });

const clock: Clock = {
  now: () => 1_000,
  sleep: async () => {},
  setTimeout: () => () => {},
  setInterval: () => () => {},
};

function clientWith(transport: (req: OandaHttpRequest) => Promise<OandaHttpResponse>): OandaClient {
  return new OandaClient({
    token: 't',
    accountId: 'acct',
    environment: 'practice',
    transport,
  });
}

/** A source that plays one scripted connection, then parks forever. */
function scriptedSource(chunks: readonly string[]): StreamChunkSource {
  let attempt = 0;
  return async () => {
    attempt += 1;
    if (attempt > 1) return new Promise<AsyncIterable<string>>(() => {}) as never;
    return (async function* () {
      for (const c of chunks) yield c;
    })();
  };
}

/** A source whose behaviour differs per connection attempt. */
function sourcePerAttempt(attempts: readonly (readonly string[] | 'park')[]): StreamChunkSource {
  let n = 0;
  return async () => {
    const behaviour = attempts[n] ?? 'park';
    n += 1;
    if (behaviour === 'park') return new Promise<AsyncIterable<string>>(() => {}) as never;
    return (async function* () {
      for (const c of behaviour) yield c;
    })();
  };
}

/** Wait for the microtask/timer queue to drain so background loops progress. */
const settle = () => new Promise((r) => setImmediate(r));

describe('splitLines', () => {
  it('carries a partial line across a chunk boundary', () => {
    // The bug this prevents: a chunk that ends mid-object gets parsed, throws,
    // and the transaction inside it is lost.
    const first = splitLines('', '{"a":1}\n{"b":');
    expect(first.lines).toEqual(['{"a":1}']);
    expect(first.rest).toBe('{"b":');

    const second = splitLines(first.rest, '2}\n');
    expect(second.lines).toEqual(['{"b":2}']);
    expect(second.rest).toBe('');
  });

  it('emits nothing for a chunk with no newline yet', () => {
    const r = splitLines('', '{"partial"');
    expect(r.lines).toEqual([]);
    expect(r.rest).toBe('{"partial"');
  });

  it('drops blank lines that the stream uses as filler', () => {
    const r = splitLines('', '\n\n{"a":1}\n\n');
    expect(r.lines).toEqual(['{"a":1}']);
  });

  it('handles a whole object arriving one character at a time', () => {
    let carry = '';
    const out: string[] = [];
    for (const ch of '{"id":"7"}\n') {
      const r = splitLines(carry, ch);
      carry = r.rest;
      out.push(...r.lines);
    }
    expect(out).toEqual(['{"id":"7"}']);
  });
});

describe('backoff', () => {
  it('grows exponentially and then caps', () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    expect(backoffMs(50)).toBe(30_000);
  });
});

describe('transaction stream', () => {
  it('delivers transactions and skips heartbeats', async () => {
    const seen: OandaTransaction[] = [];
    const streams = new OandaStreams({
      client: clientWith(async () => ({ status: 200, body: '{"transactions":[]}' })),
      clock,
      log,
      instruments: [],
      lastTransactionId: '10',
      onTransaction: (tx) => seen.push(tx),
      onPrice: () => {},
      onDisconnected: () => {},
      onReconnected: () => {},
      source: scriptedSource([
        '{"type":"HEARTBEAT","time":"2026-06-15T14:00:00Z"}\n',
        '{"id":"11","type":"ORDER_FILL","time":"2026-06-15T14:00:01Z"}\n',
      ]),
    });

    streams.start();
    await settle();
    streams.stop();

    expect(seen.map((t) => t.id)).toEqual(['11']);
  });

  it('skips a line that will not parse instead of dropping the stream', async () => {
    const seen: OandaTransaction[] = [];
    const streams = new OandaStreams({
      client: clientWith(async () => ({ status: 200, body: '{"transactions":[]}' })),
      clock,
      log,
      instruments: [],
      lastTransactionId: '10',
      onTransaction: (tx) => seen.push(tx),
      onPrice: () => {},
      onDisconnected: () => {},
      onReconnected: () => {},
      source: scriptedSource(['not json\n{"id":"12","type":"ORDER_FILL"}\n']),
    });

    streams.start();
    await settle();
    streams.stop();

    expect(seen.map((t) => t.id)).toEqual(['12']);
  });

  it('survives a handler that throws', async () => {
    const seen: string[] = [];
    let first = true;
    const streams = new OandaStreams({
      client: clientWith(async () => ({ status: 200, body: '{"transactions":[]}' })),
      clock,
      log,
      instruments: [],
      lastTransactionId: '10',
      onTransaction: (tx) => {
        if (first) {
          first = false;
          throw new Error('handler blew up');
        }
        seen.push(tx.id);
      },
      onPrice: () => {},
      onDisconnected: () => {},
      onReconnected: () => {},
      source: scriptedSource(['{"id":"13"}\n{"id":"14"}\n']),
    });

    streams.start();
    await settle();
    streams.stop();

    expect(seen).toEqual(['14']);
  });

  it('replays transactions missed while the stream was down', async () => {
    // The property that matters: a stop hit during a reconnect must still
    // reach the desk. Without catch-up the fill is simply never seen.
    const seen: string[] = [];
    const calls: string[] = [];
    const streams = new OandaStreams({
      client: clientWith(async (req) => {
        calls.push(req.url);
        return {
          status: 200,
          body: JSON.stringify({
            transactions: [
              { id: '10', time: '2026-06-15T14:00:00Z' },
              { id: '11', type: 'ORDER_FILL', time: '2026-06-15T14:00:01Z' },
            ],
            lastTransactionID: '11',
          }),
        };
      }),
      clock,
      log,
      instruments: [],
      lastTransactionId: '10',
      onTransaction: (tx) => seen.push(tx.id),
      onPrice: () => {},
      onDisconnected: () => {},
      onReconnected: () => {},
      // First connection ends immediately, forcing a reconnect and catch-up.
      source: scriptedSource([]),
    });

    streams.start();
    await settle();
    await settle();
    streams.stop();

    expect(calls.some((u) => u.includes('/transactions/sinceid?id=10'))).toBe(true);
    // The anchor is not replayed; the transaction after it is.
    expect(seen).toEqual(['11']);
  });

  it('reports the gap rather than replaying everything when no anchor is known', async () => {
    const calls: string[] = [];
    const streams = new OandaStreams({
      client: clientWith(async (req) => {
        calls.push(req.url);
        return { status: 200, body: '{"transactions":[]}' };
      }),
      clock,
      log,
      instruments: [],
      onTransaction: () => {},
      onPrice: () => {},
      onDisconnected: () => {},
      onReconnected: () => {},
      source: scriptedSource([]),
    });

    streams.start();
    await settle();
    await settle();
    streams.stop();

    // No anchor means no sinceid call: asking for everything would re-apply
    // history that is already in the ledger.
    expect(calls.some((u) => u.includes('sinceid'))).toBe(false);
  });
});

describe('connection reporting', () => {
  it('does not announce a reconnection until the stream actually reopens', async () => {
    // Found in self-review: the first version announced "reconnected" after the
    // backoff sleep, before the new stream had opened. A desk that says it is
    // connected while it is not is the exact failure this system exists to
    // avoid.
    const events: string[] = [];
    const streams = new OandaStreams({
      client: clientWith(async () => ({ status: 200, body: '{"transactions":[]}' })),
      clock,
      log,
      instruments: [],
      lastTransactionId: '10',
      onTransaction: () => {},
      onPrice: () => {},
      onDisconnected: () => events.push('down'),
      onReconnected: () => events.push('up'),
      // Opens and ends, then never opens again.
      source: sourcePerAttempt([[], 'park']),
    });

    streams.start();
    await settle();
    await settle();
    streams.stop();

    expect(events).toEqual(['down']);
  });

  it('announces the reconnection once the stream is genuinely open again', async () => {
    const events: string[] = [];
    const streams = new OandaStreams({
      client: clientWith(async () => ({ status: 200, body: '{"transactions":[]}' })),
      clock,
      log,
      instruments: [],
      lastTransactionId: '10',
      onTransaction: () => {},
      onPrice: () => {},
      onDisconnected: () => events.push('down'),
      onReconnected: () => events.push('up'),
      source: sourcePerAttempt([[], ['{"id":"12"}\n'], 'park']),
    });

    streams.start();
    await settle();
    await settle();
    await settle();
    streams.stop();

    expect(events.slice(0, 2)).toEqual(['down', 'up']);
  });
});
