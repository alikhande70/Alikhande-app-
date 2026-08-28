import {
  buildScanDependenceReport,
  type ScanDependencePolicy,
  type ScanDependenceReport,
} from './dependence-guard.js';
import type { FixedHorizonOutcomePolicy, MarketCloseObservation } from './outcome-labeling.js';
import {
  buildPreRegisteredEvaluationFromDurablePopulation,
  type DurableEvaluationPopulation,
  type DurablePairedEligibility,
  type PreRegisteredEvaluationPolicy,
  type PreRegisteredEvaluationResult,
  type PreRegisteredPairedAnalysisPlan,
} from './pre-registered-evaluation.js';

export interface DurableDependenceEligibility extends DurablePairedEligibility {
  readonly canonical: string;
}

export interface DependenceAwareEvaluationPopulation
  extends Omit<DurableEvaluationPopulation, 'pairedEligibility'> {
  readonly pairedEligibility: readonly DurableDependenceEligibility[];
}

export interface DependenceAwareAnalysisPlan extends PreRegisteredPairedAnalysisPlan {
  /** Fixed before forward evidence; changing this defines a different analysis plan. */
  readonly dependence: ScanDependencePolicy;
}

export interface DependenceAwareEvaluationPolicy
  extends Omit<PreRegisteredEvaluationPolicy, 'analysisPlan'> {
  readonly analysisPlan: DependenceAwareAnalysisPlan;
}

export interface DependenceAwareEvaluationResult extends PreRegisteredEvaluationResult {
  /** Hidden while the fixed analysis window is still open. */
  readonly dependence: ScanDependenceReport | null;
}

function validateCanonicalIdentity(population: DependenceAwareEvaluationPopulation): void {
  const missionById = new Map(population.missions.map((mission) => [mission.missionId, mission]));
  for (const item of population.pairedEligibility) {
    if (item.canonical.trim().length === 0) {
      throw new Error(`dependence canonical is required for '${item.missionId}'`);
    }
    const mission = missionById.get(item.missionId);
    if (mission !== undefined && mission.canonical !== item.canonical) {
      throw new Error(`dependence canonical identity drift for '${item.missionId}'`);
    }
  }
}

/**
 * Preferred ADR-0021 top-level evaluation boundary when durable Desk population is available.
 *
 * The existing fixed-look evaluator remains the source of aggregate and paired outcome
 * inference. This wrapper adds a conservative dependence gate derived only from immutable
 * scan identity, canonical instrument and ledger knowledge-time. A large number of scans in
 * one continuing market episode can therefore never make the overall paired result `ready`.
 *
 * The nested scan-level inference is retained as a diagnostic and must not be interpreted as
 * promotion eligibility when the returned paired status is `insufficient-data`.
 */
export function buildDependenceAwarePreRegisteredEvaluation(
  population: DependenceAwareEvaluationPopulation,
  observations: readonly MarketCloseObservation[],
  outcomePolicy: FixedHorizonOutcomePolicy,
  policy: DependenceAwareEvaluationPolicy,
): DependenceAwareEvaluationResult {
  validateCanonicalIdentity(population);
  const base = buildPreRegisteredEvaluationFromDurablePopulation(
    population,
    observations,
    outcomePolicy,
    policy,
  );

  if (base.paired.status === 'analysis-window-open') {
    return { ...base, dependence: null };
  }

  const plan = policy.analysisPlan;
  const eligible = population.pairedEligibility.filter(
    (item) => item.knownAt > plan.registeredAt && item.knownAt <= plan.analysisCutoff,
  );
  const dependence = buildScanDependenceReport(
    eligible.map((item) => ({
      missionId: item.missionId,
      canonical: item.canonical,
      knownAt: item.knownAt,
    })),
    plan.dependence,
  );

  if (dependence.status === 'ready') return { ...base, dependence };

  const reasons = [...new Set([...base.paired.reasons, ...dependence.reasons])];
  return {
    ...base,
    dependence,
    paired: {
      ...base.paired,
      status: 'insufficient-data',
      reasons,
    },
  };
}
