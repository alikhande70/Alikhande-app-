import { describe, expect, it } from 'vitest';
import * as D from '../money/decimal.js';
import { blocksTrading, reconcile, worstSeverity } from './reconcile.js';
import type { ReconcileInput } from './reconcile.js';

const d = D.dec;
const NOW = 1_800_000_000_000;

function input(over: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    localOrders: [],
    venueOrders: [],
    localPositions: [],
    venuePositions: [],
    now: NOW,
    settlementGraceMs: 5_000,
    moneyTolerance: d('0.01'),
    ...over,
  };
}

const kinds = (r: ReturnType<typeof reconcile>): string[] => r.divergences.map((x) => x.kind);

describe('a clean book', () => {
  it('says so, plainly', () => {
    const r = reconcile(input());
    expect(r.clean).toBe(true);
    expect(worstSeverity(r)).toBeUndefined();
  });

  it('does not flag an order that matches', () => {
    const r = reconcile(
      input({
        localOrders: [
          {
            intentId: 'i1',
            venueOrderId: 'V1',
            canonical: 'XAUUSD',
            state: 'WORKING',
            requestedQty: d('0.10'),
            filledQty: d('0.00'),
            lastEventAt: NOW - 60_000,
          },
        ],
        venueOrders: [
          {
            venueOrderId: 'V1',
            canonical: 'XAUUSD',
            state: 'WORKING',
            requestedQty: d('0.10'),
            filledQty: d('0.00'),
          },
        ],
      }),
    );
    expect(r.clean).toBe(true);
  });
});

describe('orders', () => {
  it('gives an in-flight order a grace period before calling it missing', () => {
    const justSent = {
      intentId: 'i1',
      canonical: 'XAUUSD',
      state: 'SUBMITTED' as const,
      requestedQty: d('0.10'),
      filledQty: d('0.00'),
      lastEventAt: NOW - 1_000,
    };
    expect(reconcile(input({ localOrders: [justSent] })).clean).toBe(true);
    const stale = { ...justSent, lastEventAt: NOW - 30_000 };
    expect(kinds(reconcile(input({ localOrders: [stale] })))).toContain('ORDER_MISSING_AT_VENUE');
  });

  it('treats a missing UNKNOWN order as something to resolve, not to panic about', () => {
    const r = reconcile(
      input({
        localOrders: [
          {
            intentId: 'i1',
            canonical: 'XAUUSD',
            state: 'UNKNOWN',
            requestedQty: d('0.10'),
            filledQty: d('0.00'),
            lastEventAt: NOW - 30_000,
          },
        ],
      }),
    );
    expect(r.divergences[0]?.action).toBe('resolve-unknown');
    expect(r.divergences[0]?.severity).toBe('warning');
  });

  it('matches by client order id when the venue id is not yet known', () => {
    const r = reconcile(
      input({
        localOrders: [
          {
            intentId: 'i1',
            canonical: 'XAUUSD',
            state: 'UNKNOWN',
            requestedQty: d('0.10'),
            filledQty: d('0.00'),
            lastEventAt: NOW - 30_000,
          },
        ],
        venueOrders: [
          {
            venueOrderId: 'V9',
            clientOrderId: 'i1',
            canonical: 'XAUUSD',
            state: 'WORKING',
            requestedQty: d('0.10'),
            filledQty: d('0.00'),
          },
        ],
      }),
    );
    // Found it — so the divergence is a state mismatch to adopt, not a missing order.
    expect(kinds(r)).toEqual(['ORDER_STATE_MISMATCH']);
    expect(r.divergences[0]?.action).toBe('adopt-venue');
  });

  it('surfaces an order the venue holds that we never created', () => {
    const r = reconcile(
      input({
        venueOrders: [
          {
            venueOrderId: 'V2',
            canonical: 'EURUSD',
            state: 'WORKING',
            requestedQty: d('0.50'),
            filledQty: d('0.00'),
          },
        ],
      }),
    );
    expect(kinds(r)).toContain('ORDER_UNKNOWN_TO_US');
    expect(r.divergences[0]?.detail).toMatch(/broker terminal/);
  });

  it('flags a fill quantity disagreement as critical', () => {
    const r = reconcile(
      input({
        localOrders: [
          {
            intentId: 'i1',
            venueOrderId: 'V1',
            canonical: 'XAUUSD',
            state: 'PARTIALLY_FILLED',
            requestedQty: d('1.00'),
            filledQty: d('0.30'),
            lastEventAt: NOW - 60_000,
          },
        ],
        venueOrders: [
          {
            venueOrderId: 'V1',
            canonical: 'XAUUSD',
            state: 'PARTIALLY_FILLED',
            requestedQty: d('1.00'),
            filledQty: d('0.70'),
          },
        ],
      }),
    );
    expect(kinds(r)).toEqual(['ORDER_FILL_MISMATCH']);
    expect(r.divergences[0]?.severity).toBe('critical');
  });
});

describe('positions', () => {
  const localPos = {
    positionId: 'P1',
    canonical: 'XAUUSD',
    side: 'buy' as const,
    volume: d('0.20'),
    entryPrice: d('2400.00'),
    stopPrice: d('2395.00'),
  };

  it('flags a position the venue does not have', () => {
    const r = reconcile(input({ localPositions: [localPos] }));
    expect(kinds(r)).toContain('POSITION_MISSING_AT_VENUE');
    expect(r.divergences[0]?.action).toBe('alert-operator');
  });

  it('flags a manual position opened from the broker terminal', () => {
    const r = reconcile(
      input({ venuePositions: [{ ...localPos, positionId: 'P9', foreign: true }] }),
    );
    expect(kinds(r)).toContain('POSITION_UNKNOWN_TO_US');
    expect(r.divergences[0]?.detail).toMatch(/brings it under the risk rules/);
  });

  it('flags any position without a stop, however it was opened', () => {
    const naked = { ...localPos, stopPrice: undefined };
    const r = reconcile(input({ localPositions: [naked], venuePositions: [naked] }));
    const unprotected = r.divergences.find((x) => x.kind === 'POSITION_UNPROTECTED');
    expect(unprotected?.severity).toBe('critical');
    expect(unprotected?.action).toBe('attach-stop');
    expect(unprotected?.detail).toMatch(/unbounded/);
  });

  it('flags a size disagreement', () => {
    const r = reconcile(
      input({
        localPositions: [localPos],
        venuePositions: [{ ...localPos, volume: d('0.40') }],
      }),
    );
    expect(kinds(r)).toContain('POSITION_SIZE_MISMATCH');
  });

  it('flags a direction disagreement — the worst kind of mismatch', () => {
    const r = reconcile(
      input({
        localPositions: [localPos],
        venuePositions: [{ ...localPos, side: 'sell' }],
      }),
    );
    const dv = r.divergences.find((x) => x.kind === 'POSITION_SIDE_MISMATCH');
    expect(dv?.severity).toBe('critical');
  });

  it('flags a protective order with no position behind it', () => {
    const r = reconcile(
      input({
        venueOrders: [
          {
            venueOrderId: 'V5',
            clientOrderId: 'sl-i1',
            canonical: 'XAUUSD',
            state: 'WORKING',
            requestedQty: d('0.20'),
            filledQty: d('0.00'),
          },
        ],
      }),
    );
    const dv = r.divergences.find((x) => x.kind === 'ORPHANED_PROTECTIVE_ORDER');
    expect(dv?.action).toBe('cancel-orphan');
    expect(dv?.detail).toMatch(/open a new position rather than close one/);
  });

  it('does not call a stop orphaned while its position is open', () => {
    const r = reconcile(
      input({
        venuePositions: [localPos],
        venueOrders: [
          {
            venueOrderId: 'V5',
            clientOrderId: 'sl-i1',
            canonical: 'XAUUSD',
            state: 'WORKING',
            requestedQty: d('0.20'),
            filledQty: d('0.00'),
          },
        ],
      }),
    );
    expect(kinds(r)).not.toContain('ORPHANED_PROTECTIVE_ORDER');
  });
});

describe('account', () => {
  it('ignores differences inside the rounding tolerance', () => {
    const r = reconcile(
      input({
        localAccount: { balance: d('10000.00'), equity: d('9999.99'), marginUsed: d('0.00') },
        venueAccount: { balance: d('10000.00'), equity: d('10000.00'), marginUsed: d('0.00') },
      }),
    );
    expect(r.clean).toBe(true);
  });

  it('flags a real balance disagreement', () => {
    const r = reconcile(
      input({
        localAccount: { balance: d('10000.00'), equity: d('10000.00'), marginUsed: d('0.00') },
        venueAccount: { balance: d('9500.00'), equity: d('9500.00'), marginUsed: d('0.00') },
      }),
    );
    expect(kinds(r)).toEqual(['BALANCE_MISMATCH', 'EQUITY_MISMATCH']);
    expect(worstSeverity(r)).toBe('critical');
  });
});

describe('what stops trading', () => {
  it('an unprotected position and an unexplainable position both stop trading', () => {
    const r = reconcile(
      input({
        localPositions: [
          {
            positionId: 'P1',
            canonical: 'XAUUSD',
            side: 'buy',
            volume: d('0.20'),
            entryPrice: d('2400.00'),
          },
        ],
        venuePositions: [
          {
            positionId: 'P2',
            canonical: 'EURUSD',
            side: 'buy',
            volume: d('0.10'),
            entryPrice: d('1.08500'),
          },
        ],
      }),
    );
    const blocking = blocksTrading(r).map((x) => x.kind);
    expect(blocking).toContain('POSITION_MISSING_AT_VENUE');
    expect(blocking).toContain('POSITION_UNPROTECTED');
  });

  it('an adoptable foreign order does not stop trading on its own', () => {
    const r = reconcile(
      input({
        venueOrders: [
          {
            venueOrderId: 'V2',
            canonical: 'EURUSD',
            state: 'WORKING',
            requestedQty: d('0.50'),
            filledQty: d('0.00'),
          },
        ],
      }),
    );
    expect(blocksTrading(r)).toHaveLength(0);
    expect(r.clean).toBe(false);
  });
});
