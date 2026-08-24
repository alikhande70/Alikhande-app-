import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as D from '../money/decimal.js';
import {
  CERTAINTY,
  applyOrderEvent,
  describeCertainty,
  effectiveCertainty,
  isTerminal,
  mayExistAtVenue,
  newOrderRecord,
  VENUE_FACTS,
} from './orderState.js';
import type { OrderEvent, OrderRecord, OrderState } from './orderState.js';

const d = D.dec;
const T = 1_000_000;

function fresh(qty = '1.00'): OrderRecord {
  return newOrderRecord('intent-1', d(qty), T);
}

/** Apply a sequence, asserting each step is accepted. Returns the final record. */
function drive(rec: OrderRecord, events: OrderEvent[]): OrderRecord {
  let cur = rec;
  for (const ev of events) {
    const r = applyOrderEvent(cur, ev);
    if (!r.ok) throw new Error(`unexpected refusal: ${r.refusal}`);
    cur = r.record;
  }
  return cur;
}

const started: OrderEvent = { type: 'submit.started', at: T + 1 };
const acked: OrderEvent = { type: 'submit.acked', at: T + 2, venueOrderId: 'V1' };

describe('the timeout rule — an ambiguous send is never a rejection', () => {
  it('moves to UNKNOWN, not REJECTED, on timeout', () => {
    const rec = drive(fresh(), [
      started,
      { type: 'submit.ambiguous', at: T + 2, reason: 'socket timeout after 5000ms' },
    ]);
    expect(rec.state).toBe('UNKNOWN');
    expect(CERTAINTY[rec.state]).toBe('unknown');
    expect(mayExistAtVenue(rec.state)).toBe(true);
    expect(isTerminal(rec.state)).toBe(false);
  });

  it('tells the operator not to resend while unknown', () => {
    const rec = drive(fresh(), [
      started,
      { type: 'submit.ambiguous', at: T + 2, reason: 'gateway 504' },
    ]);
    expect(describeCertainty(rec)).toMatch(/Do not resend/);
    expect(describeCertainty(rec)).toMatch(/gateway 504/);
  });

  it('resolves UNKNOWN to a filled order when the venue actually had it', () => {
    const rec = drive(fresh(), [
      started,
      { type: 'submit.ambiguous', at: T + 2, reason: 'timeout' },
      {
        type: 'resolution.found',
        at: T + 30,
        venueOrderId: 'V1',
        venueState: 'FILLED',
        filledQty: d('1.00'),
        avgPrice: d('2400.10'),
      },
    ]);
    expect(rec.state).toBe('FILLED');
    expect(D.toString(rec.filledQty)).toBe('1.00');
    expect(rec.resolutionAttempts).toBe(1);
  });

  it('resolves UNKNOWN to CONFIRMED_ABSENT only with positive evidence of absence', () => {
    const rec = drive(fresh(), [
      started,
      { type: 'submit.ambiguous', at: T + 2, reason: 'timeout' },
      {
        type: 'resolution.absent',
        at: T + 30,
        evidence: 'clientOrderId not present in venue order list for the last 24h',
      },
    ]);
    expect(rec.state).toBe('CONFIRMED_ABSENT');
    expect(isTerminal(rec.state)).toBe(true);
    expect(CERTAINTY[rec.state]).toBe('confirmed');
  });

  it('does not claim existence is unknown when a fill already proves it', () => {
    // A fill is proof the order reached the venue. After that, a comms failure
    // makes our knowledge stale, not the order's existence unknown.
    const rec = drive(fresh(), [
      started,
      { type: 'fill', at: T + 3, fillId: 'F1', qty: d('0.40'), price: d('2400.00') },
    ]);
    const r = applyOrderEvent(rec, {
      type: 'submit.ambiguous',
      at: T + 4,
      reason: 'connection reset',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.state).toBe('PARTIALLY_FILLED');
    expect(r.record.knowledgeStaleSince).toBe(T + 4);
    expect(r.anomalies[0]?.kind).toBe('KNOWLEDGE_STALE');
    // ...and that is not presented as confirmed.
    expect(effectiveCertainty(r.record)).toBe('in-flight');
  });

  it('refuses to conclude absence when local evidence contradicts it', () => {
    const rec = drive(fresh(), [
      started,
      { type: 'fill', at: T + 3, fillId: 'F1', qty: d('0.40'), price: d('2400.00') },
      { type: 'submit.ambiguous', at: T + 4, reason: 'connection reset' },
    ]);
    const r = applyOrderEvent(rec, {
      type: 'resolution.absent',
      at: T + 40,
      evidence: 'not found in venue order list',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.state).not.toBe('CONFIRMED_ABSENT');
    expect(r.anomalies[0]?.kind).toBe('CONTRADICTED_ABSENCE');
    expect(r.anomalies[0]?.severity).toBe('critical');
    expect(r.anomalies[0]?.detail).toMatch(/manual reconciliation required/);
  });

  it('a fill after CONFIRMED_ABSENT is applied, never lost', () => {
    // The defect this guards: concluding an order does not exist, then losing
    // the fill that proves it does — leaving live exposure invisible.
    const absent = drive(fresh(), [
      started,
      { type: 'submit.ambiguous', at: T + 2, reason: 'timeout' },
      { type: 'resolution.absent', at: T + 30, evidence: 'not found' },
    ]);
    expect(absent.state).toBe('CONFIRMED_ABSENT');
    const r = applyOrderEvent(absent, {
      type: 'fill',
      at: T + 45,
      fillId: 'F1',
      qty: d('1.00'),
      price: d('2400.00'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.state).toBe('FILLED');
    expect(D.toString(r.record.filledQty)).toBe('1.00');
    expect(r.anomalies[0]?.kind).toBe('PHANTOM_RESURRECTION');
    expect(r.anomalies[0]?.severity).toBe('critical');
  });
});

describe('acknowledgement is not execution', () => {
  it('an ack with no fills yields WORKING, not FILLED', () => {
    const rec = drive(fresh(), [started, acked]);
    expect(rec.state).toBe('WORKING');
    expect(D.isZero(rec.filledQty)).toBe(true);
  });

  it('SUBMITTED is in-flight, never confirmed', () => {
    const rec = drive(fresh(), [started]);
    expect(CERTAINTY[rec.state]).toBe('in-flight');
    expect(describeCertainty(rec)).toMatch(/do not assume it is live/i);
  });
});

describe('fills', () => {
  it('accumulates partial fills and computes a weighted average', () => {
    const rec = drive(fresh(), [
      started,
      acked,
      { type: 'fill', at: T + 3, fillId: 'F1', qty: d('0.40'), price: d('2400.00') },
      { type: 'fill', at: T + 4, fillId: 'F2', qty: d('0.60'), price: d('2401.00') },
    ]);
    expect(rec.state).toBe('FILLED');
    expect(D.toString(rec.filledQty)).toBe('1.00');
    // (0.4*2400 + 0.6*2401) / 1.0 = 2400.60
    expect(D.eq(rec.avgFillPrice as D.Dec, d('2400.60'))).toBe(true);
  });

  it('ignores a replayed fill id rather than double-counting', () => {
    const rec = drive(fresh(), [
      started,
      acked,
      { type: 'fill', at: T + 3, fillId: 'F1', qty: d('0.40'), price: d('2400.00') },
    ]);
    const r = applyOrderEvent(rec, {
      type: 'fill',
      at: T + 5,
      fillId: 'F1',
      qty: d('0.40'),
      price: d('2400.00'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(D.toString(r.record.filledQty)).toBe('0.40');
    expect(r.anomalies[0]?.kind).toBe('DUPLICATE_FILL');
  });

  it('flags an overfill loudly instead of clamping it', () => {
    const rec = drive(fresh(), [started, acked]);
    const r = applyOrderEvent(rec, {
      type: 'fill',
      at: T + 3,
      fillId: 'F1',
      qty: d('1.50'),
      price: d('2400.00'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.anomalies.some((a) => a.kind === 'OVERFILL')).toBe(true);
    // The quantity is kept as reported — the venue is authoritative about what
    // it filled, and silently clamping would hide real exposure.
    expect(D.toString(r.record.filledQty)).toBe('1.50');
  });

  it('applies a fill arriving after cancellation, and escalates it', () => {
    const rec = drive(fresh(), [
      started,
      acked,
      { type: 'cancel.requested', at: T + 3 },
      { type: 'cancel.acked', at: T + 4 },
    ]);
    expect(rec.state).toBe('CANCELLED');
    const r = applyOrderEvent(rec, {
      type: 'fill',
      at: T + 5,
      fillId: 'F9',
      qty: d('1.00'),
      price: d('2400.00'),
    });
    // Refusing this would lose a real position. The fill is applied and the
    // contradiction is escalated.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.state).toBe('FILLED');
    expect(r.anomalies[0]?.kind).toBe('FILL_AFTER_TERMINAL');
    expect(r.anomalies[0]?.severity).toBe('critical');
  });
});

describe('cancellation', () => {
  it('a rejected cancel returns the order to live, never to CANCELLED', () => {
    const rec = drive(fresh(), [
      started,
      acked,
      { type: 'cancel.requested', at: T + 3 },
      { type: 'cancel.rejected', at: T + 4, reason: 'order already in execution' },
    ]);
    expect(rec.state).toBe('WORKING');
    expect(rec.reason).toMatch(/already in execution/);
  });

  it('a rejected cancel on a partially filled order returns to PARTIALLY_FILLED', () => {
    const rec = drive(fresh(), [
      started,
      acked,
      { type: 'fill', at: T + 3, fillId: 'F1', qty: d('0.30'), price: d('2400.00') },
      { type: 'cancel.requested', at: T + 4 },
      { type: 'cancel.rejected', at: T + 5, reason: 'too late' },
    ]);
    expect(rec.state).toBe('PARTIALLY_FILLED');
  });

  it('a cancel that times out is never treated as a cancellation', () => {
    const rec = drive(fresh(), [
      started,
      acked,
      { type: 'cancel.requested', at: T + 3 },
      { type: 'submit.ambiguous', at: T + 4, reason: 'cancel request timed out' },
    ]);
    // The order is known to exist, so its state is retained; only our knowledge
    // is stale. What must never happen is showing it as CANCELLED.
    expect(rec.state).toBe('CANCEL_REQUESTED');
    expect(rec.knowledgeStaleSince).toBe(T + 4);
    expect(effectiveCertainty(rec)).not.toBe('confirmed');
  });
});

describe('reconciliation observations', () => {
  it('adopts venue fills that never arrived as events, and flags the gap', () => {
    const rec = drive(fresh(), [started, acked]);
    const r = applyOrderEvent(rec, {
      type: 'venue.observed',
      at: T + 60,
      venueState: 'FILLED',
      filledQty: d('1.00'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.state).toBe('FILLED');
    expect(r.anomalies.some((a) => a.detail.includes('never arrived as events'))).toBe(true);
  });

  it('never regresses filled quantity when the venue reports less', () => {
    const rec = drive(fresh(), [
      started,
      acked,
      { type: 'fill', at: T + 3, fillId: 'F1', qty: d('0.70'), price: d('2400.00') },
    ]);
    const r = applyOrderEvent(rec, {
      type: 'venue.observed',
      at: T + 60,
      venueState: 'WORKING',
      filledQty: d('0.20'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(D.toString(r.record.filledQty)).toBe('0.70');
    expect(r.record.state).toBe('PARTIALLY_FILLED');
    expect(r.anomalies[0]?.kind).toBe('REGRESSED_STATE');
  });

  it('adopts the venue view when it contradicts a terminal local state', () => {
    const rec = drive(fresh(), [
      started,
      { type: 'submit.rejected', at: T + 2, reason: 'insufficient margin' },
    ]);
    const r = applyOrderEvent(rec, {
      type: 'venue.observed',
      at: T + 60,
      venueState: 'WORKING',
      filledQty: d('0.00'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The venue is authoritative about its own book: if it says the order is
    // working, we have live exposure regardless of what we recorded.
    expect(r.record.state).toBe('WORKING');
    expect(r.anomalies[0]?.kind).toBe('UNSOLICITED_STATE');
    expect(r.anomalies[0]?.severity).toBe('critical');
  });

  it('discards an observation older than what we already know', () => {
    const rec = drive(fresh(), [
      started,
      acked,
      { type: 'cancel.requested', at: T + 10 },
      { type: 'cancel.acked', at: T + 11 },
    ]);
    // A poll that started before the cancel returns late.
    const r = applyOrderEvent(rec, {
      type: 'venue.observed',
      at: T + 5,
      venueState: 'WORKING',
      filledQty: d('0.00'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.state).toBe('CANCELLED');
    expect(r.anomalies[0]?.kind).toBe('STALE_OBSERVATION');
  });
});

describe('local commands are refused; venue facts never are', () => {
  const badCommands: Array<[OrderState, OrderEvent, string]> = [
    ['FAILED_LOCAL', started, 'resend a locally failed order'],
    ['CONFIRMED_ABSENT', started, 'reuse an intent proven absent'],
    ['CANCELLED', { type: 'cancel.requested', at: T }, 'cancel a cancelled order'],
    ['FILLED', { type: 'cancel.requested', at: T }, 'cancel a filled order'],
    ['WORKING', started, 'submit an order that is already working'],
  ];

  for (const [state, ev, label] of badCommands) {
    it(`refuses the local command: ${label}`, () => {
      const rec: OrderRecord = { ...fresh(), state };
      const r = applyOrderEvent(rec, ev);
      expect(r.ok).toBe(false);
    });
  }

  const venueFacts: OrderEvent[] = [
    acked,
    { type: 'fill', at: T + 9, fillId: 'F', qty: d('1.00'), price: d('2400.00') },
    { type: 'venue.observed', at: T + 9, venueState: 'FILLED', filledQty: d('1.00') },
    { type: 'submit.rejected', at: T + 9, reason: 'r' },
  ];

  it('a venue fact is never dropped, whatever we believed', () => {
    const believedDead: OrderState[] = ['FAILED_LOCAL', 'CONFIRMED_ABSENT', 'CANCELLED', 'REJECTED'];
    for (const state of believedDead) {
      for (const ev of venueFacts) {
        const rec: OrderRecord = { ...fresh(), state, lastEventAt: T };
        const r = applyOrderEvent(rec, ev);
        expect(r.ok, `${state} + ${ev.type} must be recorded, not refused`).toBe(true);
      }
    }
  });

  it('a fill for an order we never sent is applied and raises a critical anomaly', () => {
    const rec = drive(fresh(), [
      { type: 'submit.aborted', at: T + 1, reason: 'risk: daily loss limit reached' },
    ]);
    expect(rec.state).toBe('FAILED_LOCAL');
    expect(CERTAINTY[rec.state]).toBe('local');
    const r = applyOrderEvent(rec, {
      type: 'fill',
      at: T + 9,
      fillId: 'F',
      qty: d('1.00'),
      price: d('2400.00'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.state).toBe('FILLED');
    expect(r.anomalies.some((a) => a.severity === 'critical')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Properties that must hold for every reachable state, under any event order.
// ---------------------------------------------------------------------------

const arbEvent: fc.Arbitrary<OrderEvent> = fc.oneof(
  fc.constant<OrderEvent>({ type: 'submit.started', at: T }),
  fc.constant<OrderEvent>({ type: 'submit.acked', at: T, venueOrderId: 'V1' }),
  fc.constant<OrderEvent>({ type: 'submit.rejected', at: T, reason: 'r' }),
  fc.constant<OrderEvent>({ type: 'submit.ambiguous', at: T, reason: 'r' }),
  fc.constant<OrderEvent>({ type: 'submit.aborted', at: T, reason: 'r' }),
  fc.constant<OrderEvent>({ type: 'cancel.requested', at: T }),
  fc.constant<OrderEvent>({ type: 'cancel.acked', at: T }),
  fc.constant<OrderEvent>({ type: 'cancel.rejected', at: T, reason: 'r' }),
  fc.constant<OrderEvent>({ type: 'expired', at: T }),
  fc.constant<OrderEvent>({
    type: 'resolution.absent',
    at: T,
    evidence: 'e',
  }),
  fc
    .tuple(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 3 }))
    .map<OrderEvent>(([q, id]) => ({
      type: 'fill',
      at: T,
      fillId: `F${id}`,
      qty: D.div(D.dec(q), D.dec(4), 2, 'down'),
      price: D.dec('2400.00'),
    })),
  fc
    .tuple(
      fc.constantFrom<OrderState>('WORKING', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED'),
      fc.integer({ min: 0, max: 4 }),
    )
    .map<OrderEvent>(([s, q]) => ({
      type: 'venue.observed',
      at: T,
      venueState: s,
      filledQty: D.div(D.dec(q), D.dec(4), 2, 'down'),
    })),
);

describe('state machine invariants', () => {
  it('filled quantity is monotonically non-decreasing under every event sequence', () => {
    fc.assert(
      fc.property(fc.array(arbEvent, { maxLength: 30 }), (events) => {
        let rec = fresh();
        for (const ev of events) {
          const r = applyOrderEvent(rec, ev);
          if (!r.ok) continue;
          expect(D.gte(r.record.filledQty, rec.filledQty)).toBe(true);
          rec = r.record;
        }
      }),
    );
  });

  it('leaving a terminal state always raises a critical anomaly', () => {
    // Terminal states can be left — the venue may contradict us — but never
    // quietly. Every resurrection must be escalated.
    fc.assert(
      fc.property(fc.array(arbEvent, { maxLength: 30 }), (events) => {
        let rec = fresh();
        for (const ev of events) {
          const before = rec.state;
          const r = applyOrderEvent(rec, ev);
          if (!r.ok) continue;
          if (isTerminal(before) && r.record.state !== before) {
            expect(
              r.anomalies.some((a) => a.severity === 'critical'),
              `${before} -> ${r.record.state} via ${ev.type} must escalate`,
            ).toBe(true);
          }
          rec = r.record;
        }
      }),
    );
  });

  it('a terminal state is never left without a venue fact', () => {
    fc.assert(
      fc.property(fc.array(arbEvent, { maxLength: 30 }), (events) => {
        let rec = fresh();
        for (const ev of events) {
          const before = rec.state;
          const r = applyOrderEvent(rec, ev);
          if (!r.ok) continue;
          if (isTerminal(before) && r.record.state !== before) {
            expect(VENUE_FACTS.has(ev.type), `${ev.type} must be a venue fact`).toBe(true);
          }
          rec = r.record;
        }
      }),
    );
  });

  it('an applied fill id is never applied twice', () => {
    fc.assert(
      fc.property(fc.array(arbEvent, { maxLength: 40 }), (events) => {
        let rec = fresh('10.00');
        for (const ev of events) {
          const r = applyOrderEvent(rec, ev);
          if (!r.ok) continue;
          rec = r.record;
        }
        const unique = new Set(rec.appliedFillIds);
        expect(unique.size).toBe(rec.appliedFillIds.length);
      }),
    );
  });

  it('certainty is defined for every state and never claims more than the state supports', () => {
    const states: OrderState[] = [
      'PENDING_SUBMIT',
      'SUBMITTED',
      'UNKNOWN',
      'WORKING',
      'PARTIALLY_FILLED',
      'FILLED',
      'REJECTED',
      'CANCEL_REQUESTED',
      'CANCELLED',
      'EXPIRED',
      'CONFIRMED_ABSENT',
      'FAILED_LOCAL',
    ];
    for (const s of states) {
      expect(CERTAINTY[s]).toBeDefined();
      // Anything the venue has not confirmed must not read as confirmed.
      if (s === 'SUBMITTED' || s === 'UNKNOWN' || s === 'PENDING_SUBMIT') {
        expect(CERTAINTY[s]).not.toBe('confirmed');
      }
    }
  });
});
