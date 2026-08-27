/**
 * Trade Mission domain types (ADR-0018).
 *
 * A mission is one trading idea from first observation through review. Orders
 * remain execution facts in the existing order ledger; missions reference them
 * but never become a second source of broker truth.
 */

export type MissionStage =
  | 'OBSERVED'
  | 'CANDIDATE'
  | 'PLANNED'
  | 'ARMED'
  | 'EXECUTING'
  | 'MANAGING'
  | 'CLOSED'
  | 'ABANDONED'
  | 'REVIEWED';

export type MissionOrigin =
  | 'brain'
  | 'operator:android'
  | 'operator:desktop'
  | 'manual:mt5'
  | 'pending-activation'
  | 'external:unknown';

/** Point-in-time observation that made the instrument worth considering. */
export interface MissionObservation {
  readonly missionId: string;
  readonly origin: MissionOrigin;
  readonly canonical: string;
  readonly timeframe: string;
  readonly trigger: string;
  /** Valid time: when the market observation was true/available. */
  readonly observedAt: number;
  /** Versioned scanner configuration so populations remain comparable. */
  readonly scanConfigVersion: string;
  /** Bounded, JSON-safe point-in-time market state. Never AI prose. */
  readonly marketState: Readonly<Record<string, unknown>>;
}

/**
 * Frozen record of what was known at decision time.
 *
 * `known` and `missing` are both explicit: absence is evidence and must not be
 * silently backfilled with information learned after the decision.
 */
export interface DecisionSnapshot {
  readonly snapshotVersion: number;
  readonly asOf: number;
  readonly known: Readonly<Record<string, unknown>>;
  readonly missing: readonly string[];
  readonly plan?: {
    readonly side: 'buy' | 'sell';
    readonly entry?: string;
    readonly stop?: string;
    readonly target?: string;
    readonly volume?: string;
    readonly invalidation: readonly string[];
  };
  readonly riskVerdict?: Readonly<Record<string, unknown>>;
  readonly brainVersion?: string;
  readonly regimeVersion?: string;
}

export interface MissionAction {
  readonly actionId: string;
  readonly origin: MissionOrigin;
  readonly type:
    | 'scan'
    | 'candidate'
    | 'plan'
    | 'authorise'
    | 'submit'
    | 'modify'
    | 'partial-close'
    | 'close'
    | 'invalidate'
    | 'expire'
    | 'veto'
    | 'external-observed'
    | 'note';
  readonly at: number;
  readonly reason?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface MissionReview {
  readonly reviewVersion: number;
  readonly reviewedAt: number;
  /** Decision quality is deliberately separate from realised outcome. */
  readonly decision: Readonly<Record<string, unknown>>;
  readonly outcome?: Readonly<Record<string, unknown>>;
  readonly counterfactual?: Readonly<Record<string, unknown>>;
  readonly evidenceSeqs: readonly number[];
}

export interface MissionRecord {
  readonly missionId: string;
  readonly origin: MissionOrigin;
  readonly canonical: string;
  readonly timeframe: string;
  readonly trigger: string;
  readonly scanConfigVersion: string;
  readonly stage: MissionStage;
  readonly observedAt: number;
  readonly marketState: Readonly<Record<string, unknown>>;
  readonly decisionSnapshot?: DecisionSnapshot;
  readonly snapshotSealedAt?: number;
  readonly intentIds: readonly string[];
  readonly positionIds: readonly string[];
  readonly actions: readonly MissionAction[];
  readonly abandonedReason?: string;
  readonly review?: MissionReview;
  readonly lastEventAt: number;
}

/**
 * Immutable facts emitted by the Mission aggregate.
 *
 * These intentionally contain no "current state" blob. Current state is a pure
 * fold over these facts, so replay and point-in-time reconstruction cannot
 * disagree with a mutable mission table.
 */
export type MissionLedgerEvent =
  | { kind: 'mission.observed'; observation: MissionObservation }
  | {
      kind: 'mission.snapshotSealed';
      missionId: string;
      snapshot: DecisionSnapshot;
      sealedAt: number;
    }
  | {
      kind: 'mission.stageChanged';
      missionId: string;
      from: MissionStage;
      to: MissionStage;
      origin: MissionOrigin;
      at: number;
      reason?: string;
    }
  | { kind: 'mission.intentLinked'; missionId: string; intentId: string; at: number }
  | { kind: 'mission.positionLinked'; missionId: string; positionId: string; at: number }
  | { kind: 'mission.actionRecorded'; missionId: string; action: MissionAction }
  | { kind: 'mission.reviewed'; missionId: string; review: MissionReview };
