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
  /** Same guard restricted to the Mission IDs that actually drive directional inference. */
  readonly directionalDependence: ScanDependenceReport | null;
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
 * Both the full eligible population and the subset that actually drives directional inference
 * must span the pre-registered minimum number of episodes. This prevents many quiet/tied scans
 * from disguising the fact that all decisive evidence came from one market move.
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
    return { ...base, dependence: null, directionalDependence: null };
  }

  const plan = policy.analysisPlan;
  const eligible = population.pairedEligibility.filter(
    (item) => item.knownAt > plan.registeredAt && item.knownAt <= plan.analysisCutoff,
  );
  const dependenceEvidence = eligible.map((item) => ({
    missionId: item.missionId,
    canonical: item.canonical,
    knownAt: item.knownAt,
  }));
  const dependence = buildScanDependenceReport(dependenceEvidence, plan.dependence);
  const decisiveIds = new Set(base.paired.inference?.decisiveDirectionalMissionIds ?? []);
  const directionalDependence = buildScanDependenceReport(
    dependenceEvidence.filter((item) => decisiveIds.has(item.missionId)),
    plan.dependence,
  );

  if (dependence.status === 'ready' && directionalDependence.status === 'ready') {
    return { ...base, dependence, directionalDependence };
  }

  const reasons = [
    ...new Set([
      ...base.paired.reasons,
      ...dependence.reasons,
      ...directionalDependence.reasons.map((reason) => `directional-${reason}`),
    ]),
  ];
  return {
    ...base,
    dependence,
    directionalDependence,
    paired: {
      ...base.paired,
      status: 'insufficient-data',
      reasons,
    },
  };
}
