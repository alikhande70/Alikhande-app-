import type { ScanDecisionEvidence } from './evaluation.js';

export interface PairedDecisionSide {
  readonly brainContentHash: string;
  readonly brainVersion: string;
  readonly decision: ScanDecisionEvidence['decision'];
}

export interface ForwardPairedScanEvidence {
  readonly missionId: string;
  readonly scanConfigVersion: string;
  readonly knowledgeTime: number;
  readonly challengerCreatedAt: number;
  readonly champion: PairedDecisionSide;
  readonly challenger: PairedDecisionSide;
}

export interface PairedEvaluationPolicy {
  readonly minimumPairs: number;
  readonly minimumFullyScoredPairs: number;
  readonly minimumDurationMs: number;
}

export interface ForwardPairedCohortReport {
  readonly status: 'ready' | 'insufficient-data';
  readonly reasons: readonly string[];
  readonly scanConfigVersion: string;
  readonly championHash: string;
  readonly challengerHash: string;
  readonly challengerCreatedAt: number;
  readonly totalPairs: number;
  readonly fullyScoredPairs: number;
  readonly pairsWithInsufficientData: number;
  readonly durationMs: number;
}

function validateTimestamp(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative timestamp`);
  }
}

function validateHash(name: string, value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${name} is not a valid content hash`);
}

function validateDecision(side: PairedDecisionSide, label: string): void {
  validateHash(`${label} hash`, side.brainContentHash);
  if (side.brainVersion.trim().length === 0) throw new Error(`${label} Brain version is required`);
  if (side.decision.status === 'scored') {
    if (
      !Number.isFinite(side.decision.score) ||
      side.decision.score < 0 ||
      side.decision.score > 100
    ) {
      throw new Error(`${label} score must be finite and in [0,100]`);
    }
  } else if (side.decision.missing.length === 0) {
    throw new Error(`${label} insufficient-data evidence must name missing fields`);
  }
}

function validatePolicy(policy: PairedEvaluationPolicy): void {
  if (!Number.isInteger(policy.minimumPairs) || policy.minimumPairs < 1) {
    throw new Error('minimumPairs must be a positive integer');
  }
  if (!Number.isInteger(policy.minimumFullyScoredPairs) || policy.minimumFullyScoredPairs < 1) {
    throw new Error('minimumFullyScoredPairs must be a positive integer');
  }
  if (policy.minimumFullyScoredPairs > policy.minimumPairs) {
    throw new Error('minimumFullyScoredPairs cannot exceed minimumPairs');
  }
  if (!Number.isFinite(policy.minimumDurationMs) || policy.minimumDurationMs < 0) {
    throw new Error('minimumDurationMs must be finite and non-negative');
  }
}

/**
 * Build the forward-only paired evidence cohort required by ADR-0021/0022.
 *
 * This function deliberately does not choose a winner, compute promotion eligibility,
 * mutate the version registry, or interpret Brain scores as probabilities. Its only
 * job is to prove that the paired population is uncontaminated by pre-challenger data
 * and sufficiently large/old for a separately pre-registered statistical analysis.
 */
export function buildForwardPairedCohort(
  evidence: readonly ForwardPairedScanEvidence[],
  policy: PairedEvaluationPolicy,
): ForwardPairedCohortReport {
  validatePolicy(policy);
  if (evidence.length === 0) throw new Error('paired evidence population is required');

  const missionIds = new Set<string>();
  const scanConfigVersions = new Set<string>();
  const championHashes = new Set<string>();
  const challengerHashes = new Set<string>();
  const challengerCreatedTimes = new Set<number>();
  let fullyScoredPairs = 0;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;

  for (const pair of evidence) {
    if (pair.missionId.trim().length === 0) throw new Error('missionId is required');
    if (missionIds.has(pair.missionId)) throw new Error(`duplicate mission '${pair.missionId}'`);
    missionIds.add(pair.missionId);
    if (pair.scanConfigVersion.trim().length === 0)
      throw new Error('scanConfigVersion is required');
    scanConfigVersions.add(pair.scanConfigVersion);

    validateTimestamp('mission knowledgeTime', pair.knowledgeTime);
    validateTimestamp('challenger createdAt', pair.challengerCreatedAt);
    if (pair.knowledgeTime <= pair.challengerCreatedAt) {
      throw new Error(`mission '${pair.missionId}' is not forward-only challenger evidence`);
    }

    validateDecision(pair.champion, 'champion');
    validateDecision(pair.challenger, 'challenger');
    if (pair.champion.brainContentHash === pair.challenger.brainContentHash) {
      throw new Error(`mission '${pair.missionId}' compares identical Brain content`);
    }

    championHashes.add(pair.champion.brainContentHash);
    challengerHashes.add(pair.challenger.brainContentHash);
    challengerCreatedTimes.add(pair.challengerCreatedAt);
    earliest = Math.min(earliest, pair.knowledgeTime);
    latest = Math.max(latest, pair.knowledgeTime);
    if (
      pair.champion.decision.status === 'scored' &&
      pair.challenger.decision.status === 'scored'
    ) {
      fullyScoredPairs += 1;
    }
  }

  if (scanConfigVersions.size !== 1) {
    throw new Error('paired evaluation requires one scan configuration cohort');
  }
  if (championHashes.size !== 1)
    throw new Error('paired evaluation requires one champion content hash');
  if (challengerHashes.size !== 1)
    throw new Error('paired evaluation requires one challenger content hash');
  if (challengerCreatedTimes.size !== 1)
    throw new Error('paired evaluation requires one challenger creation boundary');

  const durationMs = Math.max(0, latest - earliest);
  const reasons: string[] = [];
  if (evidence.length < policy.minimumPairs) reasons.push('minimum-paired-scan-population-not-met');
  if (fullyScoredPairs < policy.minimumFullyScoredPairs)
    reasons.push('minimum-fully-scored-pairs-not-met');
  if (durationMs < policy.minimumDurationMs) reasons.push('minimum-forward-duration-not-met');

  return {
    status: reasons.length === 0 ? 'ready' : 'insufficient-data',
    reasons,
    scanConfigVersion: [...scanConfigVersions][0] ?? '',
    championHash: [...championHashes][0] ?? '',
    challengerHash: [...challengerHashes][0] ?? '',
    challengerCreatedAt: [...challengerCreatedTimes][0] ?? 0,
    totalPairs: evidence.length,
    fullyScoredPairs,
    pairsWithInsufficientData: evidence.length - fullyScoredPairs,
    durationMs,
  };
}
