import {
  buildScanDependenceReport,
  type ScanDependencePolicy,
  type ScanDependenceReport,
} from './dependence-guard.js';
import {
  type EpisodeBalancedInferenceReport,
  inferEpisodeBalancedAlignment,
} from './episode-balanced-inference.js';
import {
  assessLongitudinalMaturity,
  type LongitudinalMaturityPolicy,
  type LongitudinalMaturityReport,
} from './longitudinal-maturity.js';
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
  /** Prevents a handful of episodes from one short-lived condition claiming mature evidence. */
  readonly maturity: LongitudinalMaturityPolicy;
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
  /**
   * Authoritative dependence-adjusted direction when available. Scan-level Wilson output inside
   * `paired.inference` remains diagnostic and must not override this episode-balanced result.
   */
  readonly episodeBalancedInference: EpisodeBalancedInferenceReport | null;
  /** Longitudinal readiness of the decisive market episodes, fixed by the registered plan. */
  readonly longitudinalMaturity: LongitudinalMaturityReport | null;
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
 * diagnostics. This wrapper adds conservative dependence and longitudinal-maturity gates derived
 * only from immutable scan identity, canonical instrument and market observation time. Ledger
 * knowledge-time still controls eligibility for the pre-registered analysis window, while
 * `observedAt` controls both episode membership and evidence age.
 *
 * Both the full eligible population and the subset that actually drives directional inference
 * must span the pre-registered minimum number of episodes. Decisive per-Mission alignment is then
 * reduced to at most one equal-weight vote per episode. Finally those decisive episodes must span
 * the registered duration and fixed maturity buckets. The episode-balanced result is the
 * dependence-adjusted statistical direction; it never promotes or mutates a Brain version.
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
    return {
      ...base,
      dependence: null,
      directionalDependence: null,
      episodeBalancedInference: null,
      longitudinalMaturity: null,
    };
  }

  const plan = policy.analysisPlan;
  const eligible = population.pairedEligibility.filter(
    (item) => item.knownAt > plan.registeredAt && item.knownAt <= plan.analysisCutoff,
  );
  const dependenceEvidence = eligible.map((item) => ({
    missionId: item.missionId,
    canonical: item.canonical,
    observedAt: item.observedAt,
    knownAt: item.knownAt,
  }));
  const dependence = buildScanDependenceReport(dependenceEvidence, plan.dependence);
  const decisiveIds = new Set(base.paired.inference?.decisiveDirectionalMissionIds ?? []);
  const directionalDependence = buildScanDependenceReport(
    dependenceEvidence.filter((item) => decisiveIds.has(item.missionId)),
    plan.dependence,
  );
  const episodeBalancedInference =
    base.paired.inference === null
      ? null
      : inferEpisodeBalancedAlignment(
          base.paired.inference.decisiveDirectionalEvidence,
          directionalDependence.episodes,
          { minimumDecisiveEpisodes: plan.dependence.minimumIndependentEpisodes },
        );
  const longitudinalMaturity = assessLongitudinalMaturity(
    directionalDependence.episodes,
    plan.maturity,
  );

  if (
    dependence.status === 'ready' &&
    directionalDependence.status === 'ready' &&
    longitudinalMaturity.status === 'ready' &&
    (episodeBalancedInference === null || episodeBalancedInference.status === 'ready')
  ) {
    return {
      ...base,
      dependence,
      directionalDependence,
      episodeBalancedInference,
      longitudinalMaturity,
    };
  }

  const reasons = [
    ...new Set([
      ...base.paired.reasons,
      ...dependence.reasons,
      ...directionalDependence.reasons.map((reason) => `directional-${reason}`),
      ...longitudinalMaturity.reasons.map((reason) => `maturity-${reason}`),
      ...(episodeBalancedInference?.reasons.map((reason) => `episode-balanced-${reason}`) ?? []),
    ]),
  ];
  return {
    ...base,
    dependence,
    directionalDependence,
    episodeBalancedInference,
    longitudinalMaturity,
    paired: {
      ...base.paired,
      status: 'insufficient-data',
      reasons,
    },
  };
}
