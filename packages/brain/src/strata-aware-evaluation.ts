import {
  buildDependenceAwarePreRegisteredEvaluation,
  type DependenceAwareAnalysisPlan,
  type DependenceAwareEvaluationPolicy,
  type DependenceAwareEvaluationPopulation,
  type DependenceAwareEvaluationResult,
} from './dependence-aware-evaluation.js';
import {
  assessFeatureStrataCoverage,
  type FeatureStrataEvidence,
  type FeatureStrataPolicy,
  type FeatureStrataReport,
} from './feature-strata-guard.js';
import type { FixedHorizonOutcomePolicy, MarketCloseObservation } from './outcome-labeling.js';

export interface StrataAwareAnalysisPlan extends DependenceAwareAnalysisPlan {
  /** Registered before forward evidence. Uses deterministic decision-time feature evidence only. */
  readonly featureStrata: FeatureStrataPolicy;
}

export interface StrataAwareEvaluationPolicy
  extends Omit<DependenceAwareEvaluationPolicy, 'analysisPlan'> {
  readonly analysisPlan: StrataAwareAnalysisPlan;
}

export interface StrataAwareEvaluationPopulation extends DependenceAwareEvaluationPopulation {
  /** Exact bitemporal feature evidence copied from immutable decision snapshots. */
  readonly featureStrataEvidence: readonly FeatureStrataEvidence[];
}

export interface StrataAwareEvaluationResult extends DependenceAwareEvaluationResult {
  /** Hidden while the pre-registered analysis window remains open. */
  readonly featureStrata: FeatureStrataReport | null;
}

/**
 * Preferred ADR-0021 boundary after dependence and longitudinal maturity.
 *
 * Market-condition coverage is not an AI-generated regime label. The analysis plan pre-registers
 * one deterministic normalized feature and fixed bins, then this wrapper proves that both the full
 * forward scan denominator and the subset driving directional inference are not concentrated in a
 * single feature stratum. Missing/late feature evidence is never imputed and cannot disappear.
 */
export function buildStrataAwarePreRegisteredEvaluation(
  population: StrataAwareEvaluationPopulation,
  observations: readonly MarketCloseObservation[],
  outcomePolicy: FixedHorizonOutcomePolicy,
  policy: StrataAwareEvaluationPolicy,
): StrataAwareEvaluationResult {
  const base = buildDependenceAwarePreRegisteredEvaluation(
    population,
    observations,
    outcomePolicy,
    policy,
  );

  if (base.paired.status === 'analysis-window-open') {
    return { ...base, featureStrata: null };
  }

  const plan = policy.analysisPlan;
  const eligible = population.pairedEligibility.filter(
    (item) => item.knownAt > plan.registeredAt && item.knownAt <= plan.analysisCutoff,
  );
  const eligibleIds = new Set(eligible.map((item) => item.missionId));
  const evidence = population.featureStrataEvidence.filter((item) =>
    eligibleIds.has(item.missionId),
  );
  const decisiveIds = new Set(base.paired.inference?.decisiveDirectionalMissionIds ?? []);
  const featureStrata = assessFeatureStrataCoverage(
    eligible,
    evidence,
    decisiveIds,
    plan.featureStrata,
  );

  if (featureStrata.status === 'ready') return { ...base, featureStrata };

  const reasons = [
    ...new Set([
      ...base.paired.reasons,
      ...featureStrata.reasons.map((reason) => `feature-strata-${reason}`),
    ]),
  ];
  return {
    ...base,
    featureStrata,
    paired: {
      ...base.paired,
      status: 'insufficient-data',
      reasons,
    },
  };
}
