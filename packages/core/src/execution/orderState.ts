import type { Dec } from '../money/decimal.js';
import * as D from '../money/decimal.js';

/**
 * The order lifecycle, as a total function from (state, event) to (state | refusal).
 *
 * Two properties matter more than everything else in this file:
 *
 * 1. **A timeout is not a rejection.** An ambiguous outcome moves to `UNKNOWN`,
 *    never to `REJECTED`. Treating "no response" as "did not happen" is the
 *    single most common cause of duplicate retail execution.
 *
 * 2. **Every state carries a certainty.** The UI renders certainty, not just
 *    status, so a not-yet-confirmed order can never look like a confirmed one.
 */

export type OrderState =
  /** Intent is durably on disk. Nothing has been sent. */
  | 'PENDING_SUBMIT'
  /** Sent to the venue. No acknowledgement yet. */
  | 'SUBMITTED'
  /** Outcome is genuinely unknown. Active resolution is in progress. */
  | 'UNKNOWN'
  /** Venue acknowledged and the order is resting/working. */
  | 'WORKING'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  /** Venue explicitly refused it. */
  | 'REJECTED'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'EXPIRED'
  /** Resolution proved the venue never received it. Safe to place afresh. */
  | 'CONFIRMED_ABSENT'
  /** Never left this process — risk refusal, validation failure, no connection. */
  | 'FAILED_LOCAL';

/**
 * How much the system actually knows. This is a separate axis from state
 * because "we think it's working" and "the venue told us it's working" must
 * never render identically.
 */
export type Certainty =
  /** Confirmed by the venue. */
  | 'confirmed'
  /** Sent, awaiting confirmation. Real but unconfirmed. */
  | 'in-flight'
  /** Ambiguous. May or may not exist at the venue. */
  | 'unknown'
  /** Purely local; the venue was never involved. */
  | 'local';

export const CERTAINTY: Readonly<Record<OrderState, Certainty>> = {
  PENDING_SUBMIT: 'local',
  SUBMITTED: 'in-flight',
  UNKNOWN: 'unknown',
  WORKING: 'confirmed',
  PARTIALLY_FILLED: 'confirmed',
  FILLED: 'confirmed',
  REJECTED: 'confirmed',
  CANCEL_REQUESTED: 'in-flight',
  CANCELLED: 'confirmed',
  EXPIRED: 'confirmed',
  CONFIRMED_ABSENT: 'confirmed',
  FAILED_LOCAL: 'local',
};

const TERMINAL: ReadonlySet<OrderState> = new Set<OrderState>([
  'FILLED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
  'CONFIRMED_ABSENT',
  'FAILED_LOCAL',
]);

export function isTerminal(s: OrderState): boolean {
  return TERMINAL.has(s);
}

/** States in which the venue may still hold live exposure or a live order. */
export function mayExistAtVenue(s: OrderState): boolean {
  return (
    s === 'SUBMITTED' ||
    s === 'UNKNOWN' ||
    s === 'WORKING' ||
    s === 'PARTIALLY_FILLED' ||
    s === 'CANCEL_REQUESTED'
  );
}

/** States that must be actively resolved before the operator can be told anything. */
export function needsResolution(s: OrderState): boolean {
  return s === 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type OrderEvent =
  /** Risk passed, intent fsynced, about to transmit. */
  | { readonly type: 'submit.started'; readonly at: number }
  /** Venue acknowledged receipt. */
  | {
      readonly type: 'submit.acked';
      readonly at: number;
      readonly venueOrderId: string;
      /** Venue's own status word, kept verbatim for forensics. */
      readonly venueStatus?: string;
    }
  /** Venue explicitly refused. This is a fact, not an inference. */
  | { readonly type: 'submit.rejected'; readonly at: number; readonly reason: string }
  /**
   * Transmission produced no usable answer: timeout, socket reset, 5xx, or a
   * response we could not parse. Never collapse this into a rejection.
   */
  | { readonly type: 'submit.ambiguous'; readonly at: number; readonly reason: string }
  /** We never transmitted: risk refusal, local validation, or no connection. */
  | { readonly type: 'submit.aborted'; readonly at: number; readonly reason: string }
  /** Resolution located the order at the venue. */
  | {
      readonly type: 'resolution.found';
      readonly at: number;
      readonly venueOrderId: string;
      readonly venueState: OrderState;
      readonly filledQty: Dec;
      readonly avgPrice?: Dec;
    }
  /** Resolution proved absence: the venue searched and does not have it. */
  | { readonly type: 'resolution.absent'; readonly at: number; readonly evidence: string }
  | {
      readonly type: 'fill';
      readonly at: number;
      readonly fillId: string;
      readonly qty: Dec;
      readonly price: Dec;
    }
  | { readonly type: 'cancel.requested'; readonly at: number }
  | { readonly type: 'cancel.acked'; readonly at: number }
  | { readonly type: 'cancel.rejected'; readonly at: number; readonly reason: string }
  | { readonly type: 'expired'; readonly at: number }
  /** Periodic reconciliation observed the venue's view of this order. */
  | {
      readonly type: 'venue.observed';
      readonly at: number;
      readonly venueState: OrderState;
      readonly filledQty: Dec;
    };

export interface OrderRecord {
  readonly intentId: string;
  readonly state: OrderState;
  readonly venueOrderId?: string;
  readonly requestedQty: Dec;
  readonly filledQty: Dec;
  readonly avgFillPrice?: Dec;
  /** Fill ids already applied, so a replayed fill cannot double-count. */
  readonly appliedFillIds: readonly string[];
  readonly lastEventAt: number;
  /** Set when the state is `REJECTED`, `FAILED_LOCAL` or `UNKNOWN`. */
  readonly reason?: string;
  /** Attempts made to resolve an `UNKNOWN`. Drives escalation. */
  readonly resolutionAttempts: number;
  /**
   * Set when communication failed on an order we know exists at the venue.
   * The state is still our best belief, but it has not been confirmed since
   * this moment — existence-unknown and knowledge-stale are different problems
   * and the UI renders them differently.
   */
  readonly knowledgeStaleSince?: number;
}

export type ApplyResult =
  | { readonly ok: true; readonly record: OrderRecord; readonly anomalies: readonly Anomaly[] }
  | { readonly ok: false; readonly refusal: string };

export type AnomalySeverity = 'info' | 'warning' | 'critical';

/**
 * Something that is not an error in this reducer but must not be swallowed:
 * the venue told us something inconsistent with what we believed.
 */
export interface Anomaly {
  readonly kind:
    /** Venue filled more than we asked for. */
    | 'OVERFILL'
    /** The same fill id arrived twice; the second was ignored. */
    | 'DUPLICATE_FILL'
    /** Venue reported less progress than we had already recorded. */
    | 'REGRESSED_STATE'
    /** The venue's id for this intent changed under us. */
    | 'VENUE_ID_CHANGED'
    /** A fill arrived after we considered the order finished. */
    | 'FILL_AFTER_TERMINAL'
    /** The venue asserts a state we did not expect. */
    | 'UNSOLICITED_STATE'
    /** An order we concluded did not exist turned out to exist. */
    | 'PHANTOM_RESURRECTION'
    /** A venue search said "absent" but local evidence says otherwise. */
    | 'CONTRADICTED_ABSENCE'
    /** Reconciliation found fills that never arrived through the event path. */
    | 'MISSED_FILL_EVENTS'
    /** An observation older than our current knowledge; discarded. */
    | 'STALE_OBSERVATION'
    /** Communication failed but the order is known to exist; knowledge is stale. */
    | 'KNOWLEDGE_STALE';
  readonly severity: AnomalySeverity;
  readonly detail: string;
}

export function newOrderRecord(intentId: string, requestedQty: Dec, at: number): OrderRecord {
  return {
    intentId,
    state: 'PENDING_SUBMIT',
    requestedQty,
    filledQty: D.rescale(D.ZERO, requestedQty.s),
    appliedFillIds: [],
    lastEventAt: at,
    resolutionAttempts: 0,
  };
}

/** Any venue fact that confirms current state clears the stale-knowledge mark. */
function confirmed(rec: OrderRecord): Omit<OrderRecord, 'knowledgeStaleSince'> {
  const { knowledgeStaleSince: _drop, ...rest } = rec;
  return rest;
}

/**
 * Events split into two classes, and the split is the core safety property of
 * this module.
 *
 * **Local commands** are things *we* do. Issuing one in the wrong state is our
 * own bug, so it is refused loudly rather than absorbed.
 *
 * **Venue facts** are things the venue tells us. These are *never* refused. A
 * refused venue fact is a lost venue fact, and a lost fill is a position the
 * system believes does not exist. When a venue fact contradicts local belief,
 * the venue wins and an anomaly is raised — the venue is authoritative about
 * its own book, and our state is only ever a belief about it.
 */
export const LOCAL_COMMANDS: ReadonlySet<OrderEvent['type']> = new Set([
  'submit.started',
  'submit.aborted',
  'cancel.requested',
]);

/**
 * Everything the venue tells us. These are never refused, and they are the only
 * things that may move an order out of a terminal state.
 */
export const VENUE_FACTS: ReadonlySet<OrderEvent['type']> = new Set([
  'submit.acked',
  'submit.rejected',
  'submit.ambiguous',
  'resolution.found',
  'resolution.absent',
  'fill',
  'cancel.acked',
  'cancel.rejected',
  'expired',
  'venue.observed',
]);

/** States in which each local command is legal. */
const COMMAND_LEGAL_IN: Readonly<Record<string, ReadonlySet<OrderState>>> = {
  'submit.started': new Set<OrderState>(['PENDING_SUBMIT']),
  'submit.aborted': new Set<OrderState>(['PENDING_SUBMIT']),
  'cancel.requested': new Set<OrderState>(['WORKING', 'PARTIALLY_FILLED', 'SUBMITTED', 'UNKNOWN']),
};

/**
 * States in which we assert nothing of ours is live at the venue. A venue fact
 * arriving in one of these is always a contradiction worth escalating: either
 * our send path lied, or something else is trading this account.
 */
const BELIEVED_NOT_AT_VENUE: ReadonlySet<OrderState> = new Set<OrderState>([
  'PENDING_SUBMIT',
  'FAILED_LOCAL',
  'CONFIRMED_ABSENT',
]);

/** States in which "the venue does not have this" is new information. */
const ABSENCE_IS_INFORMATIVE: ReadonlySet<OrderState> = new Set<OrderState>([
  'UNKNOWN',
  'SUBMITTED',
]);

/**
 * A venue observation older than what we already know is discarded. Without
 * this guard a lagging reconciliation poll can flap a cancelled order back to
 * working, or resurrect a filled one.
 */
function isStaleObservation(rec: OrderRecord, ev: OrderEvent): boolean {
  return ev.at < rec.lastEventAt;
}

export function applyOrderEvent(rec: OrderRecord, ev: OrderEvent): ApplyResult {
  if (LOCAL_COMMANDS.has(ev.type)) {
    const legal = COMMAND_LEGAL_IN[ev.type];
    if (legal === undefined || !legal.has(rec.state)) {
      return {
        ok: false,
        refusal: `command '${ev.type}' is not valid in state '${rec.state}' for intent ${rec.intentId}`,
      };
    }
  }

  const anomalies: Anomaly[] = [];
  const believedAbsent = BELIEVED_NOT_AT_VENUE.has(rec.state);
  const wasTerminal = isTerminal(rec.state) && !believedAbsent;
  const ok = makeOk(rec, believedAbsent);
  const base: OrderRecord = { ...rec, lastEventAt: Math.max(rec.lastEventAt, ev.at) };

  // A venue fact in a state where we believed nothing was out there is always
  // escalated, whatever else the handler goes on to do with it.
  if (!LOCAL_COMMANDS.has(ev.type) && believedAbsent && ev.type !== 'resolution.absent') {
    anomalies.push({
      kind: 'PHANTOM_RESURRECTION',
      severity: 'critical',
      detail:
        `venue fact '${ev.type}' arrived for an intent we believed was never at the venue ` +
        `(state ${rec.state}); the venue's view is being adopted`,
    });
  }

  switch (ev.type) {
    case 'submit.started':
      return ok({ ...base, state: 'SUBMITTED' }, anomalies);

    case 'submit.aborted':
      return ok({ ...base, state: 'FAILED_LOCAL', reason: ev.reason }, anomalies);

    case 'submit.acked': {
      if (rec.venueOrderId !== undefined && rec.venueOrderId !== ev.venueOrderId) {
        anomalies.push({
          kind: 'VENUE_ID_CHANGED',
          severity: 'critical',
          detail: `venue id changed ${rec.venueOrderId} -> ${ev.venueOrderId}`,
        });
      }
      if (wasTerminal) {
        anomalies.push({
          kind: 'PHANTOM_RESURRECTION',
          severity: 'critical',
          detail:
            `venue acknowledged order ${ev.venueOrderId} for an intent we considered ` +
            `${rec.state}; the venue holds an order we believed did not exist`,
        });
      }
      // An ack does not mean filled. It means the venue has it.
      const next: OrderState = D.isZero(rec.filledQty)
        ? 'WORKING'
        : D.gte(rec.filledQty, rec.requestedQty)
          ? 'FILLED'
          : 'PARTIALLY_FILLED';
      return ok({ ...confirmed(base), state: next, venueOrderId: ev.venueOrderId }, anomalies);
    }

    case 'submit.rejected': {
      if (D.gt(rec.filledQty, D.ZERO)) {
        // A rejection for something already partly filled is a contradiction.
        // Keep the fills: they are real exposure.
        anomalies.push({
          kind: 'REGRESSED_STATE',
          severity: 'critical',
          detail:
            `venue reports rejection but ${D.toString(rec.filledQty)} is already filled; ` +
            'keeping the fills and escalating',
        });
        return ok({ ...base, reason: ev.reason }, anomalies);
      }
      return ok({ ...base, state: 'REJECTED', reason: ev.reason }, anomalies);
    }

    case 'submit.ambiguous': {
      if (D.gt(rec.filledQty, D.ZERO) || rec.venueOrderId !== undefined) {
        // We already have proof the order reached the venue, so its existence
        // is not in doubt — only our knowledge is now stale. Existence-unknown
        // and knowledge-stale are different problems and must not be conflated.
        anomalies.push({
          kind: 'KNOWLEDGE_STALE',
          severity: 'warning',
          detail:
            `${ev.reason}; order is known to exist at the venue, so state is retained ` +
            'and marked stale rather than moved to UNKNOWN',
        });
        return ok(
          { ...base, reason: ev.reason, knowledgeStaleSince: base.knowledgeStaleSince ?? ev.at },
          anomalies,
        );
      }
      return ok({ ...base, state: 'UNKNOWN', reason: ev.reason }, anomalies);
    }

    case 'resolution.found': {
      if (isStaleObservation(rec, ev)) {
        anomalies.push({
          kind: 'STALE_OBSERVATION',
          severity: 'info',
          detail: `resolution observed at ${ev.at} predates local state at ${rec.lastEventAt}`,
        });
        return ok(base, anomalies);
      }
      if (rec.venueOrderId !== undefined && rec.venueOrderId !== ev.venueOrderId) {
        anomalies.push({
          kind: 'VENUE_ID_CHANGED',
          severity: 'critical',
          detail: `resolution returned ${ev.venueOrderId}, we held ${rec.venueOrderId}`,
        });
      }
      if (D.lt(ev.filledQty, rec.filledQty)) {
        anomalies.push({
          kind: 'REGRESSED_STATE',
          severity: 'critical',
          detail:
            `venue reports filled ${D.toString(ev.filledQty)} but we had already applied ` +
            `${D.toString(rec.filledQty)}`,
        });
      }
      if (wasTerminal && rec.state !== ev.venueState) {
        anomalies.push({
          kind: 'PHANTOM_RESURRECTION',
          severity: 'critical',
          detail: `venue reports ${ev.venueState} for an order we considered ${rec.state}`,
        });
      }
      const filled = D.max(ev.filledQty, rec.filledQty);
      return ok(
        {
          ...confirmed(base),
          state: ev.venueState,
          venueOrderId: ev.venueOrderId,
          filledQty: filled,
          ...(ev.avgPrice !== undefined ? { avgFillPrice: ev.avgPrice } : {}),
          resolutionAttempts: rec.resolutionAttempts + 1,
        },
        anomalies,
      );
    }

    case 'resolution.absent': {
      const attempted = { ...base, resolutionAttempts: rec.resolutionAttempts + 1 };
      if (D.gt(rec.filledQty, D.ZERO) || rec.venueOrderId !== undefined) {
        // We hold evidence the order existed. "Absent" is then not a conclusion
        // we are entitled to draw, whatever the search returned.
        anomalies.push({
          kind: 'CONTRADICTED_ABSENCE',
          severity: 'critical',
          detail:
            'venue search reported absence, but local evidence (fills or a venue order id) ' +
            'says the order existed; manual reconciliation required',
        });
        return ok(attempted, anomalies);
      }
      if (!ABSENCE_IS_INFORMATIVE.has(rec.state)) {
        // We already have a confirmed answer. A search returning "not found"
        // (a lagging index, a purged history window) must not downgrade it.
        anomalies.push({
          kind: 'CONTRADICTED_ABSENCE',
          severity: rec.state === 'CONFIRMED_ABSENT' ? 'info' : 'warning',
          detail:
            `venue search reported absence for an order already in state ${rec.state}; ` +
            'ignored, because absence is only informative while the outcome is unknown',
        });
        return ok(attempted, anomalies);
      }
      return ok(
        {
          ...base,
          state: 'CONFIRMED_ABSENT',
          reason: ev.evidence,
          resolutionAttempts: rec.resolutionAttempts + 1,
        },
        anomalies,
      );
    }

    case 'fill': {
      if (rec.appliedFillIds.includes(ev.fillId)) {
        anomalies.push({
          kind: 'DUPLICATE_FILL',
          severity: 'info',
          detail: `fill ${ev.fillId} already applied; ignored`,
        });
        return ok(base, anomalies);
      }
      if (wasTerminal) {
        // The whole reason venue facts are never refused: a fill arriving after
        // we concluded the order was dead is real money, and losing it would
        // leave live exposure invisible to the system.
        anomalies.push({
          kind: 'FILL_AFTER_TERMINAL',
          severity: 'critical',
          detail:
            `fill ${ev.fillId} of ${D.toString(ev.qty)} arrived while the order was ` +
            `${rec.state}; the fill is real and has been applied`,
        });
      }
      const newFilled = D.add(rec.filledQty, ev.qty);
      if (D.gt(newFilled, rec.requestedQty)) {
        anomalies.push({
          kind: 'OVERFILL',
          severity: 'critical',
          detail:
            `fills total ${D.toString(newFilled)} exceed requested ` +
            `${D.toString(rec.requestedQty)}`,
        });
      }
      const avg = weightedAverage(rec.avgFillPrice, rec.filledQty, ev.price, ev.qty);
      const next: OrderState = D.gte(newFilled, rec.requestedQty) ? 'FILLED' : 'PARTIALLY_FILLED';
      return ok(
        {
          ...confirmed(base),
          state: next,
          filledQty: newFilled,
          avgFillPrice: avg,
          appliedFillIds: [...rec.appliedFillIds, ev.fillId],
        },
        anomalies,
      );
    }

    case 'cancel.requested':
      return ok({ ...base, state: 'CANCEL_REQUESTED' }, anomalies);

    case 'cancel.acked': {
      if (isStaleObservation(rec, ev)) {
        anomalies.push({
          kind: 'STALE_OBSERVATION',
          severity: 'info',
          detail: `cancel ack at ${ev.at} predates local state at ${rec.lastEventAt}; discarded`,
        });
        return ok(rec, anomalies);
      }
      if (D.gte(rec.filledQty, rec.requestedQty)) {
        anomalies.push({
          kind: 'UNSOLICITED_STATE',
          severity: 'warning',
          detail: 'cancel acknowledged for an order already fully filled',
        });
        return ok(base, anomalies);
      }
      return ok({ ...base, state: 'CANCELLED' }, anomalies);
    }

    case 'cancel.rejected': {
      if (D.gte(rec.filledQty, rec.requestedQty)) {
        // A cancel rejection on a fully filled order changes nothing. It must
        // never be able to un-fill it.
        anomalies.push({
          kind: 'UNSOLICITED_STATE',
          severity: 'info',
          detail: 'cancel rejected for an order that is already fully filled; no state change',
        });
        return ok({ ...base, reason: ev.reason }, anomalies);
      }
      if (wasTerminal) {
        // We recorded the order as finished, but the venue says our cancel
        // failed — so it may still be live. Assume live: that errs toward
        // showing exposure that might not exist rather than hiding exposure
        // that does.
        anomalies.push({
          kind: 'UNSOLICITED_STATE',
          severity: 'critical',
          detail:
            `venue rejected a cancel for an order we considered ${rec.state}; ` +
            'treating it as live until reconciliation proves otherwise',
        });
      }
      // The venue refused the cancel, so the order is still live. Return it to
      // the state its fills imply — never to CANCELLED.
      const next: OrderState = D.isZero(rec.filledQty) ? 'WORKING' : 'PARTIALLY_FILLED';
      return ok({ ...base, state: next, reason: ev.reason }, anomalies);
    }

    case 'expired': {
      if (D.gte(rec.filledQty, rec.requestedQty)) {
        anomalies.push({
          kind: 'UNSOLICITED_STATE',
          severity: 'warning',
          detail: 'expiry reported for an order already fully filled',
        });
        return ok(base, anomalies);
      }
      return ok({ ...base, state: 'EXPIRED' }, anomalies);
    }

    case 'venue.observed': {
      if (isStaleObservation(rec, ev)) {
        anomalies.push({
          kind: 'STALE_OBSERVATION',
          severity: 'info',
          detail:
            `observation at ${ev.at} predates local state at ${rec.lastEventAt}; discarded ` +
            'so a lagging poll cannot flap the order',
        });
        return ok(rec, anomalies);
      }
      if (ev.venueState === 'FILLED' && D.lt(ev.filledQty, rec.requestedQty)) {
        // The observation contradicts itself. Record it rather than trusting
        // either half: a venue reporting FILLED with a short quantity means the
        // adapter's mapping is wrong, or the venue is.
        anomalies.push({
          kind: 'UNSOLICITED_STATE',
          severity: 'critical',
          detail:
            `venue reports FILLED with only ${D.toString(ev.filledQty)} of ` +
            `${D.toString(rec.requestedQty)} filled; the observation is internally inconsistent`,
        });
      }
      if (D.lt(ev.filledQty, rec.filledQty)) {
        anomalies.push({
          kind: 'REGRESSED_STATE',
          severity: 'critical',
          detail:
            `reconciliation saw filled ${D.toString(ev.filledQty)}, we hold ` +
            `${D.toString(rec.filledQty)}; keeping the larger local figure`,
        });
        return ok(base, anomalies);
      }
      if (D.gt(ev.filledQty, rec.filledQty)) {
        // Reconciliation found fills we never received events for. Adopt the
        // quantity — the venue is authoritative — and flag it, because a missed
        // fill event means the event path is broken.
        anomalies.push({
          kind: 'MISSED_FILL_EVENTS',
          severity: 'critical',
          detail:
            `reconciliation found ${D.toString(D.sub(ev.filledQty, rec.filledQty))} of fills ` +
            'that never arrived as events; the fill event path may be broken',
        });
      }
      if (wasTerminal && ev.venueState !== rec.state) {
        anomalies.push({
          kind: 'UNSOLICITED_STATE',
          severity: 'critical',
          detail:
            `venue reports ${ev.venueState} for an order we considered ${rec.state}; ` +
            'adopting the venue view because it is authoritative about its own book',
        });
      }
      return ok({ ...confirmed(base), state: ev.venueState, filledQty: ev.filledQty }, anomalies);
    }

    default: {
      const exhaustive: never = ev;
      return { ok: false, refusal: `unhandled event ${JSON.stringify(exhaustive)}` };
    }
  }
}

/**
 * Builds the `ok` used inside `applyOrderEvent`.
 *
 * The terminal-exit escalation lives here rather than in each branch, so no
 * future branch can leave a terminal state quietly by forgetting to add the
 * anomaly. Enforcing the invariant structurally is the point: this is the rule
 * that stops a "finished" order silently coming back to life.
 */
function makeOk(prev: OrderRecord, believedAbsent: boolean) {
  return function ok(record: OrderRecord, anomalies: Anomaly[]): ApplyResult {
    const leftTerminal = isTerminal(prev.state) && record.state !== prev.state;
    if (leftTerminal && !anomalies.some((a) => a.severity === 'critical')) {
      anomalies.push({
        kind: believedAbsent ? 'PHANTOM_RESURRECTION' : 'UNSOLICITED_STATE',
        severity: 'critical',
        detail:
          `order left terminal state ${prev.state} for ${record.state}; ` +
          'a finished order changing state always requires investigation',
      });
    }
    return { ok: true, record, anomalies };
  };
}

function weightedAverage(
  prevAvg: Dec | undefined,
  prevQty: Dec,
  newPrice: Dec,
  newQty: Dec,
): Dec {
  if (prevAvg === undefined || D.isZero(prevQty)) return newPrice;
  const totalQty = D.add(prevQty, newQty);
  if (D.isZero(totalQty)) return newPrice;
  const notional = D.add(D.mul(prevAvg, prevQty), D.mul(newPrice, newQty));
  return D.div(notional, totalQty, Math.max(prevAvg.s, newPrice.s) + 2, 'half-even');
}

/**
 * Human-facing summary of what the system actually knows. Used verbatim in the
 * UI so the phrasing cannot drift from the model.
 */
export function describeCertainty(rec: OrderRecord): string {
  switch (CERTAINTY[rec.state]) {
    case 'confirmed':
      return 'Confirmed by the broker.';
    case 'in-flight':
      return 'Sent to the broker. Not yet confirmed — do not assume it is live.';
    case 'unknown':
      return `Unknown. The broker did not give a usable answer${
        rec.reason !== undefined ? ` (${rec.reason})` : ''
      }. Resolving — attempt ${rec.resolutionAttempts + 1}. Do not resend.`;
    case 'local':
      return 'Never sent to the broker.';
  }
}

/**
 * Effective certainty, accounting for stale knowledge. An order known to exist
 * but not confirmed since a communication failure is not `confirmed`.
 */
export function effectiveCertainty(rec: OrderRecord): Certainty {
  const declared = CERTAINTY[rec.state];
  if (rec.knowledgeStaleSince !== undefined && declared === 'confirmed') return 'in-flight';
  return declared;
}
