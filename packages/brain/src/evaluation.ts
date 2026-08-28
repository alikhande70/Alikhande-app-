export interface ScanDecisionEvidence {
  readonly missionId: string;
  readonly scanConfigVersion: string;
  readonly knowledgeTime: number;
  readonly brainContentHash: string;
  readonly brainVersion: string;
  readonly decision:
    | { readonly status: 'scored'; readonly score: number }
    | { readonly status: 'insufficient-data'; readonly missing: readonly string[] };
  readonly outcome?: ScanOutcomeEvidence;
}

export interface ScanOutcomeEvidence {
  /** Time the future market outcome became valid. Must be strictly after the decision. */
  readonly validAt: number;
  /** Time the system learned the outcome. */
  readonly recordedAt: number;
  /** Directional market label derived from market data, never operator review. */
  readonly directional: 'favourable' | 'unfavourable' | 'flat';
  /** Optional market-only counterfactual R; never account P&L. */
  readonly counterfactualR?: number;
  /** Optional realised trade R. Kept separate from scan-level market outcome. */
  readonly realisedTradeR?: number;
}

export interface EvaluationPolicy {
  readonly minimumScans: number;
  readonly minimumOutcomes: number;
  readonly evaluationCutoff: number;
}

export interface DecisionQualitySummary {
  readonly totalScans: number;
  readonly scoredScans: number;
  readonly insufficientDataScans: number;
  readonly coverage: number;
  readonly meanScore: number | null;
}

export interface OutcomeSummary {
  readonly eligibleOutcomes: number;
  readonly favourable: number;
  readonly unfavourable: number;
  readonly flat: number;
  readonly meanCounterfactualR: number | null;
  readonly realisedTrades: number;
  readonly meanRealisedTradeR: number | null;
}

export interface ScanEvaluationReport {
  readonly status: 'ready' | 'insufficient-data';
  readonly reasons: readonly string[];
  readonly cohort: { readonly scanConfigVersion: string; readonly brainContentHash: string };
  readonly decisionQuality: DecisionQualitySummary;
  readonly outcomes: OutcomeSummary;
}

function requireFiniteTimestamp(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${name} must be a finite non-negative timestamp`);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function validatePolicy(policy: EvaluationPolicy): void {
  if (!Number.isInteger(policy.minimumScans) || policy.minimumScans < 1) {
    throw new Error('minimumScans must be a positive integer');
  }
  if (!Number.isInteger(policy.minimumOutcomes) || policy.minimumOutcomes < 1) {
    throw new Error('minimumOutcomes must be a positive integer');
  }
  requireFiniteTimestamp('evaluationCutoff', policy.evaluationCutoff);
}

function validateScan(scan: ScanDecisionEvidence): void {
  if (scan.missionId.trim().length === 0) throw new Error('missionId is required');
  if (scan.scanConfigVersion.trim().length === 0) throw new Error('scanConfigVersion is required');
  if (scan.brainVersion.trim().length === 0) throw new Error('brainVersion is required');
  if (!/^sha256:[a-f0-9]{64}$/.test(scan.brainContentHash)) {
    throw new Error(`invalid Brain content hash for mission '${scan.missionId}'`);
  }
  requireFiniteTimestamp('knowledgeTime', scan.knowledgeTime);

  if (scan.decision.status === 'scored') {
    if (
      !Number.isFinite(scan.decision.score) ||
      scan.decision.score < 0 ||
      scan.decision.score > 100
    ) {
      throw new Error(`invalid score for mission '${scan.missionId}'`);
    }
  } else if (scan.decision.missing.length === 0) {
    throw new Error(`insufficient-data mission '${scan.missionId}' must name missing evidence`);
  }

  if (scan.outcome === undefined) return;
  requireFiniteTimestamp('outcome.validAt', scan.outcome.validAt);
  requireFiniteTimestamp('outcome.recordedAt', scan.outcome.recordedAt);
  if (scan.outcome.validAt <= scan.knowledgeTime) {
    throw new Error(`outcome for mission '${scan.missionId}' is not strictly forward`);
  }
  if (scan.outcome.recordedAt < scan.outcome.validAt) {
    throw new Error(`outcome for mission '${scan.missionId}' was recorded before it became valid`);
  }
  for (const [name, value] of [
    ['counterfactualR', scan.outcome.counterfactualR],
    ['realisedTradeR', scan.outcome.realisedTradeR],
  ] as const) {
    if (value !== undefined && !Number.isFinite(value)) {
      throw new Error(`${name} for mission '${scan.missionId}' must be finite`);
    }
  }
}

/**
 * Deterministic ADR-0021 scan-population evaluator.
 *
 * Decision evidence and future outcomes are intentionally reported as separate
 * structures. A profitable trade cannot retroactively make a decision "good", and an
 * unprofitable trade cannot retroactively make it "bad". Brain scores are rubric
 * scores, not probabilities, so this layer deliberately does not compute Brier/ECE
 * from them.
 */
export function evaluateScanPopulation(
  scans: readonly ScanDecisionEvidence[],
  policy: EvaluationPolicy,
): ScanEvaluationReport {
  validatePolicy(policy);
  if (scans.length === 0) throw new Error('scan population is required');

  const seen = new Set<string>();
  for (const scan of scans) {
    validateScan(scan);
    if (seen.has(scan.missionId)) throw new Error(`duplicate mission '${scan.missionId}'`);
    seen.add(scan.missionId);
  }

  const scanConfigVersions = new Set(scans.map((scan) => scan.scanConfigVersion));
  if (scanConfigVersions.size !== 1)
    throw new Error('evaluation requires one scan configuration cohort');
  const hashes = new Set(scans.map((scan) => scan.brainContentHash));
  if (hashes.size !== 1) throw new Error('evaluation requires one immutable Brain content hash');

  const scored = scans.filter((scan) => scan.decision.status === 'scored');
  const scoreValues = scored.map((scan) => {
    if (scan.decision.status !== 'scored') throw new Error('unreachable decision status');
    return scan.decision.score;
  });

  const eligibleOutcomes = scans
    .filter(
      (scan) => scan.outcome !== undefined && scan.outcome.recordedAt <= policy.evaluationCutoff,
    )
    .map((scan) => scan.outcome as ScanOutcomeEvidence);
  const counterfactualR = eligibleOutcomes.flatMap((outcome) =>
    outcome.counterfactualR === undefined ? [] : [outcome.counterfactualR],
  );
  const realisedTradeR = eligibleOutcomes.flatMap((outcome) =>
    outcome.realisedTradeR === undefined ? [] : [outcome.realisedTradeR],
  );

  const reasons: string[] = [];
  if (scans.length < policy.minimumScans) reasons.push('minimum-scan-population-not-met');
  if (eligibleOutcomes.length < policy.minimumOutcomes)
    reasons.push('minimum-forward-outcomes-not-met');

  return {
    status: reasons.length === 0 ? 'ready' : 'insufficient-data',
    reasons,
    cohort: {
      scanConfigVersion: scans[0]?.scanConfigVersion ?? '',
      brainContentHash: scans[0]?.brainContentHash ?? '',
    },
    decisionQuality: {
      totalScans: scans.length,
      scoredScans: scored.length,
      insufficientDataScans: scans.length - scored.length,
      coverage: scored.length / scans.length,
      meanScore: mean(scoreValues),
    },
    outcomes: {
      eligibleOutcomes: eligibleOutcomes.length,
      favourable: eligibleOutcomes.filter((outcome) => outcome.directional === 'favourable').length,
      unfavourable: eligibleOutcomes.filter((outcome) => outcome.directional === 'unfavourable')
        .length,
      flat: eligibleOutcomes.filter((outcome) => outcome.directional === 'flat').length,
      meanCounterfactualR: mean(counterfactualR),
      realisedTrades: realisedTradeR.length,
      meanRealisedTradeR: mean(realisedTradeR),
    },
  };
}
