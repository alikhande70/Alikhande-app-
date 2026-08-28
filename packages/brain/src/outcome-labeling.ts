import type { VersionedMarketOutcomeLabel } from './mission-evaluation.js';

export interface OutcomeMissionSeed {
  readonly missionId: string;
  readonly symbol: string;
  readonly decisionKnowledgeTime: number;
  readonly direction: 'long' | 'short';
  readonly referencePrice: number;
  readonly riskDistance: number;
}

export interface DurableOutcomeSeedMission {
  readonly missionId: string;
  readonly canonical: string;
  readonly decisionSnapshot: {
    readonly asOf: number;
    readonly brainEvaluation?: {
      readonly knowledgeCutoff: number;
    };
    readonly plan?: {
      readonly side: 'buy' | 'sell';
      readonly entry?: string;
      readonly stop?: string;
    };
  };
}

export type OutcomeSeedProjection =
  | { readonly status: 'ready'; readonly seed: OutcomeMissionSeed }
  | { readonly status: 'insufficient-data'; readonly missing: readonly string[] };

export interface MarketCloseObservation {
  readonly symbol: string;
  readonly validAt: number;
  readonly recordedAt: number;
  readonly close: number;
}

export interface FixedHorizonOutcomePolicy {
  readonly labelVersion: string;
  readonly horizonMs: number;
  readonly flatThresholdR: number;
}

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

function requireFiniteTimestamp(name: string, value: number): void {
  requireFinite(name, value);
  if (value < 0) throw new Error(`${name} must be non-negative`);
}

function validatePolicy(policy: FixedHorizonOutcomePolicy): void {
  if (policy.labelVersion.trim().length === 0) throw new Error('labelVersion is required');
  requireFiniteTimestamp('horizonMs', policy.horizonMs);
  if (policy.horizonMs <= 0) throw new Error('horizonMs must be greater than zero');
  requireFinite('flatThresholdR', policy.flatThresholdR);
  if (policy.flatThresholdR < 0) throw new Error('flatThresholdR must be non-negative');
}

function validateSeed(seed: OutcomeMissionSeed): void {
  if (seed.missionId.trim().length === 0) throw new Error('missionId is required');
  if (seed.symbol.trim().length === 0) throw new Error('mission symbol is required');
  requireFiniteTimestamp('decisionKnowledgeTime', seed.decisionKnowledgeTime);
  requireFinite('referencePrice', seed.referencePrice);
  if (seed.referencePrice <= 0) throw new Error('referencePrice must be greater than zero');
  requireFinite('riskDistance', seed.riskDistance);
  if (seed.riskDistance <= 0) throw new Error('riskDistance must be greater than zero');
}

function validateObservation(observation: MarketCloseObservation): void {
  if (observation.symbol.trim().length === 0) throw new Error('market symbol is required');
  requireFiniteTimestamp('market.validAt', observation.validAt);
  requireFiniteTimestamp('market.recordedAt', observation.recordedAt);
  if (observation.recordedAt < observation.validAt) {
    throw new Error('market observation was recorded before it became valid');
  }
  requireFinite('market.close', observation.close);
  if (observation.close <= 0) throw new Error('market.close must be greater than zero');
}

function parseSnapshotPrice(field: string, value: string): number {
  const trimmed = value.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) {
    throw new Error(`${field} is not a canonical positive decimal`);
  }
  const parsed = Number(trimmed);
  requireFinite(field, parsed);
  if (parsed <= 0) throw new Error(`${field} must be greater than zero`);
  return parsed;
}

/**
 * Derive fixed-horizon label inputs from the immutable Mission decision snapshot.
 *
 * This deliberately refuses caller-supplied direction, price or risk. A Mission
 * without a sealed directional plan remains first-class insufficient data instead
 * of receiving a guessed counterfactual. Invalid persisted numeric/timeline data
 * is treated as corruption and fails closed.
 */
export function projectOutcomeSeedFromDecisionSnapshot(
  mission: DurableOutcomeSeedMission,
): OutcomeSeedProjection {
  if (mission.missionId.trim().length === 0) throw new Error('missionId is required');
  if (mission.canonical.trim().length === 0) throw new Error('mission canonical is required');

  const snapshot = mission.decisionSnapshot;
  requireFiniteTimestamp('snapshot.asOf', snapshot.asOf);
  const evaluation = snapshot.brainEvaluation;
  if (evaluation === undefined) {
    return { status: 'insufficient-data', missing: ['brainEvaluation'] };
  }
  requireFiniteTimestamp('brain.knowledgeCutoff', evaluation.knowledgeCutoff);
  if (snapshot.asOf > evaluation.knowledgeCutoff) {
    throw new Error('decision snapshot is after its Brain knowledge cutoff');
  }

  const plan = snapshot.plan;
  if (plan === undefined) {
    return { status: 'insufficient-data', missing: ['plan'] };
  }
  const missing: string[] = [];
  if (plan.entry === undefined) missing.push('plan.entry');
  if (plan.stop === undefined) missing.push('plan.stop');
  if (missing.length > 0) return { status: 'insufficient-data', missing };

  const entry = parseSnapshotPrice('plan.entry', plan.entry ?? '');
  const stop = parseSnapshotPrice('plan.stop', plan.stop ?? '');
  if (plan.side === 'buy' && stop >= entry) {
    throw new Error('buy plan stop must be below entry for outcome risk normalisation');
  }
  if (plan.side === 'sell' && stop <= entry) {
    throw new Error('sell plan stop must be above entry for outcome risk normalisation');
  }

  const seed: OutcomeMissionSeed = {
    missionId: mission.missionId,
    symbol: mission.canonical,
    decisionKnowledgeTime: evaluation.knowledgeCutoff,
    direction: plan.side === 'buy' ? 'long' : 'short',
    referencePrice: entry,
    riskDistance: Math.abs(entry - stop),
  };
  validateSeed(seed);
  return { status: 'ready', seed };
}

function classifyDirection(
  counterfactualR: number,
  flatThresholdR: number,
): VersionedMarketOutcomeLabel['directional'] {
  if (Math.abs(counterfactualR) <= flatThresholdR) return 'flat';
  if (counterfactualR > 0) return 'favourable';
  return 'unfavourable';
}

/**
 * Build an ADR-0021 future-outcome label from one fixed, versioned horizon.
 *
 * The caller must provide the exact close observation at the policy horizon. We
 * deliberately do not pick a nearest/later bar because doing so would make the
 * label dependent on data availability and could introduce hindsight. Realised
 * trade P/L is not accepted here; broker truth remains a separate evidence path.
 */
export function buildFixedHorizonOutcomeLabel(
  seed: OutcomeMissionSeed,
  observation: MarketCloseObservation,
  policy: FixedHorizonOutcomePolicy,
): VersionedMarketOutcomeLabel {
  validateSeed(seed);
  validateObservation(observation);
  validatePolicy(policy);

  if (observation.symbol !== seed.symbol) {
    throw new Error(
      `market observation symbol '${observation.symbol}' does not match mission symbol '${seed.symbol}'`,
    );
  }

  const targetValidAt = seed.decisionKnowledgeTime + policy.horizonMs;
  if (!Number.isSafeInteger(targetValidAt)) {
    throw new Error('outcome target timestamp exceeds safe integer range');
  }
  if (observation.validAt !== targetValidAt) {
    throw new Error(
      `market observation must match the fixed outcome horizon exactly (${targetValidAt})`,
    );
  }

  const signedMove =
    seed.direction === 'long'
      ? observation.close - seed.referencePrice
      : seed.referencePrice - observation.close;
  const counterfactualR = signedMove / seed.riskDistance;
  requireFinite('counterfactualR', counterfactualR);

  return {
    labelVersion: policy.labelVersion,
    missionId: seed.missionId,
    decisionKnowledgeTime: seed.decisionKnowledgeTime,
    validAt: observation.validAt,
    recordedAt: observation.recordedAt,
    directional: classifyDirection(counterfactualR, policy.flatThresholdR),
    counterfactualR,
  };
}
