import type { FeatureStrataEvidence, FeatureStrataPolicy } from './feature-strata-guard.js';
import {
  buildStrataAwarePreRegisteredEvaluation,
  type StrataAwareAnalysisPlan,
  type StrataAwareEvaluationPolicy,
  type StrataAwareEvaluationPopulation,
  type StrataAwareEvaluationResult,
} from './strata-aware-evaluation.js';
import type { FixedHorizonOutcomePolicy, MarketCloseObservation } from './outcome-labeling.js';

export interface SnapshotFeatureEvidenceCoordinate {
  readonly featureKey: string;
  readonly validAt: number;
  readonly recordedAt: number;
  readonly normalizedValue: number;
}

export interface SnapshotBrainEvaluationForStrata {
  readonly featureSetVersion: string;
  readonly decisionAsOf: number;
  readonly knowledgeCutoff: number;
  readonly evidence: readonly SnapshotFeatureEvidenceCoordinate[];
  readonly missing: readonly string[];
}

export interface SnapshotMissionForFeatureStrata {
  readonly missionId: string;
  readonly observedAt: number;
  readonly decisionSnapshot?: {
    readonly asOf: number;
    readonly brainEvaluation?: SnapshotBrainEvaluationForStrata;
  };
}

export interface VersionedFeatureStrataPolicy extends FeatureStrataPolicy {
  /** Exact deterministic feature-set version sealed into every eligible Mission snapshot. */
  readonly featureSetVersion: string;
}

export interface SnapshotStrataAwareAnalysisPlan
  extends Omit<StrataAwareAnalysisPlan, 'featureStrata'> {
  readonly featureStrata: VersionedFeatureStrataPolicy;
}

export interface SnapshotStrataAwareEvaluationPolicy
  extends Omit<StrataAwareEvaluationPolicy, 'analysisPlan'> {
  readonly analysisPlan: SnapshotStrataAwareAnalysisPlan;
}

export interface SnapshotStrataAwareEvaluationPopulation
  extends Omit<StrataAwareEvaluationPopulation, 'featureStrataEvidence'> {
  /** Durable Mission projections reconstructed from the hash-verified Desk ledger. */
  readonly featureMissions: readonly SnapshotMissionForFeatureStrata[];
}

function requireTimestamp(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative timestamp`);
  }
}

/**
 * Derive one market-condition feature directly from immutable Decision Snapshots.
 *
 * Missing snapshots/evaluations remain missing evidence so the downstream guard keeps them in the
 * denominator. Once a Brain evaluation exists, however, its feature-set version, decision-time
 * coordinates and feature evidence are authoritative and are validated fail-closed. No caller can
 * substitute a later feature value or silently reinterpret an older feature schema.
 */
export function projectSnapshotFeatureStrataEvidence(
  missions: readonly SnapshotMissionForFeatureStrata[],
  featureKey: string,
  featureSetVersion: string,
): readonly FeatureStrataEvidence[] {
  if (featureKey.trim().length === 0) throw new Error('snapshot featureKey is required');
  if (featureSetVersion.trim().length === 0) throw new Error('snapshot featureSetVersion is required');

  const seenMissions = new Set<string>();
  const projected: FeatureStrataEvidence[] = [];

  for (const mission of missions) {
    if (mission.missionId.trim().length === 0) throw new Error('snapshot missionId is required');
    if (seenMissions.has(mission.missionId)) {
      throw new Error(`duplicate snapshot mission '${mission.missionId}'`);
    }
    seenMissions.add(mission.missionId);
    requireTimestamp('snapshot mission observedAt', mission.observedAt);

    const snapshot = mission.decisionSnapshot;
    if (snapshot === undefined) continue;
    requireTimestamp(`snapshot '${mission.missionId}' asOf`, snapshot.asOf);
    if (snapshot.asOf < mission.observedAt) {
      throw new Error(`snapshot '${mission.missionId}' predates its market observation`);
    }

    const evaluation = snapshot.brainEvaluation;
    if (evaluation === undefined) continue;
    if (evaluation.featureSetVersion !== featureSetVersion) {
      throw new Error(
        `snapshot '${mission.missionId}' feature-set mismatch: expected '${featureSetVersion}', received '${evaluation.featureSetVersion}'`,
      );
    }
    requireTimestamp(`snapshot '${mission.missionId}' decisionAsOf`, evaluation.decisionAsOf);
    requireTimestamp(`snapshot '${mission.missionId}' knowledgeCutoff`, evaluation.knowledgeCutoff);
    if (evaluation.decisionAsOf !== snapshot.asOf) {
      throw new Error(`snapshot '${mission.missionId}' Brain decisionAsOf does not match snapshot asOf`);
    }
    if (evaluation.knowledgeCutoff < evaluation.decisionAsOf) {
      throw new Error(`snapshot '${mission.missionId}' knowledgeCutoff predates decisionAsOf`);
    }

    const missing = new Set(evaluation.missing);
    if (missing.size !== evaluation.missing.length) {
      throw new Error(`snapshot '${mission.missionId}' contains duplicate missing feature keys`);
    }

    let target: SnapshotFeatureEvidenceCoordinate | undefined;
    const seenFeatures = new Set<string>();
    for (const item of evaluation.evidence) {
      if (item.featureKey.trim().length === 0) {
        throw new Error(`snapshot '${mission.missionId}' contains empty featureKey`);
      }
      if (seenFeatures.has(item.featureKey)) {
        throw new Error(`snapshot '${mission.missionId}' contains duplicate feature '${item.featureKey}'`);
      }
      seenFeatures.add(item.featureKey);
      requireTimestamp(`snapshot '${mission.missionId}' feature validAt`, item.validAt);
      requireTimestamp(`snapshot '${mission.missionId}' feature recordedAt`, item.recordedAt);
      if (item.recordedAt < item.validAt) {
        throw new Error(`snapshot '${mission.missionId}' feature '${item.featureKey}' was recorded before validAt`);
      }
      if (item.validAt > snapshot.asOf) {
        throw new Error(`snapshot '${mission.missionId}' feature '${item.featureKey}' uses future evidence`);
      }
      if (item.recordedAt > evaluation.knowledgeCutoff) {
        throw new Error(
          `snapshot '${mission.missionId}' feature '${item.featureKey}' was learned after knowledgeCutoff`,
        );
      }
      if (
        !Number.isFinite(item.normalizedValue) ||
        item.normalizedValue < 0 ||
        item.normalizedValue > 1
      ) {
        throw new Error(
          `snapshot '${mission.missionId}' feature '${item.featureKey}' must be normalized to [0,1]`,
        );
      }
      if (missing.has(item.featureKey)) {
        throw new Error(
          `snapshot '${mission.missionId}' feature '${item.featureKey}' cannot be both evidence and missing`,
        );
      }
      if (item.featureKey === featureKey) target = item;
    }

    if (target === undefined) {
      if (!missing.has(featureKey)) {
        throw new Error(
          `snapshot '${mission.missionId}' neither persists nor marks feature '${featureKey}' missing`,
        );
      }
      continue;
    }

    projected.push({
      missionId: mission.missionId,
      featureKey,
      normalizedValue: target.normalizedValue,
      validAt: target.validAt,
      recordedAt: target.recordedAt,
    });
  }

  projected.sort((left, right) => left.missionId.localeCompare(right.missionId));
  return projected;
}

/**
 * ADR-0021 preferred composition boundary for market-condition coverage.
 *
 * The caller provides durable Mission projections, not free-form feature evidence. This function
 * derives the exact bitemporal feature coordinates from sealed snapshots and then delegates to the
 * existing dependence-aware, pre-registered strata evaluator.
 */
export function buildSnapshotStrataAwarePreRegisteredEvaluation(
  population: SnapshotStrataAwareEvaluationPopulation,
  observations: readonly MarketCloseObservation[],
  outcomePolicy: FixedHorizonOutcomePolicy,
  policy: SnapshotStrataAwareEvaluationPolicy,
): StrataAwareEvaluationResult {
  const versioned = policy.analysisPlan.featureStrata;
  const featureStrataEvidence = projectSnapshotFeatureStrataEvidence(
    population.featureMissions,
    versioned.featureKey,
    versioned.featureSetVersion,
  );
  const { featureSetVersion: _featureSetVersion, ...featureStrata } = versioned;
  const basePolicy: StrataAwareEvaluationPolicy = {
    ...policy,
    analysisPlan: {
      ...policy.analysisPlan,
      featureStrata,
    },
  };

  return buildStrataAwarePreRegisteredEvaluation(
    { ...population, featureStrataEvidence },
    observations,
    outcomePolicy,
    basePolicy,
  );
}
