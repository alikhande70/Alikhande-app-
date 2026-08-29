import { describe, expect, it } from 'vitest';
import * as D from '../money/decimal.js';
import type { ClosedTrade, TradeMetrics } from './performance.js';
import {
  bySession,
  detectExecutionDrift,
  executionQuality,
  summarisePerformance,
  withMetrics,
} from './performance.js';

const d = D.dec;
const T0 = Date.UTC(2026, 5, 15, 14, 0);

function trade(over: Partial<ClosedTrade> = {}, i = 0): TradeMetrics {
  return withMetrics({
    tradeId: `t${i}`,
    canonical: 'XAUUSD',
    side: 'buy',
    openedAt: T0 + i * 3_600_000,
    closedAt: T0 + i * 3_600_000 + 1_800_000,
    volume: d('0.20'),
    entryPrice: d('2400.00'),
    exitPrice: d('2410.00'),
    stopPrice: d('2395.00'),
    riskAccount: d('100.00'),
    netPnl: d('200.00'),
    costs: d('4.00'),
    ...over,
  });
}

/** A sequence of R outcomes, as trades. */
function series(rs: number[]): TradeMetrics[] {
  return rs.map((r, i) => trade({ netPnl: d((r * 100).toFixed(2)) }, i));
}

describe('R multiples', () => {
  it('expresses P&L as a multiple of the risk taken', () => {
    expect(D.toString(trade().r)).toBe('2.000');
    expect(D.toString(trade({ netPnl: d('-100.00') }).r)).toBe('-1.000');
    expect(D.toString(trade({ netPnl: d('-50.00') }).r)).toBe('-0.500');
  });

  it('reports costs as a fraction of risk', () => {
    expect(D.toString(trade({ costs: d('4.00') }).costRatio)).toBe('0.0400');
  });

  it('does not divide by a zero risk', () => {
    expect(D.toString(trade({ riskAccount: d('0.00') }).r)).toBe('0');
  });
});

describe('summary statistics', () => {
  it('computes expectancy, profit factor and streaks', () => {
    // 3 wins of 2R, 5 losses of 1R => total 1R over 8 trades.
    const s = summarisePerformance(series([2, -1, 2, -1, -1, 2, -1, -1]));
    expect(s.trades).toBe(8);
    expect(s.wins).toBe(3);
    expect(D.toString(s.winRate)).toBe('0.3750');
    expect(D.toString(s.totalR)).toBe('1.000');
    expect(D.toString(s.expectancyR)).toBe('0.125');
    expect(D.toString(s.profitFactor as D.Dec)).toBe('1.20');
    expect(s.maxConsecutiveLosses).toBe(2);
    expect(s.maxConsecutiveWins).toBe(1);
  });

  it('measures drawdown on the R curve, not on money', () => {
    // Curve: 1, 0, -1, -2, 0 => peak 1, trough -2 => 3R drawdown.
    const s = summarisePerformance(series([1, -1, -1, -1, 2]));
    expect(D.toString(s.maxDrawdownR)).toBe('3.000');
  });

  it('handles an empty history without pretending', () => {
    const s = summarisePerformance([]);
    expect(s.trades).toBe(0);
    expect(s.profitFactor).toBeUndefined();
    expect(s.sqn).toBeUndefined();
    expect(s.confidence.verdict).toBe('insufficient');
  });

  it('leaves profit factor undefined when nothing has lost yet', () => {
    expect(summarisePerformance(series([1, 2, 3])).profitFactor).toBeUndefined();
  });

  it('exposes how much of gross profit the broker took', () => {
    const s = summarisePerformance([trade({ netPnl: d('200.00'), costs: d('20.00') })]);
    expect(D.toString(s.costDrag as D.Dec)).toBe('0.1000');
  });
});

describe('sample-size honesty', () => {
  it('calls a small sample insufficient, however good it looks', () => {
    const s = summarisePerformance(series(Array.from({ length: 12 }, () => 2)));
    expect(D.gt(s.expectancyR, d('1'))).toBe(true);
    expect(s.confidence.verdict).toBe('insufficient');
    expect(s.confidence.note).toMatch(/not enough to distinguish edge from luck/);
  });

  it('calls a medium sample indicative', () => {
    expect(
      summarisePerformance(series(Array.from({ length: 50 }, (_, i) => (i % 3 ? -1 : 2))))
        .confidence.verdict,
    ).toBe('indicative');
  });

  it('calls a large sample meaningful', () => {
    expect(
      summarisePerformance(series(Array.from({ length: 150 }, (_, i) => (i % 3 ? -1 : 2))))
        .confidence.verdict,
    ).toBe('meaningful');
  });

  it('computes SQN but scales it by sample size', () => {
    const small = summarisePerformance(series([2, -1, 2, -1, 2, -1]));
    const large = summarisePerformance(
      series(Array.from({ length: 60 }, (_, i) => (i % 2 ? -1 : 2))),
    );
    expect(small.sqn).toBeDefined();
    expect(large.sqn).toBeDefined();
    // Same shape of edge, more evidence => higher SQN.
    expect(D.gt(large.sqn as D.Dec, small.sqn as D.Dec)).toBe(true);
  });
});

describe('breakdowns', () => {
  it('ranks sessions by expectancy', () => {
    const trades = [
      trade({ session: 'london', netPnl: d('300.00') }, 0),
      trade({ session: 'london', netPnl: d('200.00') }, 1),
      trade({ session: 'tokyo', netPnl: d('-100.00') }, 2),
      trade({ session: 'tokyo', netPnl: d('-100.00') }, 3),
    ];
    const ranked = bySession(trades);
    expect(ranked[0]?.key).toBe('london');
    expect(ranked[1]?.key).toBe('tokyo');
    expect(D.toString(ranked[1]?.summary.expectancyR as D.Dec)).toBe('-1.000');
  });

  it('skips trades with no session rather than inventing one', () => {
    const ranked = bySession([trade({ session: 'london' }, 0), trade({}, 1)]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.summary.trades).toBe(1);
  });
});

describe('execution quality', () => {
  it('reports median and worst slippage and latency percentiles', () => {
    const trades = [
      trade({ entrySlippage: d('0.10'), latencyMs: 100 }, 0),
      trade({ entrySlippage: d('0.20'), latencyMs: 200 }, 1),
      trade({ entrySlippage: d('0.90'), latencyMs: 900 }, 2),
    ];
    const q = executionQuality(trades);
    expect(D.toString(q.medianSlippage as D.Dec)).toBe('0.20');
    expect(D.toString(q.worstSlippage as D.Dec)).toBe('0.90');
    expect(q.medianLatencyMs).toBe(200);
    expect(q.p95LatencyMs).toBe(900);
  });

  it('leaves metrics undefined when nothing was measured', () => {
    const q = executionQuality([trade()]);
    expect(q.medianSlippage).toBeUndefined();
    expect(q.medianLatencyMs).toBeUndefined();
  });
});

describe('execution drift', () => {
  it('detects a broker quietly getting worse', () => {
    const good = Array.from({ length: 20 }, (_, i) =>
      trade({ entrySlippage: d('0.10'), latencyMs: 100 }, i),
    );
    const bad = Array.from({ length: 20 }, (_, i) =>
      trade({ entrySlippage: d('0.40'), latencyMs: 400 }, i + 20),
    );
    const drift = detectExecutionDrift([...good, ...bad], 20);
    const metrics = drift.map((x) => x.metric);
    expect(metrics).toContain('median entry slippage');
    expect(metrics).toContain('median fill latency');
    expect(drift.every((x) => x.direction === 'worse')).toBe(true);
  });

  it('stays quiet when nothing changed', () => {
    const flat = Array.from({ length: 40 }, (_, i) =>
      trade({ entrySlippage: d('0.10'), latencyMs: 100 }, i),
    );
    expect(detectExecutionDrift(flat, 20)).toHaveLength(0);
  });

  it('says nothing without enough history to compare', () => {
    expect(detectExecutionDrift([trade()], 20)).toHaveLength(0);
  });
});
