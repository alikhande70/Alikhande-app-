import { beforeEach, describe, expect, it } from 'vitest';
import { canTrade, dataAgeMs, needsAttention, unprotectedPositions, useDeskStore } from './desk.js';
import type { DeskHealth, DeskStoreState, Order, Position } from './desk.js';

/**
 * The store's job is to never claim more than it can prove. These tests are
 * mostly about what it *refuses* to do.
 */

const T0 = 1_800_000_000_000;

function health(over: Partial<DeskHealth> = {}): DeskHealth {
  return {
    brokerConnected: true,
    brokerName: 'paper',
    referenceFeedConnected: true,
    openDivergences: 0,
    criticalDivergences: 0,
    unresolvedOrders: 0,
    undeliveredCriticalAlerts: 0,
    credentialsLocked: false,
    deskStartedAt: T0,
    version: '0.1.0',
    ...over,
  };
}

function order(over: Partial<Order> = {}): Order {
  return {
    intentId: 'i1',
    canonical: 'XAUUSD',
    side: 'buy',
    kind: 'market',
    requestedQty: '0.10',
    filledQty: '0.10',
    state: 'FILLED',
    certainty: 'confirmed',
    certaintyText: 'Confirmed by the broker.',
    resolutionAttempts: 0,
    createdAt: T0,
    lastEventAt: T0,
    ...over,
  };
}

type PositionOverride = { [K in keyof Position]?: Position[K] | undefined };

function position(over: PositionOverride = {}): Position {
  const merged: Record<string, unknown> = {
    positionId: 'p1',
    canonical: 'XAUUSD',
    symbol: 'XAUUSD',
    side: 'buy',
    volume: '0.10',
    entryPrice: '2400.00',
    stopPrice: '2395.00',
    openedAt: T0,
    foreign: false,
    provenance: { source: 'broker', asOf: T0 },
    ...over,
  };
  // `exactOptionalPropertyTypes` distinguishes "absent" from "present and
  // undefined", and so does the app: a position with no stop has no key, which
  // is what the wire actually carries.
  for (const k of Object.keys(merged)) {
    if (merged[k] === undefined) delete merged[k];
  }
  return merged as unknown as Position;
}

beforeEach(() => {
  useDeskStore.getState().reset();
});

describe('applying updates', () => {
  it('records a topic as complete after a snapshot', () => {
    useDeskStore.getState().applySnapshot('positions', 4, [position()], T0);
    const s = useDeskStore.getState();
    expect(s.positions).toHaveLength(1);
    expect(s.topics.positions).toEqual({ status: 'complete', seq: 4, confirmedAt: T0 });
  });

  it('merges a delta by id and honours removals', () => {
    const store = useDeskStore.getState();
    store.applySnapshot('positions', 1, [position({ positionId: 'a' }), position({ positionId: 'b' })], T0);
    useDeskStore.getState().applyDelta('positions', 2, [position({ positionId: 'c' })], ['a'], T0 + 1);
    const ids = useDeskStore.getState().positions.map((p) => p.positionId);
    expect(ids.sort()).toEqual(['b', 'c']);
  });

  it('refuses a delta on a topic it never snapshotted', () => {
    // The socket layer should prevent this; the store refuses independently
    // rather than trusting it, because applying a delta with no base silently
    // produces a partial list that looks complete.
    useDeskStore.getState().applyDelta('orders', 5, [order()], [], T0);
    const s = useDeskStore.getState();
    expect(s.orders).toHaveLength(0);
    expect(s.topics.orders?.status).toBe('incomplete');
  });
});

describe('losing the socket changes what we can claim, not what we know', () => {
  it('keeps the data but marks every loaded topic incomplete', () => {
    const store = useDeskStore.getState();
    store.applySnapshot('positions', 1, [position()], T0);
    store.applySnapshot('health', 1, health(), T0);
    useDeskStore.getState().setConnection('disconnected', 'socket closed');

    const s = useDeskStore.getState();
    // The positions are still there — they are the last thing we knew.
    expect(s.positions).toHaveLength(1);
    // But nothing claims they are current.
    expect(s.topics.positions?.status).toBe('incomplete');
    expect(s.topics.health?.status).toBe('incomplete');
  });

  it('does not promote a never-loaded topic to incomplete', () => {
    useDeskStore.getState().setConnection('disconnected');
    expect(useDeskStore.getState().topics.positions).toBeUndefined();
  });
});

describe('canTrade is conservative and explains itself', () => {
  function ready(): DeskStoreState {
    const store = useDeskStore.getState();
    store.setConnection('connected');
    store.applySnapshot('health', 1, health(), T0);
    return useDeskStore.getState();
  }

  it('allows trading when everything is proven', () => {
    expect(canTrade(ready())).toEqual({ ok: true });
  });

  it('refuses while disconnected', () => {
    const s = ready();
    useDeskStore.getState().setConnection('disconnected');
    const r = canTrade(useDeskStore.getState());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Not connected/);
    expect(s.connection).toBeDefined();
  });

  it('refuses when the broker is down, and names it', () => {
    useDeskStore.getState().setConnection('connected');
    useDeskStore.getState().applySnapshot('health', 1, health({ brokerConnected: false, brokerName: 'oanda' }), T0);
    const r = canTrade(useDeskStore.getState());
    expect(r.reason).toMatch(/oanda is disconnected/);
  });

  it('refuses during a lockout, quoting the reason', () => {
    useDeskStore.getState().setConnection('connected');
    useDeskStore
      .getState()
      .applySnapshot('health', 1, health({ lockout: { until: T0 + 1000, reason: 'daily loss limit' } }), T0);
    expect(canTrade(useDeskStore.getState()).reason).toMatch(/daily loss limit/);
  });

  it('refuses while any topic is still resyncing', () => {
    ready();
    useDeskStore.getState().applySnapshot('positions', 1, [], T0);
    useDeskStore.getState().noteGap('positions', 2, 9, T0);
    const r = canTrade(useDeskStore.getState());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/resyncing positions/);
  });

  it('refuses while any order has an unknown outcome', () => {
    useDeskStore.getState().setConnection('connected');
    useDeskStore.getState().applySnapshot('health', 1, health({ unresolvedOrders: 1 }), T0);
    const r = canTrade(useDeskStore.getState());
    expect(r.reason).toMatch(/unknown outcome/);
  });

  it('refuses after a drawdown breach', () => {
    ready();
    useDeskStore.getState().applySnapshot(
      'drawdown',
      1,
      { status: 'breached', buffer: '0', bufferFraction: '0', floor: '9400', highWater: '10000', explain: 'x' },
      T0,
    );
    expect(canTrade(useDeskStore.getState()).reason).toMatch(/Drawdown breached/);
  });
});

describe('what the operator is shown first', () => {
  it('ranks unknown orders above everything else', () => {
    useDeskStore.getState().applySnapshot(
      'orders',
      1,
      [
        order({ intentId: 'c', certainty: 'confirmed' }),
        order({ intentId: 'u', certainty: 'unknown', state: 'UNKNOWN' }),
        order({ intentId: 'f', certainty: 'in-flight', state: 'SUBMITTED' }),
      ],
      T0,
    );
    expect(needsAttention(useDeskStore.getState()).map((o) => o.intentId)).toEqual(['u', 'f']);
  });

  it('surfaces positions with no stop', () => {
    useDeskStore.getState().applySnapshot(
      'positions',
      1,
      [position({ positionId: 'safe' }), position({ positionId: 'naked', stopPrice: undefined })],
      T0,
    );
    expect(unprotectedPositions(useDeskStore.getState()).map((p) => p.positionId)).toEqual(['naked']);
  });
});

describe('data age uses the desk clock, not the phone', () => {
  it('corrects for a phone clock that is wrong', () => {
    const store = useDeskStore.getState();
    store.applySnapshot('positions', 1, [], T0);
    // The phone is 30 seconds behind the desk.
    store.setLatency(20, 30_000);

    // Naively, phone-now minus desk-confirmedAt would be negative and the data
    // would look like it came from the future.
    const age = dataAgeMs(useDeskStore.getState(), 'positions', T0 - 10_000);
    expect(age).toBe(20_000);
  });

  it('returns undefined for a topic never confirmed', () => {
    expect(dataAgeMs(useDeskStore.getState(), 'positions', T0)).toBeUndefined();
  });
});
