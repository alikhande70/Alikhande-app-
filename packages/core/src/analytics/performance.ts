import type { Dec } from '../money/decimal.js';
import * as D from '../money/decimal.js';
import type { SessionId } from '../time/sessions.js';

/**
 * Performance analytics over the operator's own executions.
 *
 * Everything is expressed in **R** — multiples of the risk taken on each trade —
 * because currency P&L conflates edge with position size, and a personal system
 * exists to measure edge.
 *
 * The module refuses to flatter. Statistics are reported alongside an explicit
 * statement of whether the sample supports the conclusion, because the single
 * most expensive mistake in personal trading is treating thirty trades as
 * evidence.
 */

export interface ClosedTrade {
  readonly tradeId: string;
  readonly canonical: string;
  readonly side: 'buy' | 'sell';
  readonly openedAt: number;
  readonly closedAt: number;
  readonly volume: Dec;
  readonly entryPrice: Dec;
  readonly exitPrice: Dec;
  readonly stopPrice: Dec;
  /** Money risked at entry, account currency. The denominator of R. */
  readonly riskAccount: Dec;
  /** Realised P&L net of costs, account currency. */
  readonly netPnl: Dec;
  /** Commission plus swap, account currency. Positive means paid. */
  readonly costs: Dec;
  /** Worst excursion against the position, in price units. */
  readonly maeprice?: Dec;
  /** Best excursion in favour, in price units. */
  readonly mfePrice?: Dec;
  readonly session?: SessionId;
  /** Difference between intended and achieved entry, in price units. */
  readonly entrySlippage?: Dec;
  /** Milliseconds from intent to fill. */
  readonly latencyMs?: number;
  readonly tags?: readonly string[];
}

export interface TradeMetrics extends ClosedTrade {
  /** Net P&L divided by risk. The unit of account for edge. */
  readonly r: Dec;
  readonly durationMs: number;
  readonly win: boolean;
  /** Costs as a fraction of the risk taken. */
  readonly costRatio: Dec;
}

const R_SCALE = 3;

export function withMetrics(t: ClosedTrade): TradeMetrics {
  const r = D.isZero(t.riskAccount)
    ? D.ZERO
    : D.div(t.netPnl, D.abs(t.riskAccount), R_SCALE, 'half-even');
  return {
    ...t,
    r,
    durationMs: t.closedAt - t.openedAt,
    win: D.gt(t.netPnl, D.ZERO),
    costRatio: D.isZero(t.riskAccount)
      ? D.ZERO
      : D.div(t.costs, D.abs(t.riskAccount), 4, 'half-even'),
  };
}

export interface Confidence {
  readonly sampleSize: number;
  /**
   * Whether the sample supports a conclusion about edge. Deliberately blunt:
   * below ~30 trades the standard error on expectancy swamps the estimate, and
   * ~100 is where the number starts to be worth acting on.
   */
  readonly verdict: 'insufficient' | 'indicative' | 'meaningful';
  readonly note: string;
}

function confidenceFor(n: number): Confidence {
  if (n < 30) {
    return {
      sampleSize: n,
      verdict: 'insufficient',
      note:
        `${n} trades is not enough to distinguish edge from luck. Treat every figure below as ` +
        'description, not evidence.',
    };
  }
  if (n < 100) {
    return {
      sampleSize: n,
      verdict: 'indicative',
      note:
        `${n} trades gives a direction but a wide error band. A 0.2R swing in expectancy here ` +
        'is well within noise.',
    };
  }
  return {
    sampleSize: n,
    verdict: 'meaningful',
    note: `${n} trades is enough for expectancy to be worth acting on, if conditions were stable.`,
  };
}

export interface PerformanceSummary {
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  readonly winRate: Dec;
  /** Average R per trade. The single most useful number here. */
  readonly expectancyR: Dec;
  readonly totalR: Dec;
  readonly avgWinR: Dec;
  readonly avgLossR: Dec;
  /** Gross profit / gross loss. Above 1 is profitable before position sizing. */
  readonly profitFactor: Dec | undefined;
  /** Expectancy / standard deviation of R, times sqrt(n). */
  readonly sqn: Dec | undefined;
  readonly maxConsecutiveLosses: number;
  readonly maxConsecutiveWins: number;
  /** Largest peak-to-trough fall of the cumulative R curve. */
  readonly maxDrawdownR: Dec;
  readonly netPnl: Dec;
  readonly totalCosts: Dec;
  /** Costs as a fraction of gross profit. Reveals a strategy that only pays the broker. */
  readonly costDrag: Dec | undefined;
  readonly confidence: Confidence;
}

export function summarisePerformance(trades: readonly TradeMetrics[]): PerformanceSummary {
  const n = trades.length;
  const confidence = confidenceFor(n);
  if (n === 0) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: D.ZERO,
      expectancyR: D.ZERO,
      totalR: D.ZERO,
      avgWinR: D.ZERO,
      avgLossR: D.ZERO,
      profitFactor: undefined,
      sqn: undefined,
      maxConsecutiveLosses: 0,
      maxConsecutiveWins: 0,
      maxDrawdownR: D.ZERO,
      netPnl: D.ZERO,
      totalCosts: D.ZERO,
      costDrag: undefined,
      confidence,
    };
  }

  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const totalR = D.sum(trades.map((t) => t.r));
  const expectancyR = D.div(totalR, D.dec(n), R_SCALE, 'half-even');

  const grossProfit = D.sum(wins.map((t) => t.netPnl));
  const grossLoss = D.abs(D.sum(losses.map((t) => t.netPnl)));
  const profitFactor = D.isZero(grossLoss)
    ? undefined
    : D.div(grossProfit, grossLoss, 2, 'half-even');

  // Cumulative-R drawdown: the psychological cost of the equity curve.
  let peak = D.ZERO;
  let cum = D.ZERO;
  let maxDd = D.ZERO;
  let winStreak = 0;
  let lossStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  for (const t of trades) {
    cum = D.add(cum, t.r);
    peak = D.max(peak, cum);
    maxDd = D.max(maxDd, D.sub(peak, cum));
    if (t.win) {
      winStreak += 1;
      lossStreak = 0;
      maxWinStreak = Math.max(maxWinStreak, winStreak);
    } else {
      lossStreak += 1;
      winStreak = 0;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    }
  }

  const totalCosts = D.sum(trades.map((t) => t.costs));

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: D.div(D.dec(wins.length), D.dec(n), 4, 'half-even'),
    expectancyR,
    totalR,
    avgWinR:
      wins.length === 0
        ? D.ZERO
        : D.div(D.sum(wins.map((t) => t.r)), D.dec(wins.length), R_SCALE, 'half-even'),
    avgLossR:
      losses.length === 0
        ? D.ZERO
        : D.div(D.sum(losses.map((t) => t.r)), D.dec(losses.length), R_SCALE, 'half-even'),
    profitFactor,
    sqn: systemQualityNumber(trades, expectancyR),
    maxConsecutiveLosses: maxLossStreak,
    maxConsecutiveWins: maxWinStreak,
    maxDrawdownR: maxDd,
    netPnl: D.sum(trades.map((t) => t.netPnl)),
    totalCosts,
    costDrag: D.isZero(grossProfit) ? undefined : D.div(totalCosts, grossProfit, 4, 'half-even'),
    confidence,
  };
}

/**
 * Van Tharp's System Quality Number: expectancy over the standard deviation of
 * R, scaled by sample size. Undefined below 2 trades, and meaningless below
 * about 30 — which `confidence` says out loud.
 */
function systemQualityNumber(trades: readonly TradeMetrics[], mean: Dec): Dec | undefined {
  const n = trades.length;
  if (n < 2) return undefined;
  const variance = D.div(
    D.sum(
      trades.map((t) => {
        const dev = D.sub(t.r, mean);
        return D.mul(dev, dev);
      }),
    ),
    D.dec(n - 1),
    8,
    'half-even',
  );
  if (D.isZero(variance)) return undefined;
  // sqrt is the one place a float is acceptable: the output is advisory and
  // never sizes an order (see ADR-0005).
  const sd = Math.sqrt(D.unsafeToNumber(variance));
  if (sd === 0) return undefined;
  const sqn = (D.unsafeToNumber(mean) / sd) * Math.sqrt(n);
  return D.dec(sqn.toFixed(2));
}

// ---------------------------------------------------------------------------
// Breakdowns — where an edge actually lives, or does not.
// ---------------------------------------------------------------------------

export interface Breakdown<K extends string> {
  readonly key: K;
  readonly summary: PerformanceSummary;
}

export function groupBy<K extends string>(
  trades: readonly TradeMetrics[],
  keyOf: (t: TradeMetrics) => K | undefined,
): readonly Breakdown<K>[] {
  const buckets = new Map<K, TradeMetrics[]>();
  for (const t of trades) {
    const k = keyOf(t);
    if (k === undefined) continue;
    const list = buckets.get(k);
    if (list === undefined) buckets.set(k, [t]);
    else list.push(t);
  }
  return [...buckets.entries()]
    .map(([key, list]) => ({ key, summary: summarisePerformance(list) }))
    .sort((a, b) => D.cmp(b.summary.expectancyR, a.summary.expectancyR));
}

export const bySession = (t: readonly TradeMetrics[]) => groupBy(t, (x) => x.session);
export const byInstrument = (t: readonly TradeMetrics[]) => groupBy(t, (x) => x.canonical);
export const bySide = (t: readonly TradeMetrics[]) => groupBy(t, (x) => x.side);

// ---------------------------------------------------------------------------
// Execution quality — the gap between the plan and the fill.
// ---------------------------------------------------------------------------

export interface ExecutionQuality {
  readonly samples: number;
  readonly medianSlippage: Dec | undefined;
  readonly worstSlippage: Dec | undefined;
  readonly medianLatencyMs: number | undefined;
  readonly p95LatencyMs: number | undefined;
  /** Costs as a fraction of risk, averaged: how much of each R the broker takes. */
  readonly avgCostR: Dec;
}

export function executionQuality(trades: readonly TradeMetrics[]): ExecutionQuality {
  const slips = trades
    .map((t) => t.entrySlippage)
    .filter((x): x is Dec => x !== undefined)
    .sort(D.cmp);
  const latencies = trades
    .map((t) => t.latencyMs)
    .filter((x): x is number => x !== undefined)
    .sort((a, b) => a - b);

  return {
    samples: trades.length,
    medianSlippage: median(slips),
    worstSlippage: slips.length === 0 ? undefined : (slips[slips.length - 1] as Dec),
    medianLatencyMs: latencies.length === 0 ? undefined : percentile(latencies, 0.5),
    p95LatencyMs: latencies.length === 0 ? undefined : percentile(latencies, 0.95),
    avgCostR:
      trades.length === 0
        ? D.ZERO
        : D.div(D.sum(trades.map((t) => t.costRatio)), D.dec(trades.length), 4, 'half-even'),
  };
}

function median(sorted: readonly Dec[]): Dec | undefined {
  if (sorted.length === 0) return undefined;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as Dec;
  return D.div(D.add(sorted[mid - 1] as Dec, sorted[mid] as Dec), D.dec(2), 6, 'half-even');
}

function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] as number;
}

/**
 * Detect drift in execution quality — a broker quietly getting worse, or a
 * strategy drifting into worse liquidity. Compares a recent window against the
 * baseline before it, and reports only differences large enough to matter.
 */
export interface DriftReport {
  readonly metric: string;
  readonly baseline: string;
  readonly recent: string;
  readonly changePct: Dec;
  readonly direction: 'better' | 'worse';
}

export function detectExecutionDrift(
  trades: readonly TradeMetrics[],
  recentCount: number,
  minChangePct = D.dec('0.25'),
): readonly DriftReport[] {
  if (trades.length < recentCount * 2) return [];
  const baseline = executionQuality(trades.slice(0, trades.length - recentCount));
  const recent = executionQuality(trades.slice(trades.length - recentCount));
  const out: DriftReport[] = [];

  const compareDec = (metric: string, a: Dec | undefined, b: Dec | undefined): void => {
    if (a === undefined || b === undefined || D.isZero(a)) return;
    const change = D.div(D.sub(b, a), D.abs(a), 4, 'half-even');
    if (D.lt(D.abs(change), minChangePct)) return;
    out.push({
      metric,
      baseline: D.toString(a),
      recent: D.toString(b),
      changePct: change,
      direction: D.gt(change, D.ZERO) ? 'worse' : 'better',
    });
  };

  compareDec('median entry slippage', baseline.medianSlippage, recent.medianSlippage);
  compareDec('average cost per R', baseline.avgCostR, recent.avgCostR);

  if (baseline.medianLatencyMs !== undefined && recent.medianLatencyMs !== undefined) {
    const a = baseline.medianLatencyMs;
    const b = recent.medianLatencyMs;
    if (a > 0) {
      const change = D.div(D.dec(b - a), D.dec(a), 4, 'half-even');
      if (D.gte(D.abs(change), minChangePct)) {
        out.push({
          metric: 'median fill latency',
          baseline: `${a}ms`,
          recent: `${b}ms`,
          changePct: change,
          direction: b > a ? 'worse' : 'better',
        });
      }
    }
  }

  return out;
}
