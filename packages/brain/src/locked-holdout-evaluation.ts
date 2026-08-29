import { createHash } from 'node:crypto';
import {
  buildFinalPreRegisteredEvaluation,
  type FinalEvaluationPopulation,
  type FinalEvaluationResult,
  type ResearchSafeFinalEvaluationPolicy,
  validateFinalEvaluationComposition,
} from './evaluation-composition.js';
import {
  auditLockedHoldout,
  type LeakageWindowAssignment,
  type LockedHoldoutAccessReceipt,
  partitionLeakageWindows,
} from './leakage-window-guard.js';
import type { FixedHorizonOutcomePolicy, MarketCloseObservation } from './outcome-labeling.js';

export const LOCKED_HOLDOUT_EVALUATION_VERSION = 'locked-holdout-evaluation:v1' as const;

export interface LockedHoldoutPopulationSeal {
  readonly version: typeof LOCKED_HOLDOUT_EVALUATION_VERSION;
  readonly holdoutId: string;
  readonly questionId: string;
  readonly populationHash: string;
  readonly populationCount: number;
  readonly ledgerHead: Readonly<{ seq: number; hash: string }>;
  readonly holdoutStartAt: number;
  readonly holdoutEndAt: number;
}

export interface LockedHoldoutEvaluationAudit extends LockedHoldoutPopulationSeal {
  readonly receiptOpenedAt: number;
  readonly evaluationCutoff: number;
  readonly accessCount: 1;
  /** Explicitly observational: this boundary never mutates champion/challenger registry state. */
  readonly promotionAction: 'none';
}

export interface LockedHoldoutEvaluationResult extends FinalEvaluationResult {
  readonly lockedHoldout: LockedHoldoutEvaluationAudit;
}

function canonicalHoldoutRows(
  population: FinalEvaluationPopulation,
  assignments: readonly LeakageWindowAssignment[],
): readonly Readonly<{
  missionId: string;
  canonical: string;
  scanConfigVersion: string;
  observedAt: number;
  knownAt: number;
}>[] {
  const holdoutIds = new Set(
    assignments.filter((item) => item.disposition === 'holdout').map((item) => item.missionId),
  );
  return population.pairedEligibility
    .filter((item) => holdoutIds.has(item.missionId))
    .map((item) => ({
      missionId: item.missionId,
      canonical: item.canonical,
      scanConfigVersion: item.scanConfigVersion,
      observedAt: item.observedAt,
      knownAt: item.knownAt,
    }))
    .sort(
      (left, right) =>
        left.observedAt - right.observedAt || left.missionId.localeCompare(right.missionId),
    );
}

function computePopulationHash(
  population: FinalEvaluationPopulation,
  assignments: readonly LeakageWindowAssignment[],
  policy: ResearchSafeFinalEvaluationPolicy,
): string {
  const plan = policy.analysisPlan.leakageWindow;
  const payload = {
    version: LOCKED_HOLDOUT_EVALUATION_VERSION,
    holdoutId: plan.holdoutId,
    questionId: plan.questionId,
    ledgerHead: population.ledgerHead,
    holdoutStartAt: plan.holdoutStartAt,
    holdoutEndAt: plan.holdoutEndAt,
    rows: canonicalHoldoutRows(population, assignments),
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

function partitionValidatedPopulation(
  population: FinalEvaluationPopulation,
  outcomePolicy: FixedHorizonOutcomePolicy,
  policy: ResearchSafeFinalEvaluationPolicy,
): readonly LeakageWindowAssignment[] {
  validateFinalEvaluationComposition(population, outcomePolicy, policy);
  const plan = policy.analysisPlan.leakageWindow;
  if (plan.labelHorizonMs !== outcomePolicy.horizonMs) {
    throw new Error('leakage-window label horizon must match the registered outcome horizon');
  }
  return partitionLeakageWindows(
    population.pairedEligibility.map(({ missionId, observedAt, knownAt }) => ({
      missionId,
      observedAt,
      knownAt,
    })),
    plan,
  );
}

/**
 * Describe the exact sealed holdout population without revealing identities, scores or outcomes.
 *
 * The returned hash is suitable for a durable access receipt. Computing it is not an evaluation and
 * therefore does not consume the holdout question.
 */
export function sealLockedHoldoutPopulation(
  population: FinalEvaluationPopulation,
  outcomePolicy: FixedHorizonOutcomePolicy,
  policy: ResearchSafeFinalEvaluationPolicy,
): LockedHoldoutPopulationSeal {
  const assignments = partitionValidatedPopulation(population, outcomePolicy, policy);
  const plan = policy.analysisPlan.leakageWindow;
  if (policy.currentKnowledgeCutoff < plan.holdoutEndAt) {
    throw new Error(
      'locked holdout population cannot be sealed before the holdout window is complete',
    );
  }
  const populationCount = assignments.filter((item) => item.disposition === 'holdout').length;
  if (populationCount === 0) throw new Error('locked holdout population is empty');
  return {
    version: LOCKED_HOLDOUT_EVALUATION_VERSION,
    holdoutId: plan.holdoutId,
    questionId: plan.questionId,
    populationHash: computePopulationHash(population, assignments, policy),
    populationCount,
    ledgerHead: population.ledgerHead,
    holdoutStartAt: plan.holdoutStartAt,
    holdoutEndAt: plan.holdoutEndAt,
  };
}

function requireMatchingReceipt(
  seal: LockedHoldoutPopulationSeal,
  policy: ResearchSafeFinalEvaluationPolicy,
  receipts: readonly LockedHoldoutAccessReceipt[],
  assignments: readonly LeakageWindowAssignment[],
): LockedHoldoutAccessReceipt {
  const plan = policy.analysisPlan.leakageWindow;
  auditLockedHoldout(assignments, plan, receipts);
  const matching = receipts.filter(
    (receipt) => receipt.holdoutId === plan.holdoutId && receipt.questionId === plan.questionId,
  );
  if (matching.length !== 1) {
    throw new Error('locked holdout evaluation requires exactly one durable access receipt');
  }
  const receipt = matching[0];
  if (receipt === undefined) throw new Error('locked holdout access receipt disappeared');
  if (receipt.populationHash !== seal.populationHash) {
    throw new Error('locked holdout receipt population hash does not match the sealed population');
  }
  if (receipt.evaluationCutoff !== policy.analysisPlan.analysisCutoff) {
    throw new Error(
      'locked holdout receipt evaluationCutoff must match the registered analysis cutoff',
    );
  }
  if (receipt.openedAt > policy.currentKnowledgeCutoff) {
    throw new Error('locked holdout receipt is not yet known at currentKnowledgeCutoff');
  }
  return receipt;
}

/**
 * One-shot observational evaluation of the exact locked-holdout population.
 *
 * The caller must durably persist a matching access receipt before invoking this function. A second
 * receipt invalidates the question. This function has no registry dependency and cannot promote a
 * challenger automatically regardless of the statistical result.
 */
export function buildLockedHoldoutEvaluation(
  population: FinalEvaluationPopulation,
  observations: readonly MarketCloseObservation[],
  outcomePolicy: FixedHorizonOutcomePolicy,
  policy: ResearchSafeFinalEvaluationPolicy,
  receipts: readonly LockedHoldoutAccessReceipt[],
): LockedHoldoutEvaluationResult {
  const assignments = partitionValidatedPopulation(population, outcomePolicy, policy);
  const seal = sealLockedHoldoutPopulation(population, outcomePolicy, policy);
  const receipt = requireMatchingReceipt(seal, policy, receipts, assignments);
  const holdoutIds = new Set(
    assignments.filter((item) => item.disposition === 'holdout').map((item) => item.missionId),
  );
  const projected: FinalEvaluationPopulation = {
    ledgerHead: population.ledgerHead,
    pairedEligibility: population.pairedEligibility.filter((item) =>
      holdoutIds.has(item.missionId),
    ),
    missions: population.missions.filter((item) => holdoutIds.has(item.missionId)),
    featureMissions: population.featureMissions.filter((item) => holdoutIds.has(item.missionId)),
  };
  const result = buildFinalPreRegisteredEvaluation(projected, observations, outcomePolicy, policy);
  return {
    ...result,
    lockedHoldout: {
      ...seal,
      receiptOpenedAt: receipt.openedAt,
      evaluationCutoff: receipt.evaluationCutoff,
      accessCount: 1,
      promotionAction: 'none',
    },
  };
}
