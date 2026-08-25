import { describe, expect, it } from 'vitest';
import * as D from '../money/decimal.js';
import type { DrawdownConfig, DrawdownState } from './drawdown.js';
import { initialDrawdownState, maxLossBeforeBreach, updateDrawdown } from './drawdown.js';

const d = D.dec;
const DAY = 86_400_000;
// Monday 15 June 2026 14:00 UTC.
const T0 = Date.UTC(2026, 5, 15, 14, 0);

function config(over: Partial<DrawdownConfig> = {}): DrawdownConfig {
  return {
    model: { kind: 'trailing-eod', amount: d('600.00') },
    basis: 'balance',
    lockAtStartingBalance: false,
    startingBalance: d('10000.00'),
    breachAction: 'soft',
    warnAtRemainingFraction: d('0.25'),
    dayBoundaryTimeZone: 'America/New_York',
    dayBoundaryLocalTime: '17:00',
    ...over,
  };
}

function feed(
  cfg: DrawdownConfig,
  points: Array<{ balance: string; equity?: string; at: number }>,
): { state: DrawdownState; readings: ReturnType<typeof updateDrawdown>[] } {
  let state = initialDrawdownState(cfg, points[0]?.at ?? T0);
  const readings: ReturnType<typeof updateDrawdown>[] = [];
  for (const p of points) {
    const r = updateDrawdown(state, cfg, {
      balance: d(p.balance),
      equity: d(p.equity ?? p.balance),
      at: p.at,
    });
    readings.push(r);
    state = r.state;
  }
  return { state, readings };
}

describe('static drawdown', () => {
  const cfg = config({ model: { kind: 'static', amount: d('600.00') } });

  it('keeps the floor fixed however much the account grows', () => {
    const { state } = feed(cfg, [
      { balance: '10000.00', at: T0 },
      { balance: '12000.00', at: T0 + DAY },
      { balance: '11000.00', at: T0 + 2 * DAY },
    ]);
    expect(D.toString(state.floor)).toBe('9400.00');
  });

  it('breaches only below the fixed floor', () => {
    const { readings } = feed(cfg, [
      { balance: '9401.00', at: T0 },
      { balance: '9399.00', at: T0 + 1000 },
    ]);
    expect(readings[0]?.status).not.toBe('breached');
    expect(readings[1]?.status).toBe('breached');
    expect(readings[1]?.justBreached).toBe(true);
  });
});

describe('intraday trailing drawdown', () => {
  const cfg = config({ model: { kind: 'trailing-intraday', amount: d('600.00') } });

  it('moves the floor up on every new high, within the same day', () => {
    const { state } = feed(cfg, [
      { balance: '10000.00', at: T0 },
      { balance: '10500.00', at: T0 + 60_000 },
    ]);
    expect(D.toString(state.floor)).toBe('9900.00');
  });

  it('is materially harsher than the end-of-day model on the same path', () => {
    // Spike up intraday, then give it back — the classic case the two models
    // disagree about.
    const path = [
      { balance: '10000.00', at: T0 },
      { balance: '10500.00', at: T0 + 60_000 },
      { balance: '10000.00', at: T0 + 120_000 },
    ];
    const intraday = feed(cfg, path).state;
    const eod = feed(config(), path).state;
    expect(D.toString(intraday.floor)).toBe('9900.00');
    expect(D.toString(eod.floor)).toBe('9400.00');
    expect(D.lt(eod.floor, intraday.floor)).toBe(true);
  });
});

describe('end-of-day trailing drawdown', () => {
  const cfg = config();

  it('ignores an intraday spike that is given back before the close', () => {
    const { state } = feed(cfg, [
      { balance: '10000.00', at: T0 },
      { balance: '10800.00', at: T0 + 3_600_000 },
      { balance: '10000.00', at: T0 + 7_200_000 },
    ]);
    expect(D.toString(state.floor)).toBe('9400.00');
  });

  it('locks in the day high once the day boundary passes', () => {
    // Day boundary is 17:00 New York = 21:00 UTC in June.
    const { state } = feed(cfg, [
      { balance: '10000.00', at: T0 },
      { balance: '10800.00', at: Date.UTC(2026, 5, 15, 20, 0) }, // before the close
      { balance: '10400.00', at: Date.UTC(2026, 5, 15, 22, 0) }, // after the close
    ]);
    expect(D.toString(state.highWater)).toBe('10800.00');
    expect(D.toString(state.floor)).toBe('10200.00');
  });
});

describe('equity versus balance basis', () => {
  it('equity basis consumes buffer on floating losses; balance basis does not', () => {
    // 500 of floating loss on an untouched closed balance.
    const points = [{ balance: '10000.00', equity: '9500.00', at: T0 }];
    const onEquity = feed(config({ basis: 'equity' }), points).readings[0];
    const onBalance = feed(config({ basis: 'balance' }), points).readings[0];
    expect(D.toString(onEquity?.buffer as D.Dec)).toBe('100.00'); // 1/6 of the allowance left
    expect(D.toString(onBalance?.buffer as D.Dec)).toBe('600.00'); // untouched
    expect(onEquity?.status).toBe('warning');
    expect(onBalance?.status).toBe('ok');
  });

  it('an open loser can breach on equity basis while balance is untouched', () => {
    const points = [{ balance: '10000.00', equity: '9300.00', at: T0 }];
    expect(feed(config({ basis: 'equity' }), points).readings[0]?.status).toBe('breached');
    expect(feed(config({ basis: 'balance' }), points).readings[0]?.status).toBe('ok');
  });
});

describe('lock at starting balance', () => {
  it('stops trailing once the floor reaches the starting balance', () => {
    const cfg = config({
      model: { kind: 'trailing-intraday', amount: d('600.00') },
      lockAtStartingBalance: true,
    });
    const { state } = feed(cfg, [
      { balance: '10000.00', at: T0 },
      { balance: '11500.00', at: T0 + 60_000 },
    ]);
    // Unlocked this would be 10,900. Locked, it stops at the starting balance.
    expect(D.toString(state.floor)).toBe('10000.00');
  });
});

describe('breach behaviour', () => {
  const cfg = config();

  it('reports justBreached exactly once', () => {
    const { readings } = feed(cfg, [
      { balance: '10000.00', at: T0 },
      { balance: '9300.00', at: T0 + 1000 },
      { balance: '9200.00', at: T0 + 2000 },
    ]);
    expect(readings.map((r) => r.justBreached)).toEqual([false, true, false]);
    expect(readings.map((r) => r.status)).toEqual(['ok', 'breached', 'breached']);
  });

  it('does not clear a breach when the account recovers', () => {
    // Recovering above the floor does not un-breach an account. Clearing a
    // breach is an operator decision recorded in the ledger, not arithmetic.
    const { readings } = feed(cfg, [
      { balance: '9300.00', at: T0 },
      { balance: '9900.00', at: T0 + 1000 },
    ]);
    expect(readings[1]?.status).toBe('breached');
  });

  it('records when the breach happened', () => {
    const { state } = feed(cfg, [
      { balance: '10000.00', at: T0 },
      { balance: '9300.00', at: T0 + 5000 },
      { balance: '9100.00', at: T0 + 9000 },
    ]);
    expect(state.breachedAt).toBe(T0 + 5000);
  });
});

describe('warnings and headroom', () => {
  it('warns inside the configured fraction of the buffer', () => {
    const cfg = config({ warnAtRemainingFraction: d('0.25') });
    const { readings } = feed(cfg, [
      { balance: '9600.00', at: T0 }, // 200 left of 600 = 0.33 -> ok
      { balance: '9550.00', at: T0 + 1000 }, // 150 left = 0.25 -> warning
    ]);
    expect(readings[0]?.status).toBe('ok');
    expect(readings[1]?.status).toBe('warning');
  });

  it('exposes the largest loss that will not breach', () => {
    const { readings } = feed(config(), [{ balance: '9700.00', at: T0 }]);
    expect(D.toString(maxLossBeforeBreach(readings[0] as never))).toBe('300.00');
  });

  it('explains itself in words the operator can act on', () => {
    const { readings } = feed(config({ basis: 'equity' }), [
      { balance: '10000.00', equity: '9700.00', at: T0 },
    ]);
    const text = readings[0]?.explain ?? '';
    expect(text).toMatch(/300.00 of buffer left/);
    expect(text).toMatch(/includes floating P&L/);
    expect(text).toMatch(/floor trails the daily close/);
  });
});

describe('no model configured', () => {
  it('is inert rather than accidentally restrictive', () => {
    const { readings } = feed(config({ model: { kind: 'none' } }), [{ balance: '1.00', at: T0 }]);
    expect(readings[0]?.status).toBe('not-applicable');
    expect(readings[0]?.justBreached).toBe(false);
  });
});
