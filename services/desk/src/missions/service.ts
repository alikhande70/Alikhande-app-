import type { LedgerEvent } from '../ledger/events.js';
import type { Ledger } from '../ledger/ledger.js';
import type {
  DecisionSnapshot,
  MissionAction,
  MissionObservation,
  MissionOrigin,
  MissionRecord,
  MissionReview,
  MissionStage,
} from './types.js';

export class MissionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissionInvariantError';
  }
}

const NORMAL_TRANSITIONS: Readonly<Record<MissionStage, ReadonlySet<MissionStage>>> = {
  OBSERVED: new Set(['CANDIDATE', 'ABANDONED']),
  CANDIDATE: new Set(['PLANNED', 'ABANDONED']),
  PLANNED: new Set(['ARMED', 'ABANDONED']),
  ARMED: new Set(['EXECUTING', 'ABANDONED']),
  EXECUTING: new Set(['MANAGING', 'ABANDONED']),
  MANAGING: new Set(['CLOSED']),
  CLOSED: new Set(['REVIEWED']),
  ABANDONED: new Set(['REVIEWED']),
  REVIEWED: new Set(),
};

const EXTERNAL_ORIGINS: ReadonlySet<MissionOrigin> = new Set([
  'manual:mt5',
  'pending-activation',
  'external:unknown',
]);

function assertFiniteTime(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new MissionInvariantError(`${field} must be a finite non-negative timestamp`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new MissionInvariantError(`${field} must not be empty`);
}

function assertSnapshot(snapshot: DecisionSnapshot): void {
  if (!Number.isInteger(snapshot.snapshotVersion) || snapshot.snapshotVersion < 1) {
    throw new MissionInvariantError('decision snapshot version must be a positive integer');
  }
  assertFiniteTime(snapshot.asOf, 'decision snapshot asOf');
  const seen = new Set<string>();
  for (const item of snapshot.missing) {
    assertNonEmpty(item, 'decision snapshot missing item');
    if (seen.has(item))
      throw new MissionInvariantError(`decision snapshot duplicates missing item '${item}'`);
    seen.add(item);
  }
}

function baseRecord(observation: MissionObservation, ledgerTs: number): MissionRecord {
  return {
    missionId: observation.missionId,
    origin: observation.origin,
    canonical: observation.canonical,
    timeframe: observation.timeframe,
    trigger: observation.trigger,
    scanConfigVersion: observation.scanConfigVersion,
    stage: 'OBSERVED',
    observedAt: observation.observedAt,
    marketState: observation.marketState,
    intentIds: [],
    positionIds: [],
    actions: [],
    lastEventAt: ledgerTs,
  };
}

function assertReplayTransition(record: MissionRecord, to: MissionStage): void {
  const externalAdoption =
    record.stage === 'OBSERVED' && to === 'MANAGING' && EXTERNAL_ORIGINS.has(record.origin);
  if (!externalAdoption && !NORMAL_TRANSITIONS[record.stage].has(to)) {
    throw new MissionInvariantError(`invalid mission transition ${record.stage} -> ${to}`);
  }
  if (to === 'PLANNED' && record.decisionSnapshot === undefined) {
    throw new MissionInvariantError('PLANNED requires a sealed decision snapshot');
  }
  if (
    to === 'ABANDONED' &&
    (record.stage === 'OBSERVED' || record.stage === 'CANDIDATE') &&
    record.decisionSnapshot === undefined
  ) {
    throw new MissionInvariantError('untraded ABANDONED mission requires a decision snapshot');
  }
  if (to === 'REVIEWED' && record.review === undefined) {
    throw new MissionInvariantError('REVIEWED requires an immutable mission review');
  }
}

/** Fold one mission stream into current state. Ledger facts remain authoritative. */
export function reduceMission(
  events: readonly { event: LedgerEvent; ts: number }[],
): MissionRecord | undefined {
  let record: MissionRecord | undefined;

  for (const row of events) {
    const event = row.event;
    switch (event.kind) {
      case 'mission.observed': {
        if (record !== undefined)
          throw new MissionInvariantError('mission contains more than one observation');
        record = baseRecord(event.observation, row.ts);
        break;
      }
      case 'mission.snapshotSealed': {
        if (record === undefined)
          throw new MissionInvariantError('snapshot exists before mission observation');
        if (record.decisionSnapshot !== undefined) {
          throw new MissionInvariantError('decision snapshot is immutable and cannot be resealed');
        }
        assertSnapshot(event.snapshot);
        record = {
          ...record,
          decisionSnapshot: event.snapshot,
          snapshotSealedAt: event.sealedAt,
          lastEventAt: Math.max(record.lastEventAt, event.sealedAt),
        };
        break;
      }
      case 'mission.stageChanged': {
        if (record === undefined)
          throw new MissionInvariantError('stage change exists before mission observation');
        if (record.stage !== event.from) {
          throw new MissionInvariantError(
            `mission stage history diverged: event expects ${event.from}, current state is ${record.stage}`,
          );
        }
        assertReplayTransition(record, event.to);
        record = {
          ...record,
          stage: event.to,
          ...(event.to === 'ABANDONED' && event.reason !== undefined
            ? { abandonedReason: event.reason }
            : {}),
          lastEventAt: Math.max(record.lastEventAt, event.at),
        };
        break;
      }
      case 'mission.intentLinked': {
        if (record === undefined)
          throw new MissionInvariantError('intent link exists before mission observation');
        if (record.intentIds.includes(event.intentId)) break;
        record = {
          ...record,
          intentIds: [...record.intentIds, event.intentId],
          lastEventAt: Math.max(record.lastEventAt, event.at),
        };
        break;
      }
      case 'mission.positionLinked': {
        if (record === undefined)
          throw new MissionInvariantError('position link exists before mission observation');
        if (record.positionIds.includes(event.positionId)) break;
        record = {
          ...record,
          positionIds: [...record.positionIds, event.positionId],
          lastEventAt: Math.max(record.lastEventAt, event.at),
        };
        break;
      }
      case 'mission.actionRecorded': {
        if (record === undefined)
          throw new MissionInvariantError('action exists before mission observation');
        if (record.actions.some((action) => action.actionId === event.action.actionId)) {
          throw new MissionInvariantError(`duplicate mission action id '${event.action.actionId}'`);
        }
        record = {
          ...record,
          actions: [...record.actions, event.action],
          lastEventAt: Math.max(record.lastEventAt, event.action.at),
        };
        break;
      }
      case 'mission.reviewed': {
        if (record === undefined)
          throw new MissionInvariantError('review exists before mission observation');
        if (record.review !== undefined)
          throw new MissionInvariantError('mission review is immutable');
        record = {
          ...record,
          review: event.review,
          lastEventAt: Math.max(record.lastEventAt, event.review.reviewedAt),
        };
        break;
      }
      default:
        // Mission streams should only contain mission facts. Ignore unrelated
        // kinds defensively so a legacy aggregate-id collision cannot invent a
        // mission state; command methods below still emit mission-only streams.
        break;
    }
  }

  return record;
}

export class MissionService {
  constructor(private readonly ledger: Ledger) {}

  load(missionId: string): MissionRecord | undefined {
    return reduceMission(this.ledger.readStream(missionId));
  }

  observe(observation: MissionObservation): MissionRecord {
    assertNonEmpty(observation.missionId, 'mission id');
    assertNonEmpty(observation.canonical, 'canonical instrument');
    assertNonEmpty(observation.timeframe, 'timeframe');
    assertNonEmpty(observation.trigger, 'trigger');
    assertNonEmpty(observation.scanConfigVersion, 'scan configuration version');
    assertFiniteTime(observation.observedAt, 'observedAt');
    if (this.load(observation.missionId) !== undefined) {
      throw new MissionInvariantError(`mission '${observation.missionId}' already exists`);
    }
    this.ledger.append({ kind: 'mission.observed', observation });
    return this.require(observation.missionId);
  }

  /**
   * Represent a position discovered outside Keel without fabricating a decision.
   * It enters MANAGING with no snapshot, so it can affect account statistics but
   * can never be credited to a Brain version.
   */
  adoptExternalPosition(input: {
    readonly missionId: string;
    readonly canonical: string;
    readonly positionId: string;
    readonly origin: Extract<
      MissionOrigin,
      'manual:mt5' | 'pending-activation' | 'external:unknown'
    >;
    readonly observedAt: number;
    readonly marketState?: Readonly<Record<string, unknown>>;
  }): MissionRecord {
    if (this.load(input.missionId) !== undefined) {
      const existing = this.require(input.missionId);
      if (!existing.positionIds.includes(input.positionId))
        this.linkPosition(input.missionId, input.positionId, input.observedAt);
      return this.require(input.missionId);
    }
    const observation: MissionObservation = {
      missionId: input.missionId,
      origin: input.origin,
      canonical: input.canonical,
      timeframe: 'external',
      trigger: 'broker-position-discovered',
      observedAt: input.observedAt,
      scanConfigVersion: 'external-v1',
      marketState: input.marketState ?? {},
    };
    const action: MissionAction = {
      actionId: `${input.missionId}:external:${input.positionId}`,
      origin: input.origin,
      type: 'external-observed',
      at: input.observedAt,
      detail: { positionId: input.positionId },
    };
    this.ledger.appendAll([
      { kind: 'mission.observed', observation },
      {
        kind: 'mission.positionLinked',
        missionId: input.missionId,
        positionId: input.positionId,
        at: input.observedAt,
      },
      { kind: 'mission.actionRecorded', missionId: input.missionId, action },
      {
        kind: 'mission.stageChanged',
        missionId: input.missionId,
        from: 'OBSERVED',
        to: 'MANAGING',
        origin: input.origin,
        at: input.observedAt,
        reason: 'foreign position adopted from broker truth',
      },
    ]);
    return this.require(input.missionId);
  }

  markCandidate(missionId: string, origin: MissionOrigin, at: number): MissionRecord {
    return this.transition(missionId, 'CANDIDATE', origin, at);
  }

  plan(
    missionId: string,
    snapshot: DecisionSnapshot,
    origin: MissionOrigin,
    at: number,
  ): MissionRecord {
    const current = this.require(missionId);
    if (current.stage !== 'CANDIDATE') {
      throw new MissionInvariantError(`planning requires CANDIDATE, found ${current.stage}`);
    }
    if (current.decisionSnapshot !== undefined) {
      throw new MissionInvariantError('decision snapshot is already sealed');
    }
    assertSnapshot(snapshot);
    assertFiniteTime(at, 'plan time');
    if (snapshot.asOf > at)
      throw new MissionInvariantError('decision snapshot cannot come from the future');
    const action: MissionAction = {
      actionId: `${missionId}:plan:${at}`,
      origin,
      type: 'plan',
      at,
    };
    this.ledger.appendAll([
      { kind: 'mission.snapshotSealed', missionId, snapshot, sealedAt: at },
      { kind: 'mission.actionRecorded', missionId, action },
      { kind: 'mission.stageChanged', missionId, from: 'CANDIDATE', to: 'PLANNED', origin, at },
    ]);
    return this.require(missionId);
  }

  arm(missionId: string, origin: MissionOrigin, at: number, reason?: string): MissionRecord {
    return this.transition(missionId, 'ARMED', origin, at, reason);
  }

  beginExecution(missionId: string, origin: MissionOrigin, at: number): MissionRecord {
    const mission = this.require(missionId);
    if (mission.intentIds.length === 0) {
      throw new MissionInvariantError('EXECUTING requires at least one linked order intent');
    }
    return this.transition(missionId, 'EXECUTING', origin, at);
  }

  beginManaging(missionId: string, origin: MissionOrigin, at: number): MissionRecord {
    return this.transition(missionId, 'MANAGING', origin, at);
  }

  close(missionId: string, origin: MissionOrigin, at: number, reason?: string): MissionRecord {
    return this.transition(missionId, 'CLOSED', origin, at, reason);
  }

  abandon(
    missionId: string,
    origin: MissionOrigin,
    at: number,
    reason: string,
    snapshotIfUnplanned?: DecisionSnapshot,
  ): MissionRecord {
    assertNonEmpty(reason, 'abandon reason');
    const mission = this.require(missionId);
    if (mission.stage === 'OBSERVED' || mission.stage === 'CANDIDATE') {
      if (mission.decisionSnapshot === undefined) {
        if (snapshotIfUnplanned === undefined) {
          throw new MissionInvariantError(
            'an untraded mission must seal a decision snapshot before it is abandoned',
          );
        }
        assertSnapshot(snapshotIfUnplanned);
        if (snapshotIfUnplanned.asOf > at) {
          throw new MissionInvariantError('decision snapshot cannot come from the future');
        }
        this.ledger.append({
          kind: 'mission.snapshotSealed',
          missionId,
          snapshot: snapshotIfUnplanned,
          sealedAt: at,
        });
      }
    }
    return this.transition(missionId, 'ABANDONED', origin, at, reason);
  }

  review(missionId: string, review: MissionReview): MissionRecord {
    const mission = this.require(missionId);
    if (mission.stage !== 'CLOSED' && mission.stage !== 'ABANDONED') {
      throw new MissionInvariantError(
        `review requires CLOSED or ABANDONED, found ${mission.stage}`,
      );
    }
    if (mission.review !== undefined)
      throw new MissionInvariantError('mission is already reviewed');
    if (!Number.isInteger(review.reviewVersion) || review.reviewVersion < 1) {
      throw new MissionInvariantError('review version must be a positive integer');
    }
    assertFiniteTime(review.reviewedAt, 'reviewedAt');
    this.ledger.appendAll([
      { kind: 'mission.reviewed', missionId, review },
      {
        kind: 'mission.stageChanged',
        missionId,
        from: mission.stage,
        to: 'REVIEWED',
        origin: mission.origin,
        at: review.reviewedAt,
      },
    ]);
    return this.require(missionId);
  }

  linkIntent(missionId: string, intentId: string, at: number): MissionRecord {
    assertNonEmpty(intentId, 'intent id');
    assertFiniteTime(at, 'intent link time');
    const mission = this.require(missionId);
    if (
      mission.stage === 'CLOSED' ||
      mission.stage === 'ABANDONED' ||
      mission.stage === 'REVIEWED'
    ) {
      throw new MissionInvariantError(`cannot link an intent to terminal mission ${mission.stage}`);
    }
    if (!mission.intentIds.includes(intentId)) {
      this.ledger.append({ kind: 'mission.intentLinked', missionId, intentId, at });
    }
    return this.require(missionId);
  }

  linkPosition(missionId: string, positionId: string, at: number): MissionRecord {
    assertNonEmpty(positionId, 'position id');
    assertFiniteTime(at, 'position link time');
    const mission = this.require(missionId);
    if (!mission.positionIds.includes(positionId)) {
      this.ledger.append({ kind: 'mission.positionLinked', missionId, positionId, at });
    }
    return this.require(missionId);
  }

  recordAction(missionId: string, action: MissionAction): MissionRecord {
    const mission = this.require(missionId);
    assertNonEmpty(action.actionId, 'action id');
    assertFiniteTime(action.at, 'action time');
    if (mission.actions.some((candidate) => candidate.actionId === action.actionId)) {
      return mission; // idempotent client replay
    }
    this.ledger.append({ kind: 'mission.actionRecorded', missionId, action });
    return this.require(missionId);
  }

  private transition(
    missionId: string,
    to: MissionStage,
    origin: MissionOrigin,
    at: number,
    reason?: string,
  ): MissionRecord {
    const mission = this.require(missionId);
    assertFiniteTime(at, 'stage transition time');
    if (to === 'REVIEWED') throw new MissionInvariantError('use review() to enter REVIEWED');
    const allowed = NORMAL_TRANSITIONS[mission.stage];
    if (!allowed.has(to)) {
      throw new MissionInvariantError(`invalid mission transition ${mission.stage} -> ${to}`);
    }
    if (to === 'PLANNED' && mission.decisionSnapshot === undefined) {
      throw new MissionInvariantError('PLANNED requires a sealed decision snapshot');
    }
    this.ledger.append({
      kind: 'mission.stageChanged',
      missionId,
      from: mission.stage,
      to,
      origin,
      at,
      ...(reason === undefined ? {} : { reason }),
    });
    return this.require(missionId);
  }

  private require(missionId: string): MissionRecord {
    const mission = this.load(missionId);
    if (mission === undefined)
      throw new MissionInvariantError(`mission '${missionId}' does not exist`);
    return mission;
  }
}
