import {
  LEAKAGE_WINDOW_GUARD_VERSION,
  type LeakageDisposition,
  type LeakageWindowPlan,
  partitionLeakageWindows,
} from './leakage-window-guard.js';
import type { FixedHorizonOutcomePolicy, MarketCloseObservation } from './outcome-labeling.js';
import {
  buildSnapshotStrataAwarePreRegisteredEvaluation,
  type SnapshotStrataAwareAnalysisPlan,
  type SnapshotStrataAwareEvaluationPolicy,
  type SnapshotStrataAwareEvaluationPopulation,
} from './snapshot-feature-strata.js';
import type { StrataAwareEvaluationResult } from './strata-aware-evaluation.js';

export const EVALUATION_COMPOSITION_VERSION = 'evaluation-composition:v1' as const;

export interface FinalEvaluationAnalysisPlan extends SnapshotStrataAwareAnalysisPlan {
  /** Pins the validation semantics used to compose every ADR-0021 evidence layer. */
  readonly compositionVersion: typeof EVALUATION_COMPOSITION_VERSION;
  /** Fixed before forward evidence so outcome horizon/labels cannot be selected with hindsight. */
  readonly outcome: FixedHorizonOutcomePolicy;
}

export interface FinalEvaluationPolicy
  extends Omit<SnapshotStrataAwareEvaluationPolicy, 'analysisPlan'> {
  readonly analysisPlan: FinalEvaluationAnalysisPlan;
}

export type FinalEvaluationPopulation = SnapshotStrataAwareEvaluationPopulation;

export interface EvaluationCompositionAudit {
  readonly compositionVersion: typeof EVALUATION_COMPOSITION_VERSION;
  readonly ledgerHead: Readonly<{ seq: number; hash: string }>;
  readonly durableScanPopulation: number;
  readonly decisionMissionPopulation: number;
  readonly featureMissionPopulation: number;
  readonly earliestObservedAt: number | null;
  readonly latestObservedAt: number | null;
  readonly latestKnownAt: number | null;
  readonly analysisCutoff: number;
  readonly outcome: FixedHorizonOutcomePolicy;
}

export interface FinalEvaluationResult extends StrataAwareEvaluationResult {
  /** Structural proof that every downstream guard consumed one durable scan identity/timeline. */
  readonly compositionAudit: EvaluationCompositionAudit;
}

export interface ResearchSafeEvaluationAnalysisPlan extends FinalEvaluationAnalysisPlan {
  /** Locked before the holdout starts; ordinary research may never consume non-research windows. */
  readonly leakageWindow: LeakageWindowPlan;
}

export interface ResearchSafeFinalEvaluationPolicy
  extends Omit<FinalEvaluationPolicy, 'analysisPlan'> {
  readonly analysisPlan: ResearchSafeEvaluationAnalysisPlan;
}

export interface ResearchSafeProjectionAudit {
  readonly leakageVersion: typeof LEAKAGE_WINDOW_GUARD_VERSION;
  readonly holdoutId: string;
  readonly questionId: string;
  readonly sourcePopulation: number;
  readonly researchPopulation: number;
  readonly purgedPopulation: number;
  readonly holdoutPopulation: number;
  readonly embargoedPopulation: number;
}

export interface ResearchSafeFinalEvaluationResult extends FinalEvaluationResult {
  /** Counts only. Holdout identities/outcomes are never returned by the ordinary research path. */
  readonly researchSafety: ResearchSafeProjectionAudit;
}

function requireUniqueIds(name: string, ids: readonly string[]): Set<string> {
  const seen = new Set<string>();
  for (const id of ids) {
    if (id.trim().length === 0) throw new Error(`${name} contains an empty missionId`);
    if (seen.has(id)) throw new Error(`${name} contains duplicate mission '${id}'`);
    seen.add(id);
  }
  return seen;
}

function requireSameIdentitySet(
  expectedName: string,
  expected: ReadonlySet<string>,
  actualName: string,
  actual: ReadonlySet<string>,
): void {
  for (const id of expected) {
    if (!actual.has(id)) {
      throw new Error(`${actualName} is missing durable scan '${id}' from ${expectedName}`);
    }
  }
  for (const id of actual) {
    if (!expected.has(id)) {
      throw new Error(`${actualName} contains unknown scan '${id}' outside ${expectedName}`);
    }
  }
}

function requireRegisteredOutcomePolicy(
  registered: FixedHorizonOutcomePolicy,
  supplied: FixedHorizonOutcomePolicy,
): void {
  if (
    registered.labelVersion !== supplied.labelVersion ||
    registered.horizonMs !== supplied.horizonMs ||
    registered.flatThresholdR !== supplied.flatThresholdR
  ) {
    throw new Error('outcome policy drift from pre-registered analysis plan');
  }
}

/**
 * Fail-closed structural audit for the final ADR-0021 composition boundary.
 */
export function validateFinalEvaluationComposition(
  population: FinalEvaluationPopulation,
  outcomePolicy: FixedHorizonOutcomePolicy,
  policy: FinalEvaluationPolicy,
): EvaluationCompositionAudit {
  if (policy.analysisPlan.compositionVersion !== EVALUATION_COMPOSITION_VERSION) {
    throw new Error(
      `unsupported evaluation composition version '${policy.analysisPlan.compositionVersion}'`,
    );
  }
  requireRegisteredOutcomePolicy(policy.analysisPlan.outcome, outcomePolicy);
  if (policy.currentKnowledgeCutoff < policy.analysisPlan.registeredAt) {
    throw new Error('current knowledge cannot predate analysis-plan registration');
  }
  if (policy.aggregate.evaluationCutoff !== policy.analysisPlan.analysisCutoff) {
    throw new Error('aggregate and paired evaluation cutoffs must be identical');
  }

  const eligibilityIds = requireUniqueIds(
    'paired eligibility',
    population.pairedEligibility.map((item) => item.missionId),
  );
  const featureIds = requireUniqueIds(
    'feature Mission population',
    population.featureMissions.map((item) => item.missionId),
  );
  const decisionIds = requireUniqueIds(
    'decision Mission population',
    population.missions.map((item) => item.missionId),
  );
  requireSameIdentitySet(
    'paired eligibility',
    eligibilityIds,
    'feature Mission population',
    featureIds,
  );

  const eligibilityById = new Map(
    population.pairedEligibility.map((item) => [item.missionId, item]),
  );
  const featureById = new Map(population.featureMissions.map((item) => [item.missionId, item]));

  for (const id of decisionIds) {
    const eligibility = eligibilityById.get(id);
    if (eligibility === undefined) {
      throw new Error(
        `decision Mission population contains '${id}' outside durable scan population`,
      );
    }
    const mission = population.missions.find((item) => item.missionId === id);
    if (mission === undefined) {
      throw new Error(`decision Mission '${id}' disappeared during validation`);
    }
    if (mission.observedAt !== eligibility.observedAt) {
      throw new Error(`decision Mission observation-time drift for '${id}'`);
    }
  }

  for (const [id, eligibility] of eligibilityById) {
    if (eligibility.knownAt > policy.currentKnowledgeCutoff) {
      throw new Error(`durable scan '${id}' is not yet known at currentKnowledgeCutoff`);
    }
    const featureMission = featureById.get(id);
    if (featureMission === undefined) {
      throw new Error(`feature Mission population is missing durable scan '${id}'`);
    }
    if (featureMission.observedAt !== eligibility.observedAt) {
      throw new Error(`feature Mission observation-time drift for '${id}'`);
    }
  }

  const observed = population.pairedEligibility.map((item) => item.observedAt);
  const known = population.pairedEligibility.map((item) => item.knownAt);
  return {
    compositionVersion: EVALUATION_COMPOSITION_VERSION,
    ledgerHead: population.ledgerHead,
    durableScanPopulation: eligibilityIds.size,
    decisionMissionPopulation: decisionIds.size,
    featureMissionPopulation: featureIds.size,
    earliestObservedAt: observed.length === 0 ? null : Math.min(...observed),
    latestObservedAt: observed.length === 0 ? null : Math.max(...observed),
    latestKnownAt: known.length === 0 ? null : Math.max(...known),
    analysisCutoff: policy.analysisPlan.analysisCutoff,
    outcome: policy.analysisPlan.outcome,
  };
}

export function buildFinalPreRegisteredEvaluation(
  population: FinalEvaluationPopulation,
  observations: readonly MarketCloseObservation[],
  outcomePolicy: FixedHorizonOutcomePolicy,
  policy: FinalEvaluationPolicy,
): FinalEvaluationResult {
  const compositionAudit = validateFinalEvaluationComposition(population, outcomePolicy, policy);
  const result = buildSnapshotStrataAwarePreRegisteredEvaluation(
    population,
    observations,
    outcomePolicy,
    policy,
  );
  return { ...result, compositionAudit };
}

function countDisposition(
  assignments: readonly { disposition: LeakageDisposition }[],
  disposition: LeakageDisposition,
): number {
  return assignments.filter((item) => item.disposition === disposition).length;
}

/**
 * Produce the only population ordinary research evaluation is allowed to see.
 *
 * Classification depends exclusively on immutable scan identity/time plus the pre-registered
 * leakage window. Holdout, purge and embargo Mission identities are removed from all parallel
 * evaluation projections before any outcome labels, Brain scores or statistical diagnostics run.
 */
export function projectResearchSafeEvaluationPopulation(
  population: FinalEvaluationPopulation,
  outcomePolicy: FixedHorizonOutcomePolicy,
  policy: ResearchSafeFinalEvaluationPolicy,
): Readonly<{
  population: FinalEvaluationPopulation;
  audit: ResearchSafeProjectionAudit;
}> {
  validateFinalEvaluationComposition(population, outcomePolicy, policy);
  const plan = policy.analysisPlan.leakageWindow;
  if (plan.labelHorizonMs !== outcomePolicy.horizonMs) {
    throw new Error('leakage-window label horizon must match the registered outcome horizon');
  }

  const assignments = partitionLeakageWindows(
    population.pairedEligibility.map(({ missionId, observedAt, knownAt }) => ({
      missionId,
      observedAt,
      knownAt,
    })),
    plan,
  );
  const researchIds = new Set(
    assignments.filter((item) => item.disposition === 'research').map((item) => item.missionId),
  );

  const projected: FinalEvaluationPopulation = {
    ledgerHead: population.ledgerHead,
    pairedEligibility: population.pairedEligibility.filter((item) =>
      researchIds.has(item.missionId),
    ),
    missions: population.missions.filter((item) => researchIds.has(item.missionId)),
    featureMissions: population.featureMissions.filter((item) => researchIds.has(item.missionId)),
  };

  return {
    population: projected,
    audit: {
      leakageVersion: LEAKAGE_WINDOW_GUARD_VERSION,
      holdoutId: plan.holdoutId,
      questionId: plan.questionId,
      sourcePopulation: assignments.length,
      researchPopulation: researchIds.size,
      purgedPopulation: countDisposition(assignments, 'purged'),
      holdoutPopulation: countDisposition(assignments, 'holdout'),
      embargoedPopulation: countDisposition(assignments, 'embargoed'),
    },
  };
}

/**
 * Research-safe ADR-0021 evaluation boundary.
 *
 * The ordinary evaluator never receives locked-holdout, purged or embargoed Mission rows. Locked
 * holdout consumption remains a separate one-shot promotion-evaluation concern governed by durable
 * access receipts; this function has no receipt parameter and therefore cannot open the holdout.
 */
export function buildResearchSafeFinalEvaluation(
  population: FinalEvaluationPopulation,
  observations: readonly MarketCloseObservation[],
  outcomePolicy: FixedHorizonOutcomePolicy,
  policy: ResearchSafeFinalEvaluationPolicy,
): ResearchSafeFinalEvaluationResult {
  const projected = projectResearchSafeEvaluationPopulation(population, outcomePolicy, policy);
  const result = buildFinalPreRegisteredEvaluation(
    projected.population,
    observations,
    outcomePolicy,
    policy,
  );
  return { ...result, researchSafety: projected.audit };
}
