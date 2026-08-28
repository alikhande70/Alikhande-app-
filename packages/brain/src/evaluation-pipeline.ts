import {
  type EvaluationPolicy,
  type ScanDecisionEvidence,
  type ScanEvaluationReport,
  evaluateScanPopulation,
} from './evaluation.js';
import {
  type DurableMissionForEvaluation,
  type VersionedMarketOutcomeLabel,
  projectDurableMissionsForEvaluation,
} from './mission-evaluation.js';
import {
  type DurableOutcomeSeedMission,
  type FixedHorizonOutcomePolicy,
  type MarketCloseObservation,
  buildFixedHorizonOutcomeLabel,
  projectOutcomeSeedFromDecisionSnapshot,
} from './outcome-labeling.js';

export type EvaluationPipelineMission = DurableMissionForEvaluation & DurableOutcomeSeedMission;

export interface OutcomeEvidenceGap {
  readonly missionId: string;
  readonly missing: readonly string[];
}

export interface EvaluationPipelineResult {
  readonly labels: readonly VersionedMarketOutcomeLabel[];
  readonly outcomeEvidenceGaps: readonly OutcomeEvidenceGap[];
  readonly scans: readonly ScanDecisionEvidence[];
  readonly report: ScanEvaluationReport;
}

function requireFiniteTimestamp(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative timestamp`);
  }
}

function validateOutcomePolicy(policy: FixedHorizonOutcomePolicy): void {
  if (policy.labelVersion.trim().length === 0) throw new Error('labelVersion is required');
  requireFiniteTimestamp('horizonMs', policy.horizonMs);
  if (policy.horizonMs <= 0) throw new Error('horizonMs must be greater than zero');
  if (!Number.isFinite(policy.flatThresholdR) || policy.flatThresholdR < 0) {
    throw new Error('flatThresholdR must be finite and non-negative');
  }
}

function observationKey(symbol: string, validAt: number): string {
  return `${symbol}\u0000${validAt}`;
}

function indexObservations(
  observations: readonly MarketCloseObservation[],
): ReadonlyMap<string, MarketCloseObservation> {
  const indexed = new Map<string, MarketCloseObservation>();
  for (const observation of observations) {
    if (observation.symbol.trim().length === 0) throw new Error('market symbol is required');
    requireFiniteTimestamp('market.validAt', observation.validAt);
    requireFiniteTimestamp('market.recordedAt', observation.recordedAt);
    if (observation.recordedAt < observation.validAt) {
      throw new Error('market observation was recorded before it became valid');
    }
    if (!Number.isFinite(observation.close) || observation.close <= 0) {
      throw new Error('market.close must be a finite value greater than zero');
    }

    const key = observationKey(observation.symbol, observation.validAt);
    if (indexed.has(key)) {
      throw new Error(
        `duplicate market observation for '${observation.symbol}' at ${observation.validAt}`,
      );
    }
    indexed.set(key, observation);
  }
  return indexed;
}

/**
 * Compose the immutable Mission population, fixed-horizon market facts and the
 * ADR-0021 evaluator without introducing a second truth store.
 *
 * Every Mission remains in scan evidence. Missing directional plans or missing
 * exact-horizon market observations are surfaced explicitly as outcome gaps rather
 * than silently deleting scans. Future observations may be present in the label set,
 * but evaluateScanPopulation still gates them by recordedAt <= evaluationCutoff.
 */
export function buildMissionEvaluationPipeline(
  missions: readonly EvaluationPipelineMission[],
  observations: readonly MarketCloseObservation[],
  outcomePolicy: FixedHorizonOutcomePolicy,
  evaluationPolicy: EvaluationPolicy,
): EvaluationPipelineResult {
  if (missions.length === 0) throw new Error('mission population is required');
  validateOutcomePolicy(outcomePolicy);

  const missionIds = new Set<string>();
  for (const mission of missions) {
    if (missionIds.has(mission.missionId)) {
      throw new Error(`duplicate durable mission '${mission.missionId}'`);
    }
    missionIds.add(mission.missionId);
  }

  const market = indexObservations(observations);
  const labels: VersionedMarketOutcomeLabel[] = [];
  const outcomeEvidenceGaps: OutcomeEvidenceGap[] = [];

  for (const mission of missions) {
    const projection = projectOutcomeSeedFromDecisionSnapshot(mission);
    if (projection.status === 'insufficient-data') {
      outcomeEvidenceGaps.push({ missionId: mission.missionId, missing: projection.missing });
      continue;
    }

    const targetValidAt = projection.seed.decisionKnowledgeTime + outcomePolicy.horizonMs;
    if (!Number.isSafeInteger(targetValidAt)) {
      throw new Error(`outcome target timestamp exceeds safe integer range for '${mission.missionId}'`);
    }
    const observation = market.get(observationKey(projection.seed.symbol, targetValidAt));
    if (observation === undefined) {
      outcomeEvidenceGaps.push({
        missionId: mission.missionId,
        missing: [`market.close@${outcomePolicy.horizonMs}ms`],
      });
      continue;
    }

    labels.push(buildFixedHorizonOutcomeLabel(projection.seed, observation, outcomePolicy));
  }

  const scans = projectDurableMissionsForEvaluation(missions, labels);
  const report = evaluateScanPopulation(scans, evaluationPolicy);
  return { labels, outcomeEvidenceGaps, scans, report };
}
