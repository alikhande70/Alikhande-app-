import type { ScanDecisionEvidence, ScanOutcomeEvidence } from './evaluation.js';
import type { ForwardPairedScanEvidence } from './paired-evaluation.js';

export interface DurableBrainDecisionForEvaluation {
  readonly status: 'scored' | 'insufficient-data';
  readonly brainVersion: string;
  readonly knowledgeCutoff: number;
  readonly decisionAsOf?: number;
  readonly score?: number;
  readonly missing?: readonly string[];
}

export interface DurableBrainPairedEvaluationForEvaluation {
  readonly contentHash: `sha256:${string}`;
  readonly role: 'champion' | 'challenger';
  readonly createdAt: number;
  readonly evaluation: DurableBrainDecisionForEvaluation;
}

export interface DurableBrainComparisonForEvaluation {
  readonly missionKnowledgeTime: number;
  readonly championHash: `sha256:${string}`;
  readonly evaluations?: readonly DurableBrainPairedEvaluationForEvaluation[];
}

export interface DurableMissionForEvaluation {
  readonly missionId: string;
  readonly scanConfigVersion: string;
  readonly observedAt: number;
  readonly decisionSnapshot?: {
    readonly asOf: number;
    readonly brainEvaluation?:
      | {
          readonly status: 'scored';
          readonly brainVersion: string;
          readonly knowledgeCutoff: number;
          readonly score: number;
        }
      | {
          readonly status: 'insufficient-data';
          readonly brainVersion: string;
          readonly knowledgeCutoff: number;
          readonly missing: readonly string[];
        };
    readonly brainComparison?: DurableBrainComparisonForEvaluation;
  };
}

export interface VersionedMarketOutcomeLabel {
  readonly labelVersion: string;
  readonly missionId: string;
  readonly decisionKnowledgeTime: number;
  readonly validAt: number;
  readonly recordedAt: number;
  readonly directional: 'favourable' | 'unfavourable' | 'flat';
  readonly counterfactualR?: number;
  readonly realisedTradeR?: number;
}

function requireFiniteTimestamp(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative timestamp`);
  }
}

function requireContentHash(name: string, value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} is not a valid content hash`);
  }
}

function decisionFromDurable(
  decision: DurableBrainDecisionForEvaluation,
  label: string,
): ScanDecisionEvidence['decision'] {
  if (decision.brainVersion.trim().length === 0) throw new Error(`${label} Brain version is required`);
  requireFiniteTimestamp(`${label}.knowledgeCutoff`, decision.knowledgeCutoff);
  if (decision.decisionAsOf !== undefined) {
    requireFiniteTimestamp(`${label}.decisionAsOf`, decision.decisionAsOf);
    if (decision.decisionAsOf > decision.knowledgeCutoff) {
      throw new Error(`${label} decisionAsOf is after its knowledge cutoff`);
    }
  }

  if (decision.status === 'scored') {
    if (decision.score === undefined || !Number.isFinite(decision.score) || decision.score < 0 || decision.score > 100) {
      throw new Error(`${label} score must be finite and in [0,100]`);
    }
    return { status: 'scored', score: decision.score };
  }

  if (decision.missing === undefined || decision.missing.length === 0) {
    throw new Error(`${label} insufficient-data evidence must name missing fields`);
  }
  return { status: 'insufficient-data', missing: decision.missing };
}

function sameDecision(
  left: ScanDecisionEvidence['decision'],
  right: ScanDecisionEvidence['decision'],
): boolean {
  if (left.status !== right.status) return false;
  if (left.status === 'scored' && right.status === 'scored') return left.score === right.score;
  if (left.status === 'insufficient-data' && right.status === 'insufficient-data') {
    return left.missing.length === right.missing.length && left.missing.every((value, index) => value === right.missing[index]);
  }
  return false;
}

function outcomeForMission(
  missionId: string,
  knowledgeTime: number,
  labels: ReadonlyMap<string, VersionedMarketOutcomeLabel>,
): ScanOutcomeEvidence | undefined {
  const label = labels.get(missionId);
  if (label === undefined) return undefined;
  if (label.labelVersion.trim().length === 0) throw new Error('outcome labelVersion is required');
  if (label.missionId !== missionId) {
    throw new Error(`outcome mission identity mismatch for '${missionId}'`);
  }
  requireFiniteTimestamp('outcome.decisionKnowledgeTime', label.decisionKnowledgeTime);
  requireFiniteTimestamp('outcome.validAt', label.validAt);
  requireFiniteTimestamp('outcome.recordedAt', label.recordedAt);
  if (label.decisionKnowledgeTime !== knowledgeTime) {
    throw new Error(`outcome decision cutoff mismatch for mission '${missionId}'`);
  }
  if (label.validAt <= knowledgeTime) {
    throw new Error(`outcome for mission '${missionId}' is not strictly forward`);
  }
  if (label.recordedAt < label.validAt) {
    throw new Error(`outcome for mission '${missionId}' was recorded before it became valid`);
  }
  return {
    validAt: label.validAt,
    recordedAt: label.recordedAt,
    directional: label.directional,
    ...(label.counterfactualR === undefined ? {} : { counterfactualR: label.counterfactualR }),
    ...(label.realisedTradeR === undefined ? {} : { realisedTradeR: label.realisedTradeR }),
  };
}

/**
 * Project immutable Mission snapshots into ADR-0021 scan evidence.
 *
 * The immutable champion content hash must come from the snapshot's paired Brain
 * evidence. We deliberately refuse to reconstruct it from a mutable registry or a
 * semantic version string. Missions without a sealed deterministic Brain decision
 * are not silently converted into scores.
 */
export function projectDurableMissionsForEvaluation(
  missions: readonly DurableMissionForEvaluation[],
  outcomeLabels: readonly VersionedMarketOutcomeLabel[] = [],
): readonly ScanDecisionEvidence[] {
  const labels = new Map<string, VersionedMarketOutcomeLabel>();
  for (const label of outcomeLabels) {
    if (labels.has(label.missionId)) {
      throw new Error(`duplicate outcome label for '${label.missionId}'`);
    }
    labels.set(label.missionId, label);
  }

  return missions.map((mission) => {
    if (mission.missionId.trim().length === 0) throw new Error('missionId is required');
    if (mission.scanConfigVersion.trim().length === 0) {
      throw new Error('scanConfigVersion is required');
    }
    requireFiniteTimestamp('mission.observedAt', mission.observedAt);
    const snapshot = mission.decisionSnapshot;
    if (snapshot?.brainEvaluation === undefined || snapshot.brainComparison === undefined) {
      throw new Error(`mission '${mission.missionId}' lacks sealed Brain evaluation identity`);
    }
    requireFiniteTimestamp('snapshot.asOf', snapshot.asOf);
    requireFiniteTimestamp('brain.knowledgeCutoff', snapshot.brainEvaluation.knowledgeCutoff);
    requireFiniteTimestamp(
      'comparison.missionKnowledgeTime',
      snapshot.brainComparison.missionKnowledgeTime,
    );
    requireContentHash('comparison.championHash', snapshot.brainComparison.championHash);
    if (
      snapshot.brainEvaluation.knowledgeCutoff !== snapshot.brainComparison.missionKnowledgeTime
    ) {
      throw new Error(`mission '${mission.missionId}' has divergent Brain knowledge cutoffs`);
    }
    if (snapshot.asOf > snapshot.brainEvaluation.knowledgeCutoff) {
      throw new Error(`mission '${mission.missionId}' snapshot is after its knowledge cutoff`);
    }

    const knowledgeTime = snapshot.brainEvaluation.knowledgeCutoff;
    const outcome = outcomeForMission(mission.missionId, knowledgeTime, labels);
    const decision =
      snapshot.brainEvaluation.status === 'scored'
        ? { status: 'scored' as const, score: snapshot.brainEvaluation.score }
        : {
            status: 'insufficient-data' as const,
            missing: snapshot.brainEvaluation.missing,
          };

    return {
      missionId: mission.missionId,
      scanConfigVersion: mission.scanConfigVersion,
      knowledgeTime,
      brainContentHash: snapshot.brainComparison.championHash,
      brainVersion: snapshot.brainEvaluation.brainVersion,
      decision,
      ...(outcome === undefined ? {} : { outcome }),
    };
  });
}

/**
 * Project durable shadow Brain evidence into forward-only paired scan evidence.
 *
 * This projection is deliberately stricter than the aggregate schema: it proves
 * the champion duplicated in `brainEvaluation` still matches the champion entry
 * in `brainComparison`, rejects duplicate immutable identities, and excludes every
 * challenger that did not exist strictly before this Mission knowledge-time.
 * It never selects a winner or mutates registry state.
 */
export function projectDurableMissionsForPairedEvaluation(
  missions: readonly DurableMissionForEvaluation[],
): readonly ForwardPairedScanEvidence[] {
  const pairs: ForwardPairedScanEvidence[] = [];
  const missionIds = new Set<string>();

  for (const mission of missions) {
    if (missionIds.has(mission.missionId)) {
      throw new Error(`duplicate durable mission '${mission.missionId}'`);
    }
    missionIds.add(mission.missionId);
    if (mission.missionId.trim().length === 0) throw new Error('missionId is required');
    if (mission.scanConfigVersion.trim().length === 0) throw new Error('scanConfigVersion is required');

    const snapshot = mission.decisionSnapshot;
    if (snapshot?.brainEvaluation === undefined || snapshot.brainComparison === undefined) {
      throw new Error(`mission '${mission.missionId}' lacks sealed Brain comparison evidence`);
    }
    const comparison = snapshot.brainComparison;
    if (comparison.evaluations === undefined || comparison.evaluations.length === 0) {
      throw new Error(`mission '${mission.missionId}' lacks paired Brain evaluations`);
    }
    requireFiniteTimestamp('snapshot.asOf', snapshot.asOf);
    requireFiniteTimestamp('comparison.missionKnowledgeTime', comparison.missionKnowledgeTime);
    requireContentHash('comparison.championHash', comparison.championHash);
    if (snapshot.brainEvaluation.knowledgeCutoff !== comparison.missionKnowledgeTime) {
      throw new Error(`mission '${mission.missionId}' has divergent Brain knowledge cutoffs`);
    }

    const seenHashes = new Set<string>();
    let champion: DurableBrainPairedEvaluationForEvaluation | undefined;
    const challengers: DurableBrainPairedEvaluationForEvaluation[] = [];

    for (const entry of comparison.evaluations) {
      requireContentHash('comparison evaluation hash', entry.contentHash);
      requireFiniteTimestamp('comparison evaluation createdAt', entry.createdAt);
      if (seenHashes.has(entry.contentHash)) {
        throw new Error(`mission '${mission.missionId}' repeats Brain content '${entry.contentHash}'`);
      }
      seenHashes.add(entry.contentHash);
      if (entry.evaluation.knowledgeCutoff !== comparison.missionKnowledgeTime) {
        throw new Error(`mission '${mission.missionId}' paired evaluation uses a different knowledge cutoff`);
      }
      if (entry.createdAt > comparison.missionKnowledgeTime) {
        throw new Error(`mission '${mission.missionId}' uses Brain content created after the decision cutoff`);
      }
      decisionFromDurable(entry.evaluation, `${entry.role} evaluation`);

      if (entry.role === 'champion') {
        if (champion !== undefined) throw new Error(`mission '${mission.missionId}' has multiple champions`);
        champion = entry;
      } else {
        challengers.push(entry);
      }
    }

    if (champion === undefined) throw new Error(`mission '${mission.missionId}' has no champion evaluation`);
    if (champion.contentHash !== comparison.championHash) {
      throw new Error(`mission '${mission.missionId}' champion hash does not match durable comparison identity`);
    }

    const primaryDecision: ScanDecisionEvidence['decision'] =
      snapshot.brainEvaluation.status === 'scored'
        ? { status: 'scored', score: snapshot.brainEvaluation.score }
        : { status: 'insufficient-data', missing: snapshot.brainEvaluation.missing };
    const championDecision = decisionFromDurable(champion.evaluation, 'champion evaluation');
    if (champion.evaluation.brainVersion !== snapshot.brainEvaluation.brainVersion || !sameDecision(championDecision, primaryDecision)) {
      throw new Error(`mission '${mission.missionId}' champion shadow evidence diverges from primary Brain decision`);
    }

    for (const challenger of challengers) {
      if (comparison.missionKnowledgeTime <= challenger.createdAt) {
        throw new Error(`mission '${mission.missionId}' is not forward-only evidence for challenger '${challenger.contentHash}'`);
      }
      pairs.push({
        missionId: mission.missionId,
        scanConfigVersion: mission.scanConfigVersion,
        knowledgeTime: comparison.missionKnowledgeTime,
        challengerCreatedAt: challenger.createdAt,
        champion: {
          brainContentHash: champion.contentHash,
          brainVersion: champion.evaluation.brainVersion,
          decision: championDecision,
        },
        challenger: {
          brainContentHash: challenger.contentHash,
          brainVersion: challenger.evaluation.brainVersion,
          decision: decisionFromDurable(challenger.evaluation, 'challenger evaluation'),
        },
      });
    }
  }

  return pairs;
}
