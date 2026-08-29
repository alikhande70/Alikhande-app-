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
}

export interface FinalEvaluationResult extends StrataAwareEvaluationResult {
  /** Structural proof that every downstream guard consumed one durable scan identity/timeline. */
  readonly compositionAudit: EvaluationCompositionAudit;
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

/**
 * Fail-closed structural audit for the final ADR-0021 composition boundary.
 *
 * The evaluator has several intentionally separate statistical layers, but they must all consume
 * one durable population. This guard prevents a caller from shrinking the denominator for feature
 * coverage, swapping observation timestamps, mixing a different Mission set into outcome
 * evaluation, or evaluating aggregate and paired evidence at different historical cutoffs.
 */
export function validateFinalEvaluationComposition(
  population: FinalEvaluationPopulation,
  policy: FinalEvaluationPolicy,
): EvaluationCompositionAudit {
  if (policy.analysisPlan.compositionVersion !== EVALUATION_COMPOSITION_VERSION) {
    throw new Error(
      `unsupported evaluation composition version '${policy.analysisPlan.compositionVersion}'`,
    );
  }
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
  const featureById = new Map(
    population.featureMissions.map((item) => [item.missionId, item]),
  );

  for (const id of decisionIds) {
    const eligibility = eligibilityById.get(id);
    if (eligibility === undefined) {
      throw new Error(`decision Mission population contains '${id}' outside durable scan population`);
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
  };
}

/**
 * Final ADR-0021 composition boundary.
 *
 * Callers provide one hash-verified Desk projection. Structural identity/timeline consistency is
 * audited before outcome labeling, Champion/Challenger pairing, dependence guards, longitudinal
 * maturity and snapshot-derived feature-strata coverage run. The result remains observational: it
 * never promotes a Challenger, mutates Brain state, emits broker truth, or authorizes execution.
 */
export function buildFinalPreRegisteredEvaluation(
  population: FinalEvaluationPopulation,
  observations: readonly MarketCloseObservation[],
  outcomePolicy: FixedHorizonOutcomePolicy,
  policy: FinalEvaluationPolicy,
): FinalEvaluationResult {
  const compositionAudit = validateFinalEvaluationComposition(population, policy);
  const result = buildSnapshotStrataAwarePreRegisteredEvaluation(
    population,
    observations,
    outcomePolicy,
    policy,
  );
  return { ...result, compositionAudit };
}
