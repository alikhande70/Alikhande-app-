import type { Anomaly, Dec, OrderEvent, OrderState } from '@keel/core';
import * as D from '@keel/core';
import type { MissionLedgerEvent } from '../missions/types.js';

/**
 * Everything that can change the desk's state, as immutable facts.
 *
 * Two rules govern this file:
 *
 * 1. Events describe **what happened**, never what should happen next. There
 *    are no commands here.
 * 2. Anything that could later be needed to answer "why did the system do
 *    that?" is captured at the time, because it cannot be reconstructed later.
 *    That includes the policy version in force and the risk decision's full
 *    reason chain.
 */

export interface OrderIntent {
  readonly intentId: string;
  readonly canonical: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly kind: 'market' | 'limit' | 'stop' | 'stop_limit';
  readonly timeInForce: string;
  readonly volume: string;
  readonly limitPrice?: string;
  readonly stopPrice?: string;
  readonly attachedStop?: string;
  readonly attachedTakeProfit?: string;
  readonly riskAccount?: string;
  readonly preTradeNote: string;
  readonly tags: readonly string[];
  /** Deterministic id the venue sees, derived from `intentId` (ADR-0006). */
  readonly clientOrderId: string;
  /** The quote the operator was looking at when they decided. */
  readonly referenceQuote?: { bid: string; ask: string; asOf: number };
  readonly maxSlippage?: string;
}

export interface RiskDecisionRecord {
  readonly verdict: 'pass' | 'warn' | 'block';
  readonly checks: readonly {
    rule: string;
    verdict: string;
    observed: string;
    limit: string;
    message: string;
  }[];
  readonly policyVersion: number;
  readonly evaluatedAt: number;
}

/**
 * Immutable evidence that a sealed holdout question was opened once.
 *
 * This is deliberately a Desk fact rather than Brain state. The Brain may
 * consume this evidence, but it cannot manufacture or mutate it. The exact
 * sealed population hash and registered cutoff are captured before evaluation
 * so a later process restart cannot forget that the question was consumed.
 */
export interface HoldoutAccessReceiptRecord {
  readonly holdoutId: string;
  readonly questionId: string;
  readonly openedAt: number;
  readonly evaluationCutoff: number;
  readonly populationHash: string;
}

/**
 * Immutable pre-registration of one multiple-testing family (ADR-0021).
 *
 * The whole family is stored, not merely its digest. That lets replay prove
 * exactly which questions, test definitions and analysis plans were fixed
 * before evidence arrived. `familyHash` is the deterministic Brain-compatible
 * seal over the remaining fields.
 */
export interface HypothesisFamilyRegistrationRecord {
  readonly version: 'registered-hypothesis-family:v1';
  readonly familyId: string;
  readonly familyHash: string;
  readonly registeredAt: number;
  readonly method: 'benjamini-hochberg';
  readonly qLevel: number;
  readonly hypotheses: readonly {
    readonly questionId: string;
    readonly testId: string;
    readonly analysisPlanHash: string;
    readonly alternative: 'greater' | 'less' | 'two-sided';
  }[];
}

export type LedgerEvent =
  | MissionLedgerEvent
  | { kind: 'desk.started'; version: string; config: Record<string, unknown> }
  | { kind: 'desk.stopping'; reason: string }
  | { kind: 'broker.connected'; broker: string; capabilities: Record<string, unknown> }
  | { kind: 'broker.disconnected'; broker: string; reason: string }
  /** Full order intent, written and fsynced *before* any transmission. */
  | { kind: 'intent.created'; intent: OrderIntent; risk: RiskDecisionRecord }
  /** Risk refused the order. It never left the process. */
  | { kind: 'intent.refused'; intentId: string; risk: RiskDecisionRecord }
  /** Break-glass. Its own event so an override can never be invisible. */
  | {
      kind: 'override.used';
      intentId: string;
      reason: string;
      waivedRules: readonly string[];
      authorisedAt: number;
    }
  | { kind: 'order.event'; intentId: string; event: WireOrderEvent }
  | { kind: 'order.anomaly'; intentId: string; anomaly: Anomaly }
  | {
      kind: 'position.observed';
      positionId: string;
      canonical: string;
      symbol: string;
      side: 'buy' | 'sell';
      volume: string;
      entryPrice: string;
      stopPrice?: string;
      takeProfitPrice?: string;
      openedAt: number;
      intentId?: string;
      foreign: boolean;
      asOf: number;
    }
  | {
      kind: 'position.closed';
      positionId: string;
      exitPrice: string;
      netPnl: string;
      costs: string;
      closedAt: number;
    }
  | {
      kind: 'account.observed';
      currency: string;
      balance: string;
      equity: string;
      marginUsed: string;
      marginFree: string;
      asOf: number;
      source: 'broker' | 'derived';
    }
  | { kind: 'instrument.observed'; canonical: string; spec: Record<string, unknown>; asOf: number }
  | { kind: 'policy.updated'; version: number; policy: Record<string, unknown>; appliedAt: number }
  | {
      kind: 'drawdown.updated';
      highWater: string;
      floor: string;
      currentDayStart: number;
      dayHigh: string;
      breached: boolean;
      breachedAt?: number;
      status: string;
      at: number;
    }
  | { kind: 'drawdown.breached'; floor: string; observed: string; at: number }
  /** Operator explicitly cleared a breach. Never automatic. */
  | { kind: 'drawdown.breachCleared'; reason: string; at: number }
  | { kind: 'day.rolled'; dayStart: number; openBalance: string }
  | { kind: 'guard.lockout'; until: number; reason: string; at: number }
  | { kind: 'guard.released'; reason: string; at: number }
  | { kind: 'guard.flattenRequested'; reason: string; positions: readonly string[]; at: number }
  | {
      kind: 'divergence.opened';
      divergenceId: string;
      divergence: Record<string, unknown>;
      at: number;
    }
  | { kind: 'divergence.acknowledged'; divergenceId: string; at: number }
  | { kind: 'divergence.resolved'; divergenceId: string; how: string; at: number }
  | { kind: 'reconcile.completed'; checkedAt: number; divergences: number; clean: boolean }
  | { kind: 'evaluation.holdoutOpened'; receipt: HoldoutAccessReceiptRecord }
  | {
      kind: 'evaluation.hypothesisFamilyRegistered';
      registration: HypothesisFamilyRegistrationRecord;
    }
  | { kind: 'journal.opened'; tradeId: string; entry: Record<string, unknown> }
  | {
      kind: 'journal.closed';
      tradeId: string;
      exitPrice: string;
      netPnl: string;
      costs: string;
      r: string;
      closedAt: number;
    }
  | {
      kind: 'journal.noted';
      tradeId: string;
      postTradeNote: string;
      tags: readonly string[];
      at: number;
    }
  | { kind: 'alert.raised'; alertId: string; alert: Record<string, unknown> }
  | { kind: 'alert.acknowledged'; alertId: string; at: number }
  | { kind: 'alert.pushDispatched'; alertId: string; at: number }
  | { kind: 'alert.pushAcknowledged'; alertId: string; at: number };

export type LedgerEventKind = LedgerEvent['kind'];

/**
 * Order events in wire form: every quantity and price is a decimal string.
 *
 * The ledger is a durable, long-lived, human-readable forensic record. It must
 * not contain internal representations — `Dec` holds a `bigint`, which JSON
 * cannot serialise at all, and even if it could, a stored `{v, s}` pair would
 * tie the file format to an implementation detail of the arithmetic library.
 *
 * Strings also mean `sqlite3 keel.db "select payload from ledger"` is readable
 * at 2am, which is when it will be read.
 */
export type WireOrderEvent =
  | { readonly type: 'submit.started'; readonly at: number }
  | {
      readonly type: 'submit.acked';
      readonly at: number;
      readonly venueOrderId: string;
      readonly venueStatus?: string;
    }
  | { readonly type: 'submit.rejected'; readonly at: number; readonly reason: string }
  | { readonly type: 'submit.ambiguous'; readonly at: number; readonly reason: string }
  | { readonly type: 'submit.aborted'; readonly at: number; readonly reason: string }
  | {
      readonly type: 'resolution.found';
      readonly at: number;
      readonly venueOrderId: string;
      readonly venueState: OrderState;
      readonly filledQty: string;
      readonly avgPrice?: string;
    }
  | { readonly type: 'resolution.absent'; readonly at: number; readonly evidence: string }
  | {
      readonly type: 'fill';
      readonly at: number;
      readonly fillId: string;
      readonly qty: string;
      readonly price: string;
    }
  | { readonly type: 'cancel.requested'; readonly at: number }
  | { readonly type: 'cancel.acked'; readonly at: number }
  | { readonly type: 'cancel.rejected'; readonly at: number; readonly reason: string }
  | { readonly type: 'expired'; readonly at: number }
  | {
      readonly type: 'venue.observed';
      readonly at: number;
      readonly venueState: OrderState;
      readonly filledQty: string;
    };

const s = (d: Dec): string => D.Decimal.toString(d);

/** Convert a domain order event to its durable wire form. */
export function toWireOrderEvent(e: OrderEvent): WireOrderEvent {
  switch (e.type) {
    case 'resolution.found':
      return {
        type: e.type,
        at: e.at,
        venueOrderId: e.venueOrderId,
        venueState: e.venueState,
        filledQty: s(e.filledQty),
        ...(e.avgPrice !== undefined ? { avgPrice: s(e.avgPrice) } : {}),
      };
    case 'fill':
      return { type: e.type, at: e.at, fillId: e.fillId, qty: s(e.qty), price: s(e.price) };
    case 'venue.observed':
      return { type: e.type, at: e.at, venueState: e.venueState, filledQty: s(e.filledQty) };
    default:
      return e;
  }
}

/** Convert a durable wire event back into the domain form. */
export function fromWireOrderEvent(e: WireOrderEvent): OrderEvent {
  switch (e.type) {
    case 'resolution.found':
      return {
        type: e.type,
        at: e.at,
        venueOrderId: e.venueOrderId,
        venueState: e.venueState,
        filledQty: D.dec(e.filledQty),
        ...(e.avgPrice !== undefined ? { avgPrice: D.dec(e.avgPrice) } : {}),
      };
    case 'fill':
      return {
        type: e.type,
        at: e.at,
        fillId: e.fillId,
        qty: D.dec(e.qty),
        price: D.dec(e.price),
      };
    case 'venue.observed':
      return { type: e.type, at: e.at, venueState: e.venueState, filledQty: D.dec(e.filledQty) };
    default:
      return e;
  }
}

/**
 * The aggregate an event belongs to, used for stream queries.
 * Explicit rather than derived, so a new event type cannot silently land in the
 * wrong stream.
 */
export function streamOf(e: LedgerEvent): string {
  switch (e.kind) {
    case 'mission.observed':
      return e.observation.missionId;
    case 'mission.snapshotSealed':
    case 'mission.stageChanged':
    case 'mission.intentLinked':
    case 'mission.positionLinked':
    case 'mission.actionRecorded':
    case 'mission.reviewed':
      return e.missionId;
    case 'intent.created':
      return e.intent.intentId;
    case 'intent.refused':
    case 'override.used':
    case 'order.event':
    case 'order.anomaly':
      return e.intentId;
    case 'position.observed':
    case 'position.closed':
      return e.positionId;
    case 'divergence.opened':
    case 'divergence.acknowledged':
    case 'divergence.resolved':
      return e.divergenceId;
    case 'evaluation.holdoutOpened':
      return `evaluation.holdout:${JSON.stringify([e.receipt.holdoutId, e.receipt.questionId])}`;
    case 'evaluation.hypothesisFamilyRegistered':
      return `evaluation.hypothesis-family:${JSON.stringify([e.registration.familyId])}`;
    case 'journal.opened':
    case 'journal.closed':
    case 'journal.noted':
      return e.tradeId;
    case 'alert.raised':
    case 'alert.acknowledged':
    case 'alert.pushDispatched':
    case 'alert.pushAcknowledged':
      return e.alertId;
    case 'account.observed':
      return 'account';
    case 'instrument.observed':
      return `instrument:${e.canonical}`;
    case 'policy.updated':
      return 'policy';
    case 'drawdown.updated':
    case 'drawdown.breached':
    case 'drawdown.breachCleared':
    case 'day.rolled':
      return 'risk';
    case 'guard.lockout':
    case 'guard.released':
    case 'guard.flattenRequested':
      return 'guard';
    case 'reconcile.completed':
      return 'reconcile';
    case 'broker.connected':
    case 'broker.disconnected':
      return 'broker';
    case 'desk.started':
    case 'desk.stopping':
      return 'desk';
    default: {
      const exhaustive: never = e;
      throw new Error(`streamOf: unhandled event ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Events that must be on disk before the next action is taken.
 *
 * `intent.created` is the load-bearing one: it is fsynced before a single byte
 * reaches the broker, so a process killed mid-send always leaves evidence that
 * something may be out there. Mission lifecycle events are equally durable:
 * they are the future evaluation dataset and may not disappear on restart.
 */
export const DURABLE_KINDS: ReadonlySet<LedgerEventKind> = new Set([
  'intent.created',
  'override.used',
  'order.event',
  'position.closed',
  'guard.lockout',
  'guard.flattenRequested',
  'drawdown.breached',
  'drawdown.breachCleared',
  'policy.updated',
  'evaluation.holdoutOpened',
  'evaluation.hypothesisFamilyRegistered',
  'mission.observed',
  'mission.snapshotSealed',
  'mission.stageChanged',
  'mission.intentLinked',
  'mission.positionLinked',
  'mission.actionRecorded',
  'mission.reviewed',
]);
