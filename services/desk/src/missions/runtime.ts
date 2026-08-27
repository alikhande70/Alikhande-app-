import { createHash } from 'node:crypto';
import type { Ledger } from '../ledger/ledger.js';
import { MissionService } from './service.js';
import type { MissionRecord } from './types.js';

/**
 * Broker-truth bridge for ADR-0018.
 *
 * Missions never infer broker state. This class only reacts to broker facts
 * already accepted by the execution layer and links/adopts them into the
 * durable mission history. Weak similarity (symbol/side/volume/time) is never
 * used for ownership: an internal position must resolve through an intent link;
 * otherwise it becomes an external mission with no fabricated decision.
 */
export class MissionRuntime {
  readonly missions: MissionService;

  constructor(
    private readonly ledger: Ledger,
    missions?: MissionService,
  ) {
    this.missions = missions ?? new MissionService(ledger);
  }

  /**
   * Link an observed broker position to its mission when durable intent identity
   * proves ownership. Without that proof, adopt it as external/unknown.
   */
  observePosition(input: {
    readonly broker: string;
    readonly positionId: string;
    readonly canonical: string;
    readonly at: number;
    readonly intentId?: string;
  }): MissionRecord {
    if (input.intentId !== undefined) {
      const missionId = this.findMissionByIntent(input.intentId);
      if (missionId !== undefined) {
        this.missions.linkPosition(missionId, input.positionId, input.at);
        this.missions.recordAction(missionId, {
          actionId: `${missionId}:broker-position:${input.positionId}`,
          origin: this.missions.load(missionId)?.origin ?? 'external:unknown',
          type: 'note',
          at: input.at,
          reason: 'broker position observed',
          detail: {
            broker: input.broker,
            positionId: input.positionId,
            intentId: input.intentId,
          },
        });
        return this.advanceToManaging(missionId, input.at);
      }
    }

    // A foreign MT5 position might be manual, another EA, or a server-side
    // activation. Without durable identity we deliberately refuse to guess.
    const missionId = externalMissionId(input.broker, input.positionId);
    return this.missions.adoptExternalPosition({
      missionId,
      canonical: input.canonical,
      positionId: input.positionId,
      origin: 'external:unknown',
      observedAt: input.at,
      marketState: {
        broker: input.broker,
        positionId: input.positionId,
        ownership: 'unattributed',
      },
    });
  }

  /** Close the mission whose durable position link matches broker truth. */
  closePosition(input: {
    readonly positionId: string;
    readonly at: number;
    readonly reason?: string;
  }): MissionRecord | undefined {
    const missionId = this.findMissionByPosition(input.positionId);
    if (missionId === undefined) return undefined;

    let mission = this.missions.load(missionId);
    if (mission === undefined) return undefined;
    if (mission.stage === 'CLOSED' || mission.stage === 'REVIEWED') return mission;

    // Broker events can be observed out of order. If durable identity already
    // linked this position, broker truth is sufficient to advance through the
    // missing execution/managing states; it is not sufficient to invent a plan.
    mission = this.advanceToManaging(missionId, input.at);
    if (mission.stage !== 'MANAGING') return mission;

    this.missions.recordAction(missionId, {
      actionId: `${missionId}:broker-close:${input.positionId}`,
      origin: mission.origin,
      type: 'close',
      at: input.at,
      reason: input.reason ?? 'broker position closed',
      detail: { positionId: input.positionId },
    });
    return this.missions.close(
      missionId,
      mission.origin,
      input.at,
      input.reason ?? 'broker position closed',
    );
  }

  private advanceToManaging(missionId: string, at: number): MissionRecord {
    let mission = this.requireMission(missionId);
    if (mission.stage === 'ARMED') {
      // beginExecution itself verifies that a durable intent is linked.
      mission = this.missions.beginExecution(missionId, mission.origin, at);
    }
    if (mission.stage === 'EXECUTING') {
      mission = this.missions.beginManaging(missionId, mission.origin, at);
    }
    return mission;
  }

  private findMissionByIntent(intentId: string): string | undefined {
    const row = this.ledger.db
      .prepare(
        `SELECT stream FROM ledger
         WHERE kind = 'mission.intentLinked'
           AND json_extract(payload, '$.intentId') = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(intentId) as { stream: string } | undefined;
    return row?.stream;
  }

  private findMissionByPosition(positionId: string): string | undefined {
    const row = this.ledger.db
      .prepare(
        `SELECT stream FROM ledger
         WHERE kind = 'mission.positionLinked'
           AND json_extract(payload, '$.positionId') = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(positionId) as { stream: string } | undefined;
    return row?.stream;
  }

  private requireMission(missionId: string): MissionRecord {
    const mission = this.missions.load(missionId);
    if (mission === undefined)
      throw new Error(`mission '${missionId}' disappeared during broker bridge`);
    return mission;
  }
}

/** Stable across restarts without exposing venue ids as aggregate ids. */
export function externalMissionId(broker: string, positionId: string): string {
  const digest = createHash('sha256').update(`${broker}\0${positionId}`).digest('hex').slice(0, 24);
  return `external-${digest}`;
}
