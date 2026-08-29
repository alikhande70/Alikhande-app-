import { describe, expect, it } from 'vitest';
import type { LedgerEvent } from './events.js';
import { Ledger } from './ledger.js';
import { Projector } from './projections.js';

function makeLedger(): Ledger {
  return new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 1_000 });
}

const intent = (id: string, qty = '0.20'): LedgerEvent => ({
  kind: 'intent.created',
  intent: {
    intentId: id,
    canonical: 'XAUUSD',
    symbol: 'XAUUSD',
    side: 'buy',
    kind: 'market',
    timeInForce: 'GTC',
    volume: qty,
    attachedStop: '2395.00',
    riskAccount: '100.00',
    preTradeNote: 'London open continuation',
    tags: [],
    clientOrderId: `keel-${id}`,
  },
  risk: { verdict: 'pass', checks: [], policyVersion: 1, evaluatedAt: 1_000 },
});

describe('append-only guarantees', () => {
  it('assigns contiguous sequences and chains hashes', () => {
    const l = makeLedger();
    const a = l.append(intent('i1'));
    const b = l.append({
      kind: 'order.event',
      intentId: 'i1',
      event: { type: 'submit.started', at: 1 },
    });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(b.prevHash).toBe(a.hash);
    expect(l.head.seq).toBe(2);
    l.close();
  });

  it('verifies a clean chain', () => {
    const l = makeLedger();
    for (let i = 0; i < 20; i++) l.append(intent(`i${i}`));
    const v = l.verifyChain();
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.rows).toBe(20);
    l.close();
  });

  it('detects a modified row', () => {
    const l = makeLedger();
    l.append(intent('i1'));
    l.append(intent('i2'));
    // Simulate someone editing history directly in the database file.
    l.db
      .prepare(
        "UPDATE ledger SET payload = json_set(payload, '$.intent.volume', '99.00') WHERE seq = 1",
      )
      .run();
    const v = l.verifyChain();
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.failedAt).toBe(1);
    expect(v.reason).toMatch(/modified after it was written/);
    l.close();
  });

  it('detects a deleted row', () => {
    const l = makeLedger();
    l.append(intent('i1'));
    l.append(intent('i2'));
    l.append(intent('i3'));
    l.db.prepare('DELETE FROM ledger WHERE seq = 2').run();
    const v = l.verifyChain();
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toMatch(/a row was deleted/);
    l.close();
  });

  it('appends a batch atomically', () => {
    const l = makeLedger();
    const rows = l.appendAll([intent('i1'), intent('i2'), intent('i3')]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(l.verifyChain().ok).toBe(true);
    l.close();
  });

  it('reads a single aggregate stream in order', () => {
    const l = makeLedger();
    l.append(intent('i1'));
    l.append(intent('i2'));
    l.append({ kind: 'order.event', intentId: 'i1', event: { type: 'submit.started', at: 2 } });
    const stream = l.readStream('i1');
    expect(stream).toHaveLength(2);
    expect(stream.map((r) => r.kind)).toEqual(['intent.created', 'order.event']);
    l.close();
  });

  it('persists locked-holdout access in one dedicated durable stream', () => {
    const l = makeLedger();
    l.append({
      kind: 'evaluation.holdoutOpened',
      holdoutId: 'holdout-q3',
      questionId: 'challenger-a',
      openedAt: 300,
      evaluationCutoff: 290,
      populationHash: `sha256:${'a'.repeat(64)}`,
    });
    const stream = l.readStream('evaluation:holdout:holdout-q3:challenger-a');
    expect(stream).toHaveLength(1);
    expect(stream[0]?.kind).toBe('evaluation.holdoutOpened');
    expect(Ledger.isDurable('evaluation.holdoutOpened')).toBe(true);
    expect(l.verifyChain().ok).toBe(true);
    l.close();
  });

  it('marks the order path as durable', () => {
    expect(Ledger.isDurable('intent.created')).toBe(true);
    expect(Ledger.isDurable('order.event')).toBe(true);
    expect(Ledger.isDurable('guard.lockout')).toBe(true);
    expect(Ledger.isDurable('reconcile.completed')).toBe(false);
  });
});

describe('projections', () => {
  it('builds an order projection from intent plus events', () => {
    const l = makeLedger();
    const p = new Projector(l);
    l.append(intent('i1', '1.00'));
    l.append({ kind: 'order.event', intentId: 'i1', event: { type: 'submit.started', at: 2 } });
    l.append({
      kind: 'order.event',
      intentId: 'i1',
      event: { type: 'submit.acked', at: 3, venueOrderId: 'V1' },
    });
    l.append({
      kind: 'order.event',
      intentId: 'i1',
      event: { type: 'fill', at: 4, fillId: 'F1', qty: '0.40', price: '2400.00' },
    });
    p.catchUp();

    const row = l.db.prepare('SELECT * FROM orders WHERE intent_id = ?').get('i1') as Record<
      string,
      unknown
    >;
    expect(row.state).toBe('PARTIALLY_FILLED');
    expect(row.venue_order_id).toBe('V1');
    expect(row.filled_qty).toBe('0.40');
    l.close();
  });

  it('is a pure function of the ledger — a rebuild reproduces it exactly', () => {
    const l = makeLedger();
    const p = new Projector(l);
    l.append(intent('i1', '1.00'));
    l.append({ kind: 'order.event', intentId: 'i1', event: { type: 'submit.started', at: 2 } });
    l.append({
      kind: 'order.event',
      intentId: 'i1',
      event: { type: 'submit.acked', at: 3, venueOrderId: 'V1' },
    });
    l.append({
      kind: 'account.observed',
      currency: 'USD',
      balance: '10000.00',
      equity: '9950.00',
      marginUsed: '240.00',
      marginFree: '9710.00',
      asOf: 5,
      source: 'broker',
    });
    p.catchUp();

    const check = p.verifyAgainstRebuild();
    expect(check.ok, check.ok ? '' : `${check.table}: ${check.detail}`).toBe(true);

    // And the live state survived the verification.
    const row = l.db.prepare('SELECT * FROM orders WHERE intent_id = ?').get('i1') as Record<
      string,
      unknown
    >;
    expect(row.state).toBe('WORKING');
    l.close();
  });

  it('notices state written without an event behind it', () => {
    const l = makeLedger();
    const p = new Projector(l);
    l.append(intent('i1'));
    p.catchUp();
    // Something wrote to a projection without a ledger fact — the exact failure
    // that would make the ledger non-authoritative.
    l.db
      .prepare(
        `INSERT INTO positions (position_id, canonical, symbol, side, volume, entry_price, opened_at, as_of)
         VALUES ('ghost', 'XAUUSD', 'XAUUSD', 'buy', '1.00', '2400.00', 1, 1)`,
      )
      .run();
    const check = p.verifyAgainstRebuild();
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.table).toBe('positions');
    l.close();
  });

  it('catchUp is idempotent', () => {
    const l = makeLedger();
    const p = new Projector(l);
    l.append(intent('i1'));
    expect(p.catchUp()).toBe(1);
    expect(p.catchUp()).toBe(0);
    expect(p.watermark).toBe(1);
    l.close();
  });

  it('survives a restart: projections resume from the watermark', () => {
    const l = makeLedger();
    const p = new Projector(l);
    l.append(intent('i1'));
    p.catchUp();
    // A second projector over the same ledger sees the watermark and does nothing.
    const p2 = new Projector(l);
    expect(p2.watermark).toBe(1);
    expect(p2.catchUp()).toBe(0);
    l.close();
  });
});

describe('ledger payloads are JSON-safe by construction', () => {
  it('refuses a Dec value with an explanation rather than a bigint error', () => {
    const l = makeLedger();
    expect(() =>
      l.append({
        kind: 'order.event',
        intentId: 'i1',
        // @ts-expect-error deliberately passing a domain Dec where a wire string belongs
        event: { type: 'fill', at: 1, fillId: 'F', qty: { v: 40n, s: 2 }, price: { v: 1n, s: 0 } },
      }),
    ).toThrow(/decimal strings, never Dec values/);
    l.close();
  });

  it('keeps the chain intact after a rejected append', () => {
    const l = makeLedger();
    l.append(intent('i1'));
    try {
      l.append({
        kind: 'order.event',
        intentId: 'i1',
        // @ts-expect-error deliberately invalid
        event: { type: 'fill', at: 1, fillId: 'F', qty: { v: 40n, s: 2 }, price: { v: 1n, s: 0 } },
      });
    } catch {
      /* expected */
    }
    l.append(intent('i2'));
    expect(l.verifyChain().ok).toBe(true);
    expect(l.head.seq).toBe(2);
    l.close();
  });
});

describe('recovery after an unclean stop', () => {
  it('an intent written before a crash is still there, in PENDING_SUBMIT', () => {
    // The scenario: intent fsynced, process killed before the broker call.
    const l = makeLedger();
    const p = new Projector(l);
    l.append(intent('i-crash'));
    p.catchUp();

    // "Restart": new projector over the same store.
    const p2 = new Projector(l);
    p2.catchUp();
    const rec = p2.loadOrderRecord('i-crash');
    expect(rec?.state).toBe('PENDING_SUBMIT');
    // Which is exactly what boot recovery needs in order to ask the broker
    // whether it ever arrived.
    l.close();
  });
});
