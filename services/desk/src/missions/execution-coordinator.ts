import type { SubmitCommand, SubmitOutcome } from '../engine/supervisor.js';
import type { Ledger } from '../ledger/ledger.js';
import { MissionInvariantError, type MissionService } from './service.js';
import type { MissionOrigin, MissionRecord } from './types.js';

interface MissionSubmitter {
  submit(cmd: SubmitCommand): Promise<SubmitOutcome>;
}

interface SubmitActionDetail {
  readonly intentId: string;
  readonly canonical: string;
}

/**
 * Crash-safe bridge between ADR-0018 Trade Missions and order intents.
 *
 * The mission writes an explicit submit action before the execution supervisor
 * is invoked. The supervisor, independently, fsyncs `intent.created` before any
 * broker transmission. Once both facts exist, this coordinator links them.
 *
 * If the process dies after `intent.created` but before `mission.intentLinked`,
 * `recoverPendingLinks()` completes the link from those two durable facts. No
 * symbol/side/volume/time similarity is ever used for attribution.
 */
export class MissionExecutionCoordinator {
  constructor(
    private readonly ledger: Ledger,
    private readonly missions: MissionService,
    private readonly submitter: MissionSubmitter,
  ) {}

  async submit(
    missionId: string,
    cmd: SubmitCommand,
    actor: MissionOrigin,
    at: number,
  ): Promise<SubmitOutcome> {
    const mission = this.requireMission(missionId);
    this.assertCanonical(mission, cmd.canonical);

    const alreadyLinked = mission.intentIds.includes(cmd.intentId);
    if (!alreadyLinked && mission.stage !== 'PLANNED' && mission.stage !== 'ARMED') {
      throw new MissionInvariantError(
        `new order intent requires PLANNED or ARMED mission, found ${mission.stage}`,
      );
    }
    if (
      alreadyLinked &&
      mission.stage !== 'ARMED' &&
      mission.stage !== 'EXECUTING' &&
      mission.stage !== 'MANAGING'
    ) {
      throw new MissionInvariantError(
        `linked intent retry is not valid while mission is ${mission.stage}`,
      );
    }

    if (mission.stage === 'PLANNED') {
      this.missions.recordAction(missionId, {
        actionId: `${missionId}:authorise:${cmd.intentId}`,
        origin: actor,
        type: 'authorise',
        at,
        detail: { intentId: cmd.intentId },
      });
      this.missions.arm(missionId, actor, at, 'operator submitted planned mission');
    }

    // This fact is deliberately persisted before calling the execution layer.
    // It is the explicit ownership claim recovery needs if the process dies in
    // the narrow gap between intent durability and the mission link.
    this.missions.recordAction(missionId, {
      actionId: `${missionId}:submit:${cmd.intentId}`,
      origin: actor,
      type: 'submit',
      at,
      detail: { intentId: cmd.intentId, canonical: cmd.canonical },
    });

    const outcome = await this.submitter.submit(cmd);
    this.linkIfIntentWasCreated(missionId, cmd.intentId, cmd.canonical, at);
    return outcome;
  }

  /**
   * Repair only links whose ownership is already proven by durable facts.
   *
   * A submit action without `intent.created` is a refused/local attempt and is
   * not linked. `intent.created` without an explicit mission submit action is a
   * legacy/unattributed intent and is also not linked. Multiple missions
   * claiming one intent are a contradiction and fail closed.
   */
  recoverPendingLinks(): number {
    const rows = this.ledger.db
      .prepare(
        `SELECT stream, payload
         FROM ledger
         WHERE kind = 'mission.actionRecorded'
           AND json_extract(payload, '$.action.type') = 'submit'
         ORDER BY seq ASC`,
      )
      .all() as Array<{ stream: string; payload: string }>;

    const claims = new Map<string, { missionId: string; canonical: string }>();
    for (const row of rows) {
      const detail = submitDetail(row.payload);
      if (detail === undefined) continue;
      const prior = claims.get(detail.intentId);
      if (prior !== undefined && prior.missionId !== row.stream) {
        throw new MissionInvariantError(
          `intent '${detail.intentId}' is claimed by multiple missions: '${prior.missionId}' and '${row.stream}'`,
        );
      }
      claims.set(detail.intentId, { missionId: row.stream, canonical: detail.canonical });
    }

    let repaired = 0;
    for (const [intentId, claim] of claims) {
      const createdCanonical = this.intentCanonical(intentId);
      if (createdCanonical === undefined) continue;
      if (createdCanonical !== claim.canonical) {
        throw new MissionInvariantError(
          `mission submit claim for intent '${intentId}' says '${claim.canonical}', but durable intent says '${createdCanonical}'`,
        );
      }
      if (this.linkIfIntentWasCreated(claim.missionId, intentId, createdCanonical, Date.now())) {
        repaired++;
      }
    }
    return repaired;
  }

  private linkIfIntentWasCreated(
    missionId: string,
    intentId: string,
    canonical: string,
    at: number,
  ): boolean {
    const createdCanonical = this.intentCanonical(intentId);
    if (createdCanonical === undefined) return false;
    if (createdCanonical !== canonical) {
      throw new MissionInvariantError(
        `cannot link intent '${intentId}': mission canonical '${canonical}' differs from durable intent '${createdCanonical}'`,
      );
    }

    const existing = this.linkedMission(intentId);
    if (existing !== undefined) {
      if (existing !== missionId) {
        throw new MissionInvariantError(
          `intent '${intentId}' is already linked to mission '${existing}', not '${missionId}'`,
        );
      }
      return false;
    }

    const mission = this.requireMission(missionId);
    this.assertCanonical(mission, canonical);
    this.missions.linkIntent(missionId, intentId, at);
    return true;
  }

  private intentCanonical(intentId: string): string | undefined {
    const row = this.ledger.db
      .prepare(
        `SELECT json_extract(payload, '$.intent.canonical') AS canonical
         FROM ledger
         WHERE stream = ? AND kind = 'intent.created'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(intentId) as { canonical: string | null } | undefined;
    return row?.canonical ?? undefined;
  }

  private linkedMission(intentId: string): string | undefined {
    const rows = this.ledger.db
      .prepare(
        `SELECT stream
         FROM ledger
         WHERE kind = 'mission.intentLinked'
           AND json_extract(payload, '$.intentId') = ?
         ORDER BY seq ASC`,
      )
      .all(intentId) as Array<{ stream: string }>;
    const first = rows[0]?.stream;
    if (first === undefined) return undefined;
    if (rows.some((row) => row.stream !== first)) {
      throw new MissionInvariantError(
        `intent '${intentId}' is already linked to multiple missions`,
      );
    }
    return first;
  }

  private requireMission(missionId: string): MissionRecord {
    const mission = this.missions.load(missionId);
    if (mission === undefined)
      throw new MissionInvariantError(`mission '${missionId}' does not exist`);
    return mission;
  }

  private assertCanonical(mission: MissionRecord, canonical: string): void {
    if (mission.canonical !== canonical) {
      throw new MissionInvariantError(
        `mission '${mission.missionId}' is for '${mission.canonical}', not '${canonical}'`,
      );
    }
  }
}

function submitDetail(payload: string): SubmitActionDetail | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    throw new MissionInvariantError('mission submit action contains malformed ledger JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const action = (parsed as Record<string, unknown>).action;
  if (typeof action !== 'object' || action === null) return undefined;
  const detail = (action as Record<string, unknown>).detail;
  if (typeof detail !== 'object' || detail === null) return undefined;
  const intentId = (detail as Record<string, unknown>).intentId;
  const canonical = (detail as Record<string, unknown>).canonical;
  if (typeof intentId !== 'string' || intentId.length === 0) return undefined;
  if (typeof canonical !== 'string' || canonical.length === 0) return undefined;
  return { intentId, canonical };
}
