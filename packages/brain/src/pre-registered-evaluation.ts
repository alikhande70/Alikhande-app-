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
  readonly planId: string;
  readonly challengerContentHash: `sha256:${string}`;
  readonly registeredAt: number;
  readonly analysisCutoff: number;
  readonly minimumPairingCoverage: number;
}

export interface PreRegisteredEvaluationPolicy {
  readonly currentKnowledgeCutoff: number;
  readonly aggregate: EvaluationPolicy;
  readonly paired: Omit<PairedOutcomeInferencePolicy, 'evaluationCutoff'>;
  readonly analysisPlan: PreRegisteredPairedAnalysisPlan;
}

/** Structural input emitted by Desk's hash-verified Mission ledger projection. */
export interface DurablePairedEligibility {
  readonly missionId: string;
  readonly scanConfigVersion: string;
  readonly observedAt: number;
  /** Knowledge-time when the scan became durable/known to the system. */
  readonly knownAt: number;
}

/**
 * Structural population contract. Brain deliberately does not import Desk code;
 * Desk remains execution truth owner while this package consumes immutable facts.
 */
export interface DurableEvaluationPopulation {
  readonly missions: readonly EvaluationPipelineMission[];
  readonly pairedEligibility: readonly DurablePairedEligibility[];
  readonly ledgerHead: Readonly<{ seq: number; hash: string }>;
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

function validateEligibility(
  eligibility: readonly DurablePairedEligibility[],
  missions: readonly EvaluationPipelineMission[],
): void {
  const byMissionId = new Map<string, DurablePairedEligibility>();
  for (const item of eligibility) {
    if (item.missionId.trim().length === 0)
      throw new Error('paired eligibility missionId is required');
    if (item.scanConfigVersion.trim().length === 0)
      throw new Error(`paired eligibility scanConfigVersion is required for '${item.missionId}'`);
    requireTimestamp('paired eligibility observedAt', item.observedAt);
    requireTimestamp('paired eligibility knownAt', item.knownAt);
    if (item.knownAt < item.observedAt) {
      throw new Error(`paired eligibility '${item.missionId}' was known before it was valid`);
    }
    if (byMissionId.has(item.missionId)) {
      throw new Error(`duplicate paired eligibility '${item.missionId}'`);
    }
    byMissionId.set(item.missionId, item);
  }

  for (const mission of missions) {
    const item = byMissionId.get(mission.missionId);
    if (item === undefined) {
      throw new Error(`evaluated mission '${mission.missionId}' is absent from paired eligibility`);
    }
    if (item.scanConfigVersion !== mission.scanConfigVersion) {
      throw new Error(`paired eligibility scan configuration drift for '${mission.missionId}'`);
    }
    if (item.observedAt !== mission.observedAt) {
      throw new Error(`paired eligibility observation-time drift for '${mission.missionId}'`);
    }
  }
}

function deriveEligibility(
  missions: readonly EvaluationPipelineMission[],
): readonly DurablePairedEligibility[] {
  return missions.map((mission) => ({
    missionId: mission.missionId,
    scanConfigVersion: mission.scanConfigVersion,
    observedAt: mission.observedAt,
    knownAt: missionKnowledgeTime(mission) ?? mission.observedAt,
  }));
}

function composePreRegisteredEvaluation(
  missions: readonly EvaluationPipelineMission[],
  eligibility: readonly DurablePairedEligibility[],
  observations: readonly MarketCloseObservation[],
  outcomePolicy: FixedHorizonOutcomePolicy,
  policy: PreRegisteredEvaluationPolicy,
): PreRegisteredEvaluationResult {
  validatePolicy(policy);
  validateEligibility(eligibility, missions);
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

  const eligible = eligibility.filter(
    (item) => item.knownAt > plan.registeredAt && item.knownAt <= plan.analysisCutoff,
  );
  const eligibleScanConfigs = new Set(eligible.map((item) => item.scanConfigVersion));
  if (eligibleScanConfigs.size > 1) {
    throw new Error('paired eligibility requires one scan configuration cohort');
  }

  const eligibleIds = new Set(eligible.map((item) => item.missionId));
  const pairedMissions = missions.filter(
    (mission) =>
      eligibleIds.has(mission.missionId) &&
      hasTargetChallenger(mission, plan.challengerContentHash),
  );
  const pairedIds = new Set(pairedMissions.map((mission) => mission.missionId));
  const missingPairedMissionIds = eligible
    .filter((item) => !pairedIds.has(item.missionId))
    .map((item) => item.missionId)
    .sort();
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

/**
 * Backward-compatible composition for callers that only possess sealed Mission
 * decisions. Prefer `buildPreRegisteredEvaluationFromDurablePopulation` when a
 * hash-verified Desk population is available so missing comparison scans remain in
 * the denominator.
 */
export function buildPreRegisteredEvaluation(
  missions: readonly EvaluationPipelineMission[],
  observations: readonly MarketCloseObservation[],
  outcomePolicy: FixedHorizonOutcomePolicy,
  policy: PreRegisteredEvaluationPolicy,
): PreRegisteredEvaluationResult {
  return composePreRegisteredEvaluation(
    missions,
    deriveEligibility(missions),
    observations,
    outcomePolicy,
    policy,
  );
}

/**
 * Preferred ADR-0021 composition boundary.
 *
 * The denominator comes from every internal scan in Desk's verified ledger
 * projection, not only Missions that successfully persisted `brainComparison`.
 * Missing/failed Challenger shadow decisions therefore reduce pairing coverage
 * instead of disappearing. No score, comparison, broker truth, or AI conclusion is
 * synthesized for those scans.
 */
export function buildPreRegisteredEvaluationFromDurablePopulation(
  population: DurableEvaluationPopulation,
  observations: readonly MarketCloseObservation[],
  outcomePolicy: FixedHorizonOutcomePolicy,
  policy: PreRegisteredEvaluationPolicy,
): PreRegisteredEvaluationResult {
  if (!Number.isInteger(population.ledgerHead.seq) || population.ledgerHead.seq < 0) {
    throw new Error('durable population ledger head seq must be a non-negative integer');
  }
  if (population.ledgerHead.hash.trim().length === 0) {
    throw new Error('durable population ledger head hash is required');
  }
  return composePreRegisteredEvaluation(
    population.missions,
    population.pairedEligibility,
    observations,
    outcomePolicy,
    policy,
  );
}
