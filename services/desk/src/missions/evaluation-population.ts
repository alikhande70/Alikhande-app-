import type { Ledger } from '../ledger/ledger.js';
import { reduceMission } from './service.js';
import type { DecisionSnapshot, MissionOrigin } from './types.js';

const EXTERNAL_ORIGINS: ReadonlySet<MissionOrigin> = new Set([
  'manual:mt5',
  'pending-activation',
  'external:unknown',
]);

/**
 * Structural boundary consumed by @keel/brain/mission-evaluation.
 *
 * Desk deliberately owns only the durable Mission facts. The Brain package owns
 * scoring/evaluation semantics. Keeping this as a structural contract avoids a
 * second truth store and avoids making the execution host depend on Brain code.
 */
export interface DurableMissionEvaluationView {
  readonly missionId: string;
  readonly scanConfigVersion: string;
  readonly observedAt: number;
  readonly decisionSnapshot: DecisionSnapshot;
}

export interface MissionEvaluationPopulation {
  /** Finalised internal Mission decisions eligible for deterministic evaluation. */
  readonly missions: readonly DurableMissionEvaluationView[];
  /** Internal Missions that exist durably but have not sealed a decision yet. */
  readonly pendingDecisionMissionIds: readonly string[];
  /** Broker/manual Missions remain durable truth but are never credited to a Brain. */
  readonly externalMissionIds: readonly string[];
  /** Ledger head used to build this exact projection. */
  readonly ledgerHead: Readonly<{ seq: number; hash: string }>;
}

function readAllRows(ledger: Ledger): ReturnType<Ledger['read']> {
  const rows: Array<ReturnType<Ledger['read']>[number]> = [];
  let cursor = 0;
  const targetHead = ledger.head.seq;

  while (cursor < targetHead) {
    const page = ledger.read(cursor, 10_000);
    if (page.length === 0) {
      throw new Error(`ledger read stopped at seq ${cursor} before head ${targetHead}`);
    }
    rows.push(...page);
    cursor = page[page.length - 1]!.seq;
  }

  return rows;
}

/**
 * Build the scan-level ADR-0021 population directly from the immutable Desk ledger.
 *
 * No mutable Mission table, cache or current Brain registry participates. External
 * MT5 positions stay visible as an explicit excluded population rather than being
 * silently mixed into Brain statistics. Internal Missions without a sealed Brain
 * decision are also surfaced explicitly so a caller cannot mistake an incomplete
 * population for complete evidence.
 */
export function buildMissionEvaluationPopulation(ledger: Ledger): MissionEvaluationPopulation {
  const integrity = ledger.verifyChain();
  if (!integrity.ok) {
    throw new Error(
      `cannot evaluate an untrusted ledger: seq ${integrity.failedAt}: ${integrity.reason}`,
    );
  }

  const head = ledger.head;
  const observed = new Map<string, number>();

  for (const row of readAllRows(ledger)) {
    if (row.kind !== 'mission.observed') continue;
    const event = row.event;
    if (event.kind !== 'mission.observed') {
      throw new Error(`ledger kind/event mismatch at seq ${row.seq}`);
    }
    const missionId = event.observation.missionId;
    if (observed.has(missionId)) {
      throw new Error(`duplicate durable mission observation '${missionId}'`);
    }
    if (event.observation.observedAt > row.ts) {
      throw new Error(`mission '${missionId}' was recorded before its market observation was valid`);
    }
    observed.set(missionId, row.seq);
  }

  const missions: DurableMissionEvaluationView[] = [];
  const pendingDecisionMissionIds: string[] = [];
  const externalMissionIds: string[] = [];

  for (const missionId of [...observed.keys()].sort()) {
    const record = reduceMission(ledger.readStream(missionId));
    if (record === undefined) {
      throw new Error(`mission '${missionId}' disappeared during deterministic replay`);
    }

    if (EXTERNAL_ORIGINS.has(record.origin)) {
      externalMissionIds.push(missionId);
      continue;
    }

    const snapshot = record.decisionSnapshot;
    if (snapshot?.brainEvaluation === undefined || snapshot.brainComparison === undefined) {
      pendingDecisionMissionIds.push(missionId);
      continue;
    }

    if (record.snapshotSealedAt === undefined) {
      throw new Error(`mission '${missionId}' has a decision snapshot without a durable seal time`);
    }
    if (snapshot.asOf > record.snapshotSealedAt) {
      throw new Error(`mission '${missionId}' snapshot is from after its durable seal time`);
    }
    if (snapshot.brainEvaluation.knowledgeCutoff < snapshot.asOf) {
      throw new Error(`mission '${missionId}' Brain knowledge cutoff predates its decision snapshot`);
    }
    if (snapshot.brainComparison.missionKnowledgeTime !== snapshot.brainEvaluation.knowledgeCutoff) {
      throw new Error(`mission '${missionId}' has divergent Brain knowledge cutoffs`);
    }

    missions.push({
      missionId: record.missionId,
      scanConfigVersion: record.scanConfigVersion,
      observedAt: record.observedAt,
      decisionSnapshot: snapshot,
    });
  }

  return {
    missions,
    pendingDecisionMissionIds,
    externalMissionIds,
    ledgerHead: head,
  };
}
