import type { ScanDecisionEvidence, ScanOutcomeEvidence } from './evaluation.js';

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
    readonly brainComparison?: {
      readonly missionKnowledgeTime: number;
      readonly championHash: `sha256:${string}`;
    };
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
    if (snapshot.brainEvaluation.knowledgeCutoff !== snapshot.brainComparison.missionKnowledgeTime) {
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
