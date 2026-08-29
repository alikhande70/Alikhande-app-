import type { Dec } from '@keel/core';
import * as D from '@keel/core';
import type { Freshness, StalenessBudget, Tick } from './port.js';
import { ageMs, describeAge, freshness, mid } from './port.js';

/**
 * Cross-plane divergence monitoring (ADR-0013).
 *
 * The failure this exists to catch is the worst kind of stale data: a broker
 * feed that has frozen while the socket stays open. Nothing about the transport
 * reveals it. Two things do — the age of the last tick, and a second,
 * independent opinion about where the market is.
 *
 * A wide divergence is not automatically the broker's fault. It could be a real
 * venue dislocation, a bridge lagging, or the reference provider being wrong.
 * The monitor reports what it observed and what it cannot distinguish, rather
 * than picking a culprit.
 */

export type DivergenceVerdict =
  | 'ok'
  /** One plane has gone quiet while the other keeps printing. */
  | 'execution-frozen'
  | 'reference-frozen'
  /** Both are printing but disagree beyond the threshold. */
  | 'price-divergence'
  /** Not enough information to say anything. */
  | 'insufficient-data';

export interface PlaneDivergence {
  readonly canonical: string;
  readonly verdict: DivergenceVerdict;
  readonly executionMid?: Dec;
  readonly referenceMid?: Dec;
  /** Absolute difference as a fraction of the reference mid. */
  readonly differenceFraction?: Dec;
  readonly executionAgeMs?: number;
  readonly referenceAgeMs?: number;
  readonly executionFreshness?: Freshness;
  readonly referenceFreshness?: Freshness;
  readonly detail: string;
}

export interface DivergenceConfig {
  /** Relative difference beyond which the planes are considered to disagree. */
  readonly thresholdFraction: Dec;
  readonly budget: StalenessBudget;
}

export const DEFAULT_DIVERGENCE: DivergenceConfig = {
  // 0.2% — comfortably wider than a normal cross-venue basis, narrow enough to
  // catch a feed that has stopped moving while the market has not.
  thresholdFraction: D.dec('0.002'),
  budget: { liveMs: 3_000, staleMs: 30_000 },
};

export function compareplanes(
  canonical: string,
  execution: Tick | undefined,
  reference: Tick | undefined,
  now: number,
  config: DivergenceConfig = DEFAULT_DIVERGENCE,
): PlaneDivergence {
  if (execution === undefined || reference === undefined) {
    return {
      canonical,
      verdict: 'insufficient-data',
      detail:
        execution === undefined && reference === undefined
          ? 'neither plane has a quote'
          : execution === undefined
            ? 'no broker quote to compare'
            : 'no reference quote to compare',
    };
  }

  const execAge = ageMs(execution.asOf, now);
  const refAge = ageMs(reference.asOf, now);
  const execFresh = freshness(execution.asOf, now, config.budget);
  const refFresh = freshness(reference.asOf, now, config.budget);

  const base = {
    canonical,
    executionMid: mid(execution),
    referenceMid: mid(reference),
    executionAgeMs: execAge,
    referenceAgeMs: refAge,
    executionFreshness: execFresh,
    referenceFreshness: refFresh,
  };

  // A plane that has stopped while the other keeps printing is the signal that
  // matters most, and it is checked before the price comparison — comparing a
  // frozen price to a live one produces a divergence number that describes the
  // freeze, not the market.
  if (execFresh === 'stale' && refFresh !== 'stale') {
    return {
      ...base,
      verdict: 'execution-frozen',
      detail:
        `The broker feed has not printed for ${describeAge(execAge)} while the reference feed ` +
        `is ${describeAge(refAge)} old. The connection may still look healthy. ` +
        'Order entry is not safe against this price.',
    };
  }
  if (refFresh === 'stale' && execFresh !== 'stale') {
    return {
      ...base,
      verdict: 'reference-frozen',
      detail:
        `The reference feed has not printed for ${describeAge(refAge)}. Charts and context are ` +
        'stale; broker prices are unaffected.',
    };
  }
  if (execFresh === 'stale' && refFresh === 'stale') {
    return {
      ...base,
      verdict: 'insufficient-data',
      detail: 'Both feeds are stale; there is nothing to compare them on.',
    };
  }

  const refMid = mid(reference);
  if (D.Decimal.isZero(refMid)) {
    return { ...base, verdict: 'insufficient-data', detail: 'reference mid is zero' };
  }
  const diff = D.Decimal.abs(D.Decimal.sub(mid(execution), refMid));
  const fraction = D.Decimal.div(diff, D.Decimal.abs(refMid), 6, 'half-even');

  if (D.Decimal.gt(fraction, config.thresholdFraction)) {
    return {
      ...base,
      verdict: 'price-divergence',
      differenceFraction: fraction,
      detail:
        `Broker and reference prices differ by ${pct(fraction)} ` +
        `(${D.Decimal.toString(mid(execution))} vs ${D.Decimal.toString(refMid)}). ` +
        'This may be a lagging bridge, a real dislocation, or a wrong reference — ' +
        'the monitor cannot tell which, so it reports both figures.',
    };
  }

  return {
    ...base,
    verdict: 'ok',
    differenceFraction: fraction,
    detail: `Planes agree within ${pct(fraction)}.`,
  };
}

function pct(fraction: Dec): string {
  return `${D.Decimal.toString(D.Decimal.rescale(D.Decimal.mul(fraction, D.dec(100)), 3, 'half-even'))}%`;
}

/** Whether this verdict should stop order entry. */
export function blocksOrderEntry(v: DivergenceVerdict): boolean {
  return v === 'execution-frozen';
}
