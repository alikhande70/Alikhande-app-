import type { VersionedMarketOutcomeLabel } from './mission-evaluation.js';

export interface OutcomeMissionSeed {
  readonly missionId: string;
  readonly decisionKnowledgeTime: number;
  readonly direction: 'long' | 'short';
  readonly referencePrice: number;
  readonly riskDistance: number;
}

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
