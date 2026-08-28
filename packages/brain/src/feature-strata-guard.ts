import type { DurablePairedEligibility } from './pre-registered-evaluation.js';

export interface FeatureStrataEvidence {
  readonly missionId: string;
  readonly featureKey: string;
  readonly normalizedValue: number;
  readonly validAt: number;
  readonly recordedAt: number;
}

export interface FeatureStrataPolicy {
  /** Deterministic decision-time feature used as the market-condition axis. */
  readonly featureKey: string;
  /** Fixed normalized boundaries, registered before forward evidence. Must start at 0 and end at 1. */
  readonly boundaries: readonly number[];
  /** Minimum fraction of all eligible scans that must carry valid point-in-time feature evidence. */
  readonly minimumEligibleCoverage: number;
  /** Minimum distinct strata represented by all eligible scans with evidence. */
  readonly minimumOccupiedEligibleBins: number;
  /** Minimum distinct strata represented by scans that actually drive directional inference. */
  readonly minimumOccupiedDirectionalBins: number;
  /** Upper bound on the fraction of directional evidence allowed in one stratum. */
  readonly maximumDirectionalBinShare: number;
}

export interface FeatureStrataBin {
  readonly index: number;
  readonly lowerInclusive: number;
  readonly upperInclusive: number;
  readonly eligibleCount: number;
  readonly directionalCount: number;
}

export interface FeatureStrataReport {
  readonly status: 'ready' | 'insufficient-data';
  readonly reasons: readonly string[];
  readonly featureKey: string;
  readonly eligiblePopulation: number;
  readonly evidencedPopulation: number;
  readonly evidenceCoverage: number;
  readonly missingMissionIds: readonly string[];
  readonly directionalPopulation: number;
  readonly directionalEvidencedPopulation: number;
  readonly missingDirectionalMissionIds: readonly string[];
  readonly occupiedEligibleBins: number;
  readonly occupiedDirectionalBins: number;
  readonly largestDirectionalBinShare: number;
  readonly bins: readonly FeatureStrataBin[];
}

function requireTimestamp(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative timestamp`);
  }
}

function validatePolicy(policy: FeatureStrataPolicy): void {
  if (policy.featureKey.trim().length === 0) throw new Error('feature strata featureKey is required');
  if (policy.boundaries.length < 2) throw new Error('feature strata requires at least two boundaries');
  if (policy.boundaries[0] !== 0 || policy.boundaries[policy.boundaries.length - 1] !== 1) {
    throw new Error('feature strata boundaries must start at 0 and end at 1');
  }
  for (let index = 0; index < policy.boundaries.length; index += 1) {
    const value = policy.boundaries[index];
    if (value === undefined || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error('feature strata boundaries must be finite values in [0,1]');
    }
    if (index > 0) {
      const previous = policy.boundaries[index - 1];
      if (previous === undefined || value <= previous) {
        throw new Error('feature strata boundaries must be strictly increasing');
      }
    }
  }
  if (
    !Number.isFinite(policy.minimumEligibleCoverage) ||
    policy.minimumEligibleCoverage < 0 ||
    policy.minimumEligibleCoverage > 1
  ) {
    throw new Error('minimumEligibleCoverage must be finite and in [0,1]');
  }
  const binCount = policy.boundaries.length - 1;
  for (const [name, value] of [
    ['minimumOccupiedEligibleBins', policy.minimumOccupiedEligibleBins],
    ['minimumOccupiedDirectionalBins', policy.minimumOccupiedDirectionalBins],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > binCount) {
      throw new Error(`${name} must be an integer between 1 and the number of strata`);
    }
  }
  if (
    !Number.isFinite(policy.maximumDirectionalBinShare) ||
    policy.maximumDirectionalBinShare <= 0 ||
    policy.maximumDirectionalBinShare > 1
  ) {
    throw new Error('maximumDirectionalBinShare must be finite and in (0,1]');
  }
}

function binIndex(value: number, boundaries: readonly number[]): number {
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const upper = boundaries[index + 1];
    if (upper !== undefined && (value < upper || (value === 1 && upper === 1))) return index;
  }
  throw new Error(`normalized feature value ${value} is outside registered strata`);
}

/**
 * ADR-0021 market-condition concentration guard.
 *
 * This deliberately does not consume an AI-authored regime label. It uses one pre-registered,
 * normalized deterministic feature and the exact bitemporal evidence coordinates persisted at
 * decision time. Missing evidence stays visible in the denominator. A decisive scan with missing
 * or late feature evidence blocks readiness rather than being silently dropped.
 */
export function assessFeatureStrataCoverage(
  eligibility: readonly DurablePairedEligibility[],
  evidence: readonly FeatureStrataEvidence[],
  decisiveMissionIds: ReadonlySet<string>,
  policy: FeatureStrataPolicy,
): FeatureStrataReport {
  validatePolicy(policy);

  const eligibleById = new Map<string, DurablePairedEligibility>();
  for (const item of eligibility) {
    if (item.missionId.trim().length === 0) throw new Error('feature strata eligibility missionId is required');
    requireTimestamp('feature strata eligibility observedAt', item.observedAt);
    requireTimestamp('feature strata eligibility knownAt', item.knownAt);
    if (item.knownAt < item.observedAt) {
      throw new Error(`feature strata eligibility '${item.missionId}' was known before observedAt`);
    }
    if (eligibleById.has(item.missionId)) throw new Error(`duplicate feature strata eligibility '${item.missionId}'`);
    eligibleById.set(item.missionId, item);
  }

  const targetEvidence = new Map<string, FeatureStrataEvidence>();
  for (const item of evidence) {
    if (item.featureKey !== policy.featureKey) continue;
    const eligible = eligibleById.get(item.missionId);
    if (eligible === undefined) {
      throw new Error(`feature strata evidence references ineligible mission '${item.missionId}'`);
    }
    if (targetEvidence.has(item.missionId)) {
      throw new Error(`duplicate feature strata evidence for '${item.missionId}'`);
    }
    requireTimestamp('feature strata evidence validAt', item.validAt);
    requireTimestamp('feature strata evidence recordedAt', item.recordedAt);
    if (item.recordedAt < item.validAt) {
      throw new Error(`feature strata evidence '${item.missionId}' was recorded before validAt`);
    }
    if (item.validAt > eligible.observedAt) {
      throw new Error(`feature strata evidence '${item.missionId}' uses future market evidence`);
    }
    if (item.recordedAt > eligible.knownAt) {
      throw new Error(`feature strata evidence '${item.missionId}' was learned after the scan knowledge-time`);
    }
    if (!Number.isFinite(item.normalizedValue) || item.normalizedValue < 0 || item.normalizedValue > 1) {
      throw new Error(`feature strata evidence '${item.missionId}' must be normalized to [0,1]`);
    }
    targetEvidence.set(item.missionId, item);
  }

  for (const missionId of decisiveMissionIds) {
    if (!eligibleById.has(missionId)) {
      throw new Error(`directional feature strata mission '${missionId}' is outside the eligible population`);
    }
  }

  const eligibleCounts = Array.from({ length: policy.boundaries.length - 1 }, () => 0);
  const directionalCounts = Array.from({ length: policy.boundaries.length - 1 }, () => 0);
  const missingMissionIds: string[] = [];
  const missingDirectionalMissionIds: string[] = [];

  for (const missionId of eligibleById.keys()) {
    const item = targetEvidence.get(missionId);
    if (item === undefined) {
      missingMissionIds.push(missionId);
      if (decisiveMissionIds.has(missionId)) missingDirectionalMissionIds.push(missionId);
      continue;
    }
    const index = binIndex(item.normalizedValue, policy.boundaries);
    eligibleCounts[index] = (eligibleCounts[index] ?? 0) + 1;
    if (decisiveMissionIds.has(missionId)) {
      directionalCounts[index] = (directionalCounts[index] ?? 0) + 1;
    }
  }

  missingMissionIds.sort();
  missingDirectionalMissionIds.sort();
  const eligiblePopulation = eligibility.length;
  const evidencedPopulation = targetEvidence.size;
  const evidenceCoverage = eligiblePopulation === 0 ? 0 : evidencedPopulation / eligiblePopulation;
  const directionalPopulation = decisiveMissionIds.size;
  const directionalEvidencedPopulation = directionalPopulation - missingDirectionalMissionIds.length;
  const occupiedEligibleBins = eligibleCounts.filter((count) => count > 0).length;
  const occupiedDirectionalBins = directionalCounts.filter((count) => count > 0).length;
  const largestDirectionalBinShare =
    directionalEvidencedPopulation === 0
      ? 0
      : Math.max(...directionalCounts) / directionalEvidencedPopulation;

  const reasons: string[] = [];
  if (evidenceCoverage < policy.minimumEligibleCoverage) reasons.push('minimum-feature-coverage-not-met');
  if (occupiedEligibleBins < policy.minimumOccupiedEligibleBins) reasons.push('minimum-eligible-strata-not-met');
  if (missingDirectionalMissionIds.length > 0) reasons.push('directional-feature-evidence-missing');
  if (occupiedDirectionalBins < policy.minimumOccupiedDirectionalBins) reasons.push('minimum-directional-strata-not-met');
  if (
    directionalEvidencedPopulation > 0 &&
    largestDirectionalBinShare > policy.maximumDirectionalBinShare
  ) {
    reasons.push('directional-stratum-concentration-exceeded');
  }

  const bins: FeatureStrataBin[] = eligibleCounts.map((eligibleCount, index) => ({
    index,
    lowerInclusive: policy.boundaries[index] ?? 0,
    upperInclusive: policy.boundaries[index + 1] ?? 1,
    eligibleCount,
    directionalCount: directionalCounts[index] ?? 0,
  }));

  return {
    status: reasons.length === 0 ? 'ready' : 'insufficient-data',
    reasons,
    featureKey: policy.featureKey,
    eligiblePopulation,
    evidencedPopulation,
    evidenceCoverage,
    missingMissionIds,
    directionalPopulation,
    directionalEvidencedPopulation,
    missingDirectionalMissionIds,
    occupiedEligibleBins,
    occupiedDirectionalBins,
    largestDirectionalBinShare,
    bins,
  };
}
