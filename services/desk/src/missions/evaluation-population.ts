import type { Ledger } from '../ledger/ledger.js';
import { reduceMission } from './service.js';
import type { DecisionSnapshot, MissionOrigin } from './types.js';

const EXTERNAL_ORIGINS: ReadonlySet<MissionOrigin> = new Set([
  'manual:mt5',
  'pending-activation',
  'external:unknown',
]);

/**
 * Structural boundary consumed by @keel/brain/mission-evaluation and
 * @keel/brain/outcome-labeling.
 *
 * Desk deliberately owns only the durable Mission facts. The Brain package owns
 * scoring/evaluation semantics. Keeping this as a structural contract avoids a
 * second truth store and avoids making the execution host depend on Brain code.
 */
export interface DurableMissionEvaluationView {
  readonly missionId: string;
  readonly canonical: string;
  readonly scanConfigVersion: string;
  readonly observedAt: number;
  readonly decisionSnapshot: DecisionSnapshot;
}

/**
 * Every internal scan that can belong to a future Champion/Challenger denominator.
 *
 * `knownAt` is the ledger record time, not a reconstructed Brain decision time. This
 * keeps scans with missing/failed comparison snapshots visible without inventing AI
 * or Brain evidence. External/manual MT5 Missions are deliberately excluded.
 */
export interface DurablePairedEligibilityView {
  readonly missionId: string;
  readonly canonical: string;
  readonly scanConfigVersion: string;
  readonly observedAt: number;
  readonly knownAt: number;
}

export interface MissionEvaluationPopulation {
  /** Finalised internal Mission decisions eligible for deterministic evaluation. */
  readonly missions: readonly DurableMissionEvaluationView[];
  /** All internal durable scans, including scans whose decision/comparison is missing. */
  readonly pairedEligibility: readonly DurablePairedEligibilityView[];
  /** Internal Missions that exist durably but have not sealed a complete Brain decision yet. */
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
    const tail = page[page.length - 1];
    if (tail === undefined) {
      throw new Error(`ledger page unexpectedly empty after non-empty check at seq ${cursor}`);
    }
    cursor = tail.seq;
  }

  return rows;
}

/**
 * Build the scan-level ADR-0021 population directly from the immutable Desk ledger.
 *
 * No mutable Mission table, cache or current Brain registry participates. External
 * MT5 positions stay visible as an explicit excluded population rather than being
 * silently mixed into Brain statistics. Internal Missions without a sealed Brain
 * decision are surfaced both as pending and in `pairedEligibility`, so missing
 * Challenger shadow work cannot disappear from the statistical denominator.
 */
export function buildMissionEvaluationPopulation(ledger: Ledger): MissionEvaluationPopulation {
  const integrity = ledger.verifyChain();
  if (!integrity.ok) {
    throw new Error(
      `cannot evaluate an untrusted ledger: seq ${integrity.failedAt}: ${integrity.reason}`,
    );
  }

  const head = ledger.head;
  const observed = new Map<string, Readonly<{ seq: number; recordedAt: number }>>();

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
      throw new Error(
        `mission '${missionId}' was recorded before its market observation was valid`,
      );
    }
    observed.set(missionId, { seq: row.seq, recordedAt: row.ts });
  }

  const missions: DurableMissionEvaluationView[] = [];
  const pairedEligibility: DurablePairedEligibilityView[] = [];
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

    const observationBoundary = observed.get(missionId);
    if (observationBoundary === undefined) {
      throw new Error(`mission '${missionId}' lost its durable observation boundary`);
    }
    pairedEligibility.push({
      missionId: record.missionId,
      canonical: record.canonical,
      scanConfigVersion: record.scanConfigVersion,
      observedAt: record.observedAt,
      knownAt: observationBoundary.recordedAt,
    });

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
      throw new Error(
        `mission '${missionId}' Brain knowledge cutoff predates its decision snapshot`,
      );
    }
    if (
      snapshot.brainComparison.missionKnowledgeTime !== snapshot.brainEvaluation.knowledgeCutoff
    ) {
      throw new Error(`mission '${missionId}' has divergent Brain knowledge cutoffs`);
    }

    missions.push({
      missionId: record.missionId,
      canonical: record.canonical,
      scanConfigVersion: record.scanConfigVersion,
      observedAt: record.observedAt,
      decisionSnapshot: snapshot,
    });
  }

  return {
    missions,
    pairedEligibility,
    pendingDecisionMissionIds,
    externalMissionIds,
    ledgerHead: head,
  };
}
