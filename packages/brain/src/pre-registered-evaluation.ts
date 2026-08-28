import type { EvaluationPolicy, ScanEvaluationReport } from './evaluation.js';
import {
  buildMissionEvaluationPipeline,
  type EvaluationPipelineMission,
  type OutcomeEvidenceGap,
} from './evaluation-pipeline.js';
import {
  projectDurableMissionsForPairedEvaluation,
  type VersionedMarketOutcomeLabel,
} from './mission-evaluation.js';
import type { FixedHorizonOutcomePolicy, MarketCloseObservation } from './outcome-labeling.js';
import {
  inferForwardPairedOutcomeAlignment,
  type PairedOutcomeInferencePolicy,
  type PairedOutcomeInferenceReport,
} from './paired-inference.js';

export interface PreRegisteredPairedAnalysisPlan {
  /** Stable immutable identifier for the analysis plan. */
  readonly planId: string;
  /** Challenger content hash fixed by the plan. */
  readonly challengerContentHash: `sha256:${string}`;
  /** Time the analysis plan became durable. */
  readonly registeredAt: number;
  /** Fixed evidence cutoff. Re-runs after this time must not accumulate new evidence. */
  readonly analysisCutoff: number;
  /** Required fraction of eligible scans that contain the target Challenger shadow decision. */
  readonly minimumPairingCoverage: number;
}

export interface PreRegisteredEvaluationPolicy {
  readonly currentKnowledgeCutoff: number;
  readonly aggregate: EvaluationPolicy;
  readonly paired: Omit<PairedOutcomeInferencePolicy, 'evaluationCutoff'>;
  readonly analysisPlan: PreRegisteredPairedAnalysisPlan;
}

export type PreRegisteredPairedResult =
  | {
      readonly status: 'analysis-window-open';
      readonly planId: string;
      readonly analysisCutoff: number;
    }
  | {
      readonly status: 'ready' | 'insufficient-data';
      readonly planId: string;
      readonly analysisCutoff: number;
      readonly pairingCoverage: number;
      readonly eligiblePairedPopulation: number;
      readonly observedPairedPopulation: number;
      readonly missingPairedMissionIds: readonly string[];
      readonly reasons: readonly string[];
      readonly inference: PairedOutcomeInferenceReport | null;
    };

export interface PreRegisteredEvaluationResult {
  /** Aggregate scan report only. Raw future labels are intentionally not exposed here. */
  readonly aggregateReport: ScanEvaluationReport;
  readonly outcomeEvidenceGaps: readonly OutcomeEvidenceGap[];
  readonly paired: PreRegisteredPairedResult;
}

function requireTimestamp(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative timestamp`);
  }
}

function requireHash(name: string, value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${name} is not a valid content hash`);
}

function validatePolicy(policy: PreRegisteredEvaluationPolicy): void {
  requireTimestamp('currentKnowledgeCutoff', policy.currentKnowledgeCutoff);
  requireTimestamp('aggregate.evaluationCutoff', policy.aggregate.evaluationCutoff);
  if (policy.aggregate.evaluationCutoff > policy.currentKnowledgeCutoff) {
    throw new Error('aggregate evaluation cutoff cannot be later than current knowledge');
  }

  const plan = policy.analysisPlan;
  if (plan.planId.trim().length === 0) throw new Error('analysis planId is required');
  requireHash('analysis challengerContentHash', plan.challengerContentHash);
  requireTimestamp('analysis registeredAt', plan.registeredAt);
  requireTimestamp('analysis analysisCutoff', plan.analysisCutoff);
  if (plan.analysisCutoff <= plan.registeredAt) {
    throw new Error('analysisCutoff must be strictly after registeredAt');
  }
  if (
    !Number.isFinite(plan.minimumPairingCoverage) ||
    plan.minimumPairingCoverage < 0 ||
    plan.minimumPairingCoverage > 1
  ) {
    throw new Error('minimumPairingCoverage must be finite and in [0,1]');
  }
}

function missionKnowledgeTime(mission: EvaluationPipelineMission): number | undefined {
  return mission.decisionSnapshot.brainComparison?.missionKnowledgeTime;
}

function hasTargetChallenger(
  mission: EvaluationPipelineMission,
  challengerContentHash: string,
): boolean {
  return (
    mission.decisionSnapshot.brainComparison?.evaluations?.some(
      (entry) => entry.role === 'challenger' && entry.contentHash === challengerContentHash,
    ) ?? false
  );
}

function challengerCreationTime(
  missions: readonly EvaluationPipelineMission[],
  challengerContentHash: string,
): number {
  const createdTimes = new Set<number>();
  for (const mission of missions) {
    for (const entry of mission.decisionSnapshot.brainComparison?.evaluations ?? []) {
      if (entry.role === 'challenger' && entry.contentHash === challengerContentHash) {
        requireTimestamp('challenger createdAt', entry.createdAt);
        createdTimes.add(entry.createdAt);
      }
    }
  }
  if (createdTimes.size === 0)
    throw new Error('analysis Challenger is absent from durable Mission evidence');
  if (createdTimes.size !== 1)
    throw new Error('analysis Challenger has inconsistent creation boundaries');
  return [...createdTimes][0] ?? 0;
}

/**
 * Compose aggregate scan evaluation and Champion/Challenger inference under one
 * pre-registered, fixed-cutoff analysis plan.
 *
 * The paired result is deliberately hidden until the fixed analysis cutoff is
 * reached. After that time every re-run uses the same cutoff, preventing evidence
 * accumulation from turning repeated hourly looks into optional stopping. The plan
 * must also be durable before the first forward Mission after Challenger creation.
 * Missing Challenger shadow decisions remain in the denominator via pairingCoverage.
 * This function never promotes a Brain, mutates a registry, or emits execution truth.
 */
export function buildPreRegisteredEvaluation(
  missions: readonly EvaluationPipelineMission[],
  observations: readonly MarketCloseObservation[],
  outcomePolicy: FixedHorizonOutcomePolicy,
  policy: PreRegisteredEvaluationPolicy,
): PreRegisteredEvaluationResult {
  validatePolicy(policy);
  const pipeline = buildMissionEvaluationPipeline(
    missions,
    observations,
    outcomePolicy,
    policy.aggregate,
  );

  const plan = policy.analysisPlan;
  const createdAt = challengerCreationTime(missions, plan.challengerContentHash);
  if (plan.registeredAt < createdAt) {
    throw new Error('analysis plan cannot be registered before Challenger creation');
  }

  for (const mission of missions) {
    const knowledgeTime = missionKnowledgeTime(mission);
    if (knowledgeTime === undefined) continue;
    requireTimestamp('paired mission knowledgeTime', knowledgeTime);
    if (knowledgeTime > createdAt && knowledgeTime <= plan.registeredAt) {
      throw new Error('analysis plan was registered after forward Challenger evidence began');
    }
  }

  if (policy.currentKnowledgeCutoff < plan.analysisCutoff) {
    return {
      aggregateReport: pipeline.report,
      outcomeEvidenceGaps: pipeline.outcomeEvidenceGaps,
      paired: {
        status: 'analysis-window-open',
        planId: plan.planId,
        analysisCutoff: plan.analysisCutoff,
      },
    };
  }

  const eligible = missions.filter((mission) => {
    const knowledgeTime = missionKnowledgeTime(mission);
    return (
      knowledgeTime !== undefined &&
      knowledgeTime > plan.registeredAt &&
      knowledgeTime <= plan.analysisCutoff
    );
  });
  const pairedMissions = eligible.filter((mission) =>
    hasTargetChallenger(mission, plan.challengerContentHash),
  );
  const missingPairedMissionIds = eligible
    .filter((mission) => !hasTargetChallenger(mission, plan.challengerContentHash))
    .map((mission) => mission.missionId);
  const pairingCoverage = eligible.length === 0 ? 0 : pairedMissions.length / eligible.length;
  const reasons: string[] = [];
  if (pairingCoverage < plan.minimumPairingCoverage)
    reasons.push('minimum-pairing-coverage-not-met');
  if (pairedMissions.length === 0) reasons.push('paired-population-empty');

  let inference: PairedOutcomeInferenceReport | null = null;
  if (pairedMissions.length > 0) {
    const allPairs = projectDurableMissionsForPairedEvaluation(pairedMissions);
    const pairs = allPairs.filter(
      (pair) => pair.challenger.brainContentHash === plan.challengerContentHash,
    );
    if (pairs.length !== pairedMissions.length) {
      throw new Error(
        'target Challenger projection is not one-to-one with paired Mission evidence',
      );
    }
    const pairedMissionIds = new Set(pairs.map((pair) => pair.missionId));
    const labels: VersionedMarketOutcomeLabel[] = pipeline.labels.filter((label) =>
      pairedMissionIds.has(label.missionId),
    );
    inference = inferForwardPairedOutcomeAlignment(pairs, labels, {
      ...policy.paired,
      evaluationCutoff: plan.analysisCutoff,
    });
    reasons.push(...inference.reasons);
  }

  return {
    aggregateReport: pipeline.report,
    outcomeEvidenceGaps: pipeline.outcomeEvidenceGaps,
    paired: {
      status: reasons.length === 0 ? 'ready' : 'insufficient-data',
      planId: plan.planId,
      analysisCutoff: plan.analysisCutoff,
      pairingCoverage,
      eligiblePairedPopulation: eligible.length,
      observedPairedPopulation: pairedMissions.length,
      missingPairedMissionIds,
      reasons,
      inference,
    },
  };
}
