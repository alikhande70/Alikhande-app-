import { describe, expect, it } from 'vitest';
import * as D from '../money/decimal.js';
import { XAUUSD } from '../testing/fixtures.js';
import type { DrawdownConfig, DrawdownReading } from './drawdown.js';
import { initialDrawdownState, updateDrawdown } from './drawdown.js';
import type { AccountSnapshot, RiskContext, RiskRequest } from './governor.js';
import { evaluate, summariseRiskDecision, UNWAIVABLE_RULES } from './governor.js';
import { defaultRiskPolicy } from './policy.js';

const d = D.dec;
// Monday 15 June 2026, 14:00 UTC — London/New York overlap, market open.
const NOW = Date.UTC(2026, 5, 15, 14, 0);

const account: AccountSnapshot = {
  currency: 'USD',
  balance: d('10000.00'),
  equity: d('10000.00'),
  marginUsed: d('0.00'),
  marginFree: d('10000.00'),
  asOf: NOW - 500,
  source: 'broker',
};

const ddConfig: DrawdownConfig = {
  model: { kind: 'trailing-eod', amount: d('600.00') },
  basis: 'balance',
  lockAtStartingBalance: true,
  startingBalance: d('10000.00'),
  breachAction: 'soft',
  warnAtRemainingFraction: d('0.25'),
  dayBoundaryTimeZone: 'America/New_York',
  dayBoundaryLocalTime: '17:00',
};

function healthyDrawdown(): DrawdownReading {
  return updateDrawdown(initialDrawdownState(ddConfig, NOW - 86_400_000), ddConfig, {
    balance: account.balance,
    equity: account.equity,
    at: NOW,
  });
}

function ctx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    policy: defaultRiskPolicy(),
    account,
    openPositions: [],
    day: { dayOpenBalance: d('10000.00'), tradesToday: 0, consecutiveLosses: 0 },
    drawdown: healthyDrawdown(),
    calendar: [],
    now: NOW,
    brokerConnected: true,
    ...over,
  };
}

function req(over: Partial<RiskRequest> = {}): RiskRequest {
  return {
    spec: XAUUSD,
    side: 'buy',
    volume: d('0.10'),
    riskAccount: d('50.00'), // 0.5% of 10k
    requestedRiskBudget: d('50.00'),
    marginRequiredAccount: d('240.00'),
    hasPreTradeNote: true,
    recentIdenticalIntents: [],
    ...over,
  };
}

const blockers = (c: ReturnType<typeof evaluate>): string[] =>
  c.checks.filter((x) => x.verdict === 'block').map((x) => x.rule);

describe('the happy path', () => {
  it('passes a well-formed trade inside every limit', () => {
    const r = evaluate(req(), ctx());
    expect(r.verdict, `unexpected blockers: ${blockers(r).join(', ')}`).toBe('pass');
    expect(summariseRiskDecision(r)).toBe('All risk checks passed.');
    expect(r.policyVersion).toBe(1);
  });

  it('reports every failing rule at once, not one at a time', () => {
    const r = evaluate(
      req({ riskAccount: d('500.00'), hasPreTradeNote: false, volume: d('9.00') }),
      ctx(),
    );
    expect(blockers(r).length).toBeGreaterThanOrEqual(3);
    expect(blockers(r)).toEqual(
      expect.arrayContaining(['per-trade-risk', 'pre-trade-note', 'instrument-volume-cap']),
    );
  });
});

describe('conditions under which nothing may be sent', () => {
  it('blocks with no broker connection', () => {
    const r = evaluate(req(), ctx({ brokerConnected: false }));
    expect(blockers(r)).toContain('broker-connection');
  });

  it('blocks when account figures did not come from the broker', () => {
    const r = evaluate(req(), ctx({ account: { ...account, source: 'derived' } }));
    expect(blockers(r)).toContain('account-truth');
  });

  it('blocks on stale account state', () => {
    const r = evaluate(req(), ctx({ account: { ...account, asOf: NOW - 120_000 } }));
    expect(blockers(r)).toContain('account-freshness');
  });

  it('blocks on a stale execution quote', () => {
    const r = evaluate(req({ quoteAsOf: NOW - 10_000 }), ctx());
    expect(blockers(r)).toContain('quote-freshness');
  });

  it('blocks during a guard lockout', () => {
    const r = evaluate(req(), ctx({ lockout: { until: NOW + 600_000, reason: 'daily loss' } }));
    expect(blockers(r)).toContain('lockout');
    expect(r.checks.find((c) => c.rule === 'lockout')?.message).toMatch(/10 min/);
  });
});

describe('sizing limits', () => {
  it('blocks a trade above the per-trade risk ceiling and reports the capped budget', () => {
    const r = evaluate(req({ riskAccount: d('250.00') }), ctx()); // 2.5% vs 1% cap
    expect(blockers(r)).toContain('per-trade-risk');
    expect(D.toString(r.cappedRiskBudget as D.Dec)).toBe('100.00'); // 1% of 10k
  });

  it('blocks when aggregate open risk would exceed the cap', () => {
    const r = evaluate(
      req({ riskAccount: d('100.00') }),
      ctx({
        openPositions: [
          { canonical: 'EURUSD', side: 'buy', volume: d('0.20'), riskAccount: d('90.00') },
          { canonical: 'USDJPY', side: 'sell', volume: d('0.20'), riskAccount: d('90.00') },
        ],
      }),
    );
    expect(blockers(r)).toContain('aggregate-open-risk');
  });

  it('refuses to compare against a cap when an open position has no stop', () => {
    const r = evaluate(
      req(),
      ctx({
        openPositions: [{ canonical: 'EURUSD', side: 'buy', volume: d('0.20') }],
      }),
    );
    const check = r.checks.find((c) => c.rule === 'aggregate-open-risk');
    expect(check?.verdict).toBe('block');
    expect(check?.message).toMatch(/unbounded/);
    expect(check?.message).toMatch(/EURUSD/);
  });

  it('treats correlated instruments as one bet', () => {
    // XAUUSD and EURUSD are both in the short-USD group, cap 1.5%.
    const r = evaluate(
      req({ riskAccount: d('90.00') }),
      ctx({
        openPositions: [
          { canonical: 'EURUSD', side: 'buy', volume: d('0.20'), riskAccount: d('90.00') },
        ],
      }),
    );
    expect(blockers(r)).toContain('correlation:usd-short');
    const msg = r.checks.find((c) => c.rule === 'correlation:usd-short')?.message;
    expect(msg).toMatch(/one correlated bet/);
  });
});

describe('the stop', () => {
  it('blocks an entry with no stop when the policy requires one', () => {
    const r = evaluate(req({ riskAccount: undefined }), ctx());
    expect(blockers(r)).toContain('stop-required');
    expect(r.checks.find((c) => c.rule === 'stop-required')?.message).toMatch(/unbounded/);
  });

  it('warns instead of blocking when the policy allows stopless entries', () => {
    const r = evaluate(
      req({ riskAccount: undefined }),
      ctx({ policy: defaultRiskPolicy({ requireStopLoss: false }) }),
    );
    expect(r.checks.find((c) => c.rule === 'stop-required')?.verdict).toBe('warn');
  });

  it('blocks without a pre-trade note', () => {
    expect(blockers(evaluate(req({ hasPreTradeNote: false }), ctx()))).toContain('pre-trade-note');
  });
});

describe('daily loss and drawdown', () => {
  it('blocks all entries once the daily loss limit is reached', () => {
    const r = evaluate(
      req(),
      ctx({
        account: { ...account, equity: d('9700.00') }, // -3%
        day: { dayOpenBalance: d('10000.00'), tradesToday: 1, consecutiveLosses: 1 },
      }),
    );
    expect(blockers(r)).toContain('daily-loss-limit');
  });

  it('warns as the daily loss approaches the limit', () => {
    const r = evaluate(
      req(),
      ctx({
        account: { ...account, equity: d('9760.00') }, // -2.4%, 80% of the 3% budget
        day: { dayOpenBalance: d('10000.00'), tradesToday: 1, consecutiveLosses: 0 },
      }),
    );
    expect(r.checks.find((c) => c.rule === 'daily-loss-limit')?.verdict).toBe('warn');
  });

  it('blocks a trade that risks more than the remaining drawdown buffer', () => {
    // Balance down to 9,500: floor is 9,400, so only 100 of buffer remains.
    const low = { ...account, balance: d('9500.00'), equity: d('9500.00') };
    const dd = updateDrawdown(initialDrawdownState(ddConfig, NOW - 86_400_000), ddConfig, {
      balance: low.balance,
      equity: low.equity,
      at: NOW,
    });
    const r = evaluate(
      req({ riskAccount: d('90.00') }),
      ctx({
        account: low,
        drawdown: dd,
        day: { dayOpenBalance: d('9500.00'), tradesToday: 0, consecutiveLosses: 0 },
      }),
    );
    expect(D.toString(dd.buffer)).toBe('100.00');
    expect(r.verdict).toBe('warn'); // 90 < 100 buffer, but inside the warning band
    expect(r.checks.find((c) => c.rule === 'drawdown')?.verdict).toBe('warn');

    const tooBig = evaluate(
      req({ riskAccount: d('150.00') }),
      ctx({
        account: low,
        drawdown: dd,
        day: { dayOpenBalance: d('9500.00'), tradesToday: 0, consecutiveLosses: 0 },
      }),
    );
    expect(blockers(tooBig)).toContain('drawdown-headroom');
    // Two caps bind here: 1% of 9,500 equity = 95, and the 100 of drawdown
    // buffer. The tighter one wins — caps compose by minimum, never by the
    // most recently evaluated rule.
    expect(D.toString(tooBig.cappedRiskBudget as D.Dec)).toBe('95.00');
    expect(tooBig.checks.find((c) => c.rule === 'drawdown-headroom')?.message).toMatch(
      /end the account, not just the day/,
    );
  });

  it('blocks everything once drawdown is breached', () => {
    const bust = { ...account, balance: d('9300.00'), equity: d('9300.00') };
    const dd = updateDrawdown(initialDrawdownState(ddConfig, NOW - 86_400_000), ddConfig, {
      balance: bust.balance,
      equity: bust.equity,
      at: NOW,
    });
    expect(dd.status).toBe('breached');
    const r = evaluate(
      req(),
      ctx({
        account: bust,
        drawdown: dd,
        day: { dayOpenBalance: d('9300.00'), tradesToday: 0, consecutiveLosses: 0 },
      }),
    );
    expect(blockers(r)).toContain('drawdown');
  });
});

describe('behavioural limits', () => {
  it('blocks past the daily trade count', () => {
    const r = evaluate(
      req(),
      ctx({ day: { dayOpenBalance: d('10000.00'), tradesToday: 5, consecutiveLosses: 0 } }),
    );
    expect(blockers(r)).toContain('trades-per-day');
    expect(r.checks.find((c) => c.rule === 'trades-per-day')?.message).toMatch(/revenge trading/);
  });

  it('blocks past the concurrent position cap', () => {
    const r = evaluate(
      req(),
      ctx({
        openPositions: [
          { canonical: 'EURUSD', side: 'buy', volume: d('0.10'), riskAccount: d('10.00') },
          { canonical: 'USDJPY', side: 'buy', volume: d('0.10'), riskAccount: d('10.00') },
          { canonical: 'GBPUSD', side: 'buy', volume: d('0.10'), riskAccount: d('10.00') },
        ],
      }),
    );
    expect(blockers(r)).toContain('concurrent-positions');
  });

  it('enforces a cooldown after a loss streak, and releases it on time', () => {
    const day = {
      dayOpenBalance: d('10000.00'),
      tradesToday: 3,
      consecutiveLosses: 3,
      lastLossAt: NOW - 10 * 60_000,
    };
    expect(blockers(evaluate(req(), ctx({ day })))).toContain('loss-streak-cooldown');
    const later = ctx({ day, now: NOW + 61 * 60_000 });
    expect(blockers(evaluate(req(), later))).not.toContain('loss-streak-cooldown');
  });
});

describe('market conditions', () => {
  it('blocks when the market is closed', () => {
    const saturday = Date.UTC(2026, 5, 13, 12, 0);
    const r = evaluate(req(), ctx({ now: saturday, account: { ...account, asOf: saturday } }));
    expect(blockers(r)).toContain('market-open');
  });

  it('blocks outside the sessions the operator trades', () => {
    // 02:00 UTC Monday: Tokyo is running, London and New York are not.
    const tokyoTime = Date.UTC(2026, 5, 15, 2, 0);
    const r = evaluate(req(), ctx({ now: tokyoTime, account: { ...account, asOf: tokyoTime } }));
    expect(blockers(r)).toContain('session-window');
  });

  it('blocks during the daily rollover', () => {
    const rollover = Date.UTC(2026, 5, 15, 21, 0); // server midnight, GMT+3
    const r = evaluate(req(), ctx({ now: rollover, account: { ...account, asOf: rollover } }));
    expect(blockers(r)).toContain('rollover');
  });

  it('blocks inside a high-impact news window and names the event', () => {
    const r = evaluate(
      req(),
      ctx({
        calendar: [
          { at: NOW + 2 * 60_000, impact: 'high', title: 'US CPI', affects: [] },
          { at: NOW + 2 * 60_000, impact: 'low', title: 'Minor print', affects: [] },
        ],
      }),
    );
    expect(blockers(r)).toContain('news-blackout');
    const messages = r.checks.filter((c) => c.rule === 'news-blackout').map((c) => c.message);
    expect(messages).toHaveLength(1); // the low-impact event does not trigger
    expect(messages[0]).toMatch(/US CPI in 2 min/);
  });

  it('ignores news that does not affect this instrument', () => {
    const r = evaluate(
      req(),
      ctx({
        calendar: [{ at: NOW + 60_000, impact: 'high', title: 'RBNZ', affects: ['NZDUSD'] }],
      }),
    );
    expect(blockers(r)).not.toContain('news-blackout');
  });

  it('blocks an abnormally wide spread', () => {
    const r = evaluate(req({ spread: d('1.50'), typicalSpread: d('0.30') }), ctx()); // 5x
    expect(blockers(r)).toContain('spread-sanity');
  });

  it('allows a normal spread', () => {
    const r = evaluate(req({ spread: d('0.35'), typicalSpread: d('0.30') }), ctx());
    expect(blockers(r)).not.toContain('spread-sanity');
  });
});

describe('margin and double-taps', () => {
  it('blocks when too little free margin would remain', () => {
    const r = evaluate(
      req({ marginRequiredAccount: d('8000.00') }),
      ctx({ account: { ...account, marginFree: d('9000.00') } }),
    );
    expect(blockers(r)).toContain('free-margin');
  });

  it('blocks a materially identical order placed seconds ago', () => {
    const r = evaluate(req({ recentIdenticalIntents: [NOW - 3000] }), ctx());
    expect(blockers(r)).toContain('duplicate-intent');
  });

  it('allows the same order again after the window closes', () => {
    const r = evaluate(req({ recentIdenticalIntents: [NOW - 30_000] }), ctx());
    expect(blockers(r)).not.toContain('duplicate-intent');
  });
});

describe('break-glass override', () => {
  const override = { reason: 'manual close-out of a hedge', authorisedAt: NOW };

  it('downgrades waivable blocks to warnings and records the reason', () => {
    const r = evaluate(req({ hasPreTradeNote: false, override }), ctx());
    const note = r.checks.find((c) => c.rule === 'pre-trade-note');
    expect(note?.verdict).toBe('warn');
    expect(note?.message).toMatch(/OVERRIDDEN: manual close-out of a hedge/);
  });

  it('cannot waive the rules that exist because the system cannot compute a safe answer', () => {
    const r = evaluate(req({ override, quoteAsOf: NOW - 60_000 }), ctx({ brokerConnected: false }));
    expect(r.verdict).toBe('block');
    expect(blockers(r)).toEqual(expect.arrayContaining(['broker-connection', 'quote-freshness']));
  });

  it('cannot waive a drawdown breach — the one rule that ends the account', () => {
    const bust = { ...account, balance: d('9000.00'), equity: d('9000.00') };
    const dd = updateDrawdown(initialDrawdownState(ddConfig, NOW - 86_400_000), ddConfig, {
      balance: bust.balance,
      equity: bust.equity,
      at: NOW,
    });
    const r = evaluate(
      req({ override }),
      ctx({
        account: bust,
        drawdown: dd,
        day: { dayOpenBalance: d('9000.00'), tradesToday: 0, consecutiveLosses: 0 },
      }),
    );
    expect(blockers(r)).toContain('drawdown');
  });

  it('every unwaivable rule is one the system genuinely cannot reason around', () => {
    // A guard against someone later adding a merely inconvenient rule here.
    for (const rule of UNWAIVABLE_RULES) {
      expect(
        [
          'broker-connection',
          'account-truth',
          'account-freshness',
          'quote-freshness',
          'drawdown',
          'drawdown-headroom',
          'daily-loss-limit',
          'duplicate-intent',
        ],
        `${rule} must be justified in the ADR before becoming unwaivable`,
      ).toContain(rule);
    }
  });
});
