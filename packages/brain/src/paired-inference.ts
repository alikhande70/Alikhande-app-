import type { VersionedMarketOutcomeLabel } from './mission-evaluation.js';
import {
  buildForwardPairedCohort,
  type ForwardPairedCohortReport,
  type ForwardPairedScanEvidence,
  type PairedEvaluationPolicy,
} from './paired-evaluation.js';

export interface PairedOutcomeInferencePolicy extends PairedEvaluationPolicy {
  readonly evaluationCutoff: number;
  /** Fraction of the paired Mission population that must have known future outcomes. */
  readonly minimumOutcomeCoverage: number;
  /** Minimum non-flat, fully-scored, non-tied comparisons required for inference. */
  readonly minimumDirectionalComparisons: number;
}

export interface WilsonInterval95 {
  readonly lower: number;
  readonly upper: number;
}

export interface PairedDirectionalAlignmentEvidence {
  readonly missionId: string;
  readonly aligned: 'challenger' | 'champion';
}

export interface PairedOutcomeInferenceReport {
  readonly status: 'ready' | 'insufficient-data';
  readonly reasons: readonly string[];
  readonly cohort: ForwardPairedCohortReport;
  readonly outcomeLabelVersion: string;
  readonly evaluationCutoff: number;
  readonly outcomeCoverage: number;
  readonly eligibleOutcomePairs: number;
  readonly missingOutcomePairs: number;
  readonly flatOutcomePairs: number;
  readonly incompleteDecisionPairs: number;
  readonly tiedDirectionalPairs: number;
  readonly decisiveDirectionalPairs: number;
  /** Immutable Mission identities behind the non-flat, fully-scored, non-tied evidence. */
  readonly decisiveDirectionalMissionIds: readonly string[];
  /** Per-Mission alignment retained so dependence-aware analysis can aggregate by market episode. */
  readonly decisiveDirectionalEvidence: readonly PairedDirectionalAlignmentEvidence[];
  readonly challengerAlignedPairs: number;
  readonly championAlignedPairs: number;
  readonly challengerAlignmentShare: number | null;
  readonly challengerAlignmentWilson95: WilsonInterval95 | null;
  /** Statistical direction only. This is never a promotion or execution instruction. */
  readonly inference:
    | 'challenger-favouring'
    | 'champion-favouring'
    | 'inconclusive'
    | 'insufficient-data';
}

function requireTimestamp(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative timestamp`);
  }
}

function validatePolicy(policy: PairedOutcomeInferencePolicy): void {
  requireTimestamp('evaluationCutoff', policy.evaluationCutoff);
  if (
    !Number.isFinite(policy.minimumOutcomeCoverage) ||
    policy.minimumOutcomeCoverage < 0 ||
    policy.minimumOutcomeCoverage > 1
  ) {
    throw new Error('minimumOutcomeCoverage must be finite and in [0,1]');
  }
  if (
    !Number.isInteger(policy.minimumDirectionalComparisons) ||
    policy.minimumDirectionalComparisons < 1
  ) {
    throw new Error('minimumDirectionalComparisons must be a positive integer');
  }
}

function wilson95(successes: number, trials: number): WilsonInterval95 {
  if (trials < 1 || successes < 0 || successes > trials) {
    throw new Error('invalid Wilson interval inputs');
  }
  const z = 1.96;
  const z2 = z * z;
  const p = successes / trials;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const half =
    (z / denominator) * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return {
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
  };
}

/**
 * Compare Champion and Challenger against the same immutable forward outcome.
 *
 * Brain scores are ordinal rubric scores, not probabilities. Therefore this analysis
 * asks only which score was directionally better aligned with the later market label:
 * higher is better for a favourable setup outcome, lower is better for an unfavourable
 * setup outcome, flat outcomes are not directional evidence, and equal scores are ties.
 * A fixed Wilson 95% interval expresses scan-level uncertainty without introducing a
 * tunable significance knob. Dependence-aware callers must additionally aggregate this
 * per-Mission alignment by pre-registered market episode before treating the interval as
 * decision-grade evidence. No winner is selected and no registry or execution state mutates.
 */
export function inferForwardPairedOutcomeAlignment(
  evidence: readonly ForwardPairedScanEvidence[],
  outcomeLabels: readonly VersionedMarketOutcomeLabel[],
  policy: PairedOutcomeInferencePolicy,
): PairedOutcomeInferenceReport {
  validatePolicy(policy);
  const cohort = buildForwardPairedCohort(evidence, policy);

  const pairByMission = new Map(evidence.map((pair) => [pair.missionId, pair]));
  const labels = new Map<string, VersionedMarketOutcomeLabel>();
  let labelVersion: string | undefined;

  for (const label of outcomeLabels) {
    if (!pairByMission.has(label.missionId)) {
      throw new Error(`outcome label '${label.missionId}' is outside the paired cohort`);
    }
    if (labels.has(label.missionId)) {
      throw new Error(`duplicate outcome label for '${label.missionId}'`);
    }
    if (label.labelVersion.trim().length === 0) throw new Error('outcome labelVersion is required');
    if (labelVersion !== undefined && label.labelVersion !== labelVersion) {
      throw new Error('paired inference requires one outcome label version');
    }
    labelVersion = label.labelVersion;
    requireTimestamp('outcome.decisionKnowledgeTime', label.decisionKnowledgeTime);
    requireTimestamp('outcome.validAt', label.validAt);
    requireTimestamp('outcome.recordedAt', label.recordedAt);

    const pair = pairByMission.get(label.missionId);
    if (pair === undefined) throw new Error('unreachable paired Mission');
    if (label.decisionKnowledgeTime !== pair.knowledgeTime) {
      throw new Error(`outcome decision cutoff mismatch for mission '${label.missionId}'`);
    }
    if (label.validAt <= pair.knowledgeTime) {
      throw new Error(`outcome for mission '${label.missionId}' is not strictly forward`);
    }
    if (label.recordedAt < label.validAt) {
      throw new Error(
        `outcome for mission '${label.missionId}' was recorded before it became valid`,
      );
    }
    labels.set(label.missionId, label);
  }

  let eligibleOutcomePairs = 0;
  let flatOutcomePairs = 0;
  let incompleteDecisionPairs = 0;
  let tiedDirectionalPairs = 0;
  let challengerAlignedPairs = 0;
  let championAlignedPairs = 0;
  const decisiveDirectionalMissionIds: string[] = [];
  const decisiveDirectionalEvidence: PairedDirectionalAlignmentEvidence[] = [];

  for (const pair of evidence) {
    const label = labels.get(pair.missionId);
    if (label === undefined || label.recordedAt > policy.evaluationCutoff) continue;
    eligibleOutcomePairs += 1;

    if (label.directional === 'flat') {
      flatOutcomePairs += 1;
      continue;
    }
    if (
      pair.champion.decision.status !== 'scored' ||
      pair.challenger.decision.status !== 'scored'
    ) {
      incompleteDecisionPairs += 1;
      continue;
    }

    const championScore = pair.champion.decision.score;
    const challengerScore = pair.challenger.decision.score;
    if (championScore === challengerScore) {
      tiedDirectionalPairs += 1;
      continue;
    }

    decisiveDirectionalMissionIds.push(pair.missionId);
    const challengerAligned =
      label.directional === 'favourable'
        ? challengerScore > championScore
        : challengerScore < championScore;
    if (challengerAligned) {
      challengerAlignedPairs += 1;
      decisiveDirectionalEvidence.push({ missionId: pair.missionId, aligned: 'challenger' });
    } else {
      championAlignedPairs += 1;
      decisiveDirectionalEvidence.push({ missionId: pair.missionId, aligned: 'champion' });
    }
  }

  const decisiveDirectionalPairs = challengerAlignedPairs + championAlignedPairs;
  const outcomeCoverage = eligibleOutcomePairs / evidence.length;
  const reasons = [...cohort.reasons];
  if (outcomeCoverage < policy.minimumOutcomeCoverage) {
    reasons.push('minimum-outcome-coverage-not-met');
  }
  if (decisiveDirectionalPairs < policy.minimumDirectionalComparisons) {
    reasons.push('minimum-directional-comparisons-not-met');
  }

  const interval =
    decisiveDirectionalPairs === 0
      ? null
      : wilson95(challengerAlignedPairs, decisiveDirectionalPairs);
  const challengerAlignmentShare =
    decisiveDirectionalPairs === 0 ? null : challengerAlignedPairs / decisiveDirectionalPairs;

  let inference: PairedOutcomeInferenceReport['inference'] = 'insufficient-data';
  if (reasons.length === 0 && interval !== null) {
    if (interval.lower > 0.5) inference = 'challenger-favouring';
    else if (interval.upper < 0.5) inference = 'champion-favouring';
    else inference = 'inconclusive';
  }

  return {
    status: reasons.length === 0 ? 'ready' : 'insufficient-data',
    reasons,
    cohort,
    outcomeLabelVersion: labelVersion ?? '',
    evaluationCutoff: policy.evaluationCutoff,
    outcomeCoverage,
    eligibleOutcomePairs,
    missingOutcomePairs: evidence.length - eligibleOutcomePairs,
    flatOutcomePairs,
    incompleteDecisionPairs,
    tiedDirectionalPairs,
    decisiveDirectionalPairs,
    decisiveDirectionalMissionIds,
    decisiveDirectionalEvidence,
    challengerAlignedPairs,
    championAlignedPairs,
    challengerAlignmentShare,
    challengerAlignmentWilson95: interval,
    inference,
  };
}
