import type { Dec } from '../money/decimal.js';
import * as D from '../money/decimal.js';
import type { OrderState } from './orderState.js';
import { mayExistAtVenue } from './orderState.js';

/**
 * Continuous reconciliation between what we believe and what the venue holds.
 *
 * This is the mechanism behind the product's central claim — that the app never
 * disagrees with broker reality without saying so. It runs on a timer, not only
 * on events, because the failure it exists to catch is precisely the case where
 * the event path is broken and therefore cannot tell us it is broken.
 *
 * It is written for an operator who *also* trades manually from the venue's own
 * terminal. Positions and orders that this system never created are a normal
 * occurrence, not corruption, and are surfaced as adoptable rather than as
 * errors.
 */

export interface LocalOrderView {
  readonly intentId: string;
  readonly venueOrderId?: string;
  readonly canonical: string;
  readonly state: OrderState;
  readonly requestedQty: Dec;
  readonly filledQty: Dec;
  readonly lastEventAt: number;
}

export interface VenueOrderView {
  readonly venueOrderId: string;
  /** Our client id, when the venue echoes one back. */
  readonly clientOrderId?: string;
  readonly canonical: string;
  readonly state: OrderState;
  readonly requestedQty: Dec;
  readonly filledQty: Dec;
}

export interface LocalPositionView {
  readonly positionId: string;
  readonly canonical: string;
  readonly side: 'buy' | 'sell';
  readonly volume: Dec;
  readonly entryPrice: Dec;
  readonly stopPrice?: Dec;
  readonly takeProfitPrice?: Dec;
}

export interface VenuePositionView extends LocalPositionView {
  /** Set when this system did not open the position. */
  readonly foreign?: boolean;
}

export interface AccountView {
  readonly balance: Dec;
  readonly equity: Dec;
  readonly marginUsed: Dec;
}

export type DivergenceKind =
  /** We believe an order is live; the venue does not have it. */
  | 'ORDER_MISSING_AT_VENUE'
  /** The venue has an order we have no record of. */
  | 'ORDER_UNKNOWN_TO_US'
  | 'ORDER_STATE_MISMATCH'
  | 'ORDER_FILL_MISMATCH'
  /** We believe we hold a position; the venue does not. */
  | 'POSITION_MISSING_AT_VENUE'
  /** The venue holds a position we have no record of — usually a manual trade. */
  | 'POSITION_UNKNOWN_TO_US'
  | 'POSITION_SIZE_MISMATCH'
  | 'POSITION_SIDE_MISMATCH'
  /** A live position with no stop at the venue. Unbounded risk. */
  | 'POSITION_UNPROTECTED'
  /** A protective order with no position behind it. */
  | 'ORPHANED_PROTECTIVE_ORDER'
  | 'BALANCE_MISMATCH'
  | 'EQUITY_MISMATCH';

export type Severity = 'info' | 'warning' | 'critical';

export type SuggestedAction =
  /** Query the venue by client order id until the answer is definite. */
  | 'resolve-unknown'
  /** Take the venue's view; it is authoritative. */
  | 'adopt-venue'
  /** Needs a human: the two views cannot both be true. */
  | 'alert-operator'
  /** A live position needs a stop attached now. */
  | 'attach-stop'
  /** A protective order with nothing to protect should be cancelled. */
  | 'cancel-orphan'
  | 'none';

export interface Divergence {
  readonly kind: DivergenceKind;
  readonly severity: Severity;
  readonly action: SuggestedAction;
  readonly canonical?: string;
  readonly intentId?: string;
  readonly venueOrderId?: string;
  readonly positionId?: string;
  readonly local: string;
  readonly venue: string;
  readonly detail: string;
}

export interface ReconcileInput {
  readonly localOrders: readonly LocalOrderView[];
  readonly venueOrders: readonly VenueOrderView[];
  readonly localPositions: readonly LocalPositionView[];
  readonly venuePositions: readonly VenuePositionView[];
  readonly localAccount?: AccountView;
  readonly venueAccount?: AccountView;
  readonly now: number;
  /**
   * Orders submitted within this window are not yet expected to appear at the
   * venue. Without it, every reconciliation pass would flag every in-flight
   * order as missing.
   */
  readonly settlementGraceMs: number;
  /** Tolerance for money comparisons, absorbing rounding between systems. */
  readonly moneyTolerance: Dec;
}

export interface ReconcileResult {
  readonly divergences: readonly Divergence[];
  readonly checkedAt: number;
  readonly ordersCompared: number;
  readonly positionsCompared: number;
  /** True when nothing needs attention. The common case, and worth stating. */
  readonly clean: boolean;
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const divergences: Divergence[] = [];

  const venueByOrderId = new Map(input.venueOrders.map((o) => [o.venueOrderId, o]));
  const venueByClientId = new Map(
    input.venueOrders
      .filter((o) => o.clientOrderId !== undefined)
      .map((o) => [o.clientOrderId as string, o]),
  );
  const matchedVenueOrders = new Set<string>();

  // --- Orders ---------------------------------------------------------------

  for (const local of input.localOrders) {
    if (!mayExistAtVenue(local.state)) continue;

    const match =
      (local.venueOrderId !== undefined ? venueByOrderId.get(local.venueOrderId) : undefined) ??
      venueByClientId.get(local.intentId);

    if (match === undefined) {
      const age = input.now - local.lastEventAt;
      if (age < input.settlementGraceMs) continue; // still in flight; not yet news
      divergences.push({
        kind: 'ORDER_MISSING_AT_VENUE',
        severity: local.state === 'UNKNOWN' ? 'warning' : 'critical',
        action: local.state === 'UNKNOWN' ? 'resolve-unknown' : 'alert-operator',
        canonical: local.canonical,
        intentId: local.intentId,
        ...(local.venueOrderId !== undefined ? { venueOrderId: local.venueOrderId } : {}),
        local: `${local.state}, ${D.toString(local.filledQty)}/${D.toString(local.requestedQty)}`,
        venue: 'not present',
        detail:
          `We hold ${local.canonical} order ${local.intentId} as ${local.state}, but the venue ` +
          `does not report it (last local event ${Math.round(age / 1000)}s ago).`,
      });
      continue;
    }

    matchedVenueOrders.add(match.venueOrderId);

    if (match.state !== local.state) {
      divergences.push({
        kind: 'ORDER_STATE_MISMATCH',
        severity: 'critical',
        action: 'adopt-venue',
        canonical: local.canonical,
        intentId: local.intentId,
        venueOrderId: match.venueOrderId,
        local: local.state,
        venue: match.state,
        detail: `Order ${local.intentId}: we say ${local.state}, the venue says ${match.state}.`,
      });
    }

    if (!D.eq(match.filledQty, local.filledQty)) {
      divergences.push({
        kind: 'ORDER_FILL_MISMATCH',
        severity: 'critical',
        action: 'adopt-venue',
        canonical: local.canonical,
        intentId: local.intentId,
        venueOrderId: match.venueOrderId,
        local: D.toString(local.filledQty),
        venue: D.toString(match.filledQty),
        detail:
          `Order ${local.intentId} filled quantity disagrees: local ` +
          `${D.toString(local.filledQty)}, venue ${D.toString(match.filledQty)}.`,
      });
    }
  }

  for (const venue of input.venueOrders) {
    if (matchedVenueOrders.has(venue.venueOrderId)) continue;
    if (!mayExistAtVenue(venue.state)) continue;
    divergences.push({
      kind: 'ORDER_UNKNOWN_TO_US',
      severity: 'warning',
      action: 'adopt-venue',
      canonical: venue.canonical,
      venueOrderId: venue.venueOrderId,
      local: 'no record',
      venue: `${venue.state}, ${D.toString(venue.requestedQty)}`,
      detail:
        `The venue holds ${venue.canonical} order ${venue.venueOrderId} that this system did ` +
        'not create. If you placed it from the broker terminal, adopt it so risk includes it.',
    });
  }

  // --- Positions ------------------------------------------------------------

  const venuePosById = new Map(input.venuePositions.map((p) => [p.positionId, p]));
  const matchedPositions = new Set<string>();

  for (const local of input.localPositions) {
    const match = venuePosById.get(local.positionId);
    if (match === undefined) {
      divergences.push({
        kind: 'POSITION_MISSING_AT_VENUE',
        severity: 'critical',
        action: 'alert-operator',
        canonical: local.canonical,
        positionId: local.positionId,
        local: `${local.side} ${D.toString(local.volume)}`,
        venue: 'not present',
        detail:
          `We show a ${local.side} ${D.toString(local.volume)} in ${local.canonical} that the ` +
          'venue does not report. It may have been closed elsewhere, or our view is wrong.',
      });
      continue;
    }
    matchedPositions.add(local.positionId);

    if (match.side !== local.side) {
      divergences.push({
        kind: 'POSITION_SIDE_MISMATCH',
        severity: 'critical',
        action: 'adopt-venue',
        canonical: local.canonical,
        positionId: local.positionId,
        local: local.side,
        venue: match.side,
        detail: `${local.canonical} direction disagrees: local ${local.side}, venue ${match.side}.`,
      });
    }

    if (!D.eq(match.volume, local.volume)) {
      divergences.push({
        kind: 'POSITION_SIZE_MISMATCH',
        severity: 'critical',
        action: 'adopt-venue',
        canonical: local.canonical,
        positionId: local.positionId,
        local: D.toString(local.volume),
        venue: D.toString(match.volume),
        detail:
          `${local.canonical} size disagrees: local ${D.toString(local.volume)}, ` +
          `venue ${D.toString(match.volume)}.`,
      });
    }
  }

  for (const venue of input.venuePositions) {
    if (!matchedPositions.has(venue.positionId)) {
      divergences.push({
        kind: 'POSITION_UNKNOWN_TO_US',
        severity: 'warning',
        action: 'adopt-venue',
        canonical: venue.canonical,
        positionId: venue.positionId,
        local: 'no record',
        venue: `${venue.side} ${D.toString(venue.volume)} @ ${D.toString(venue.entryPrice)}`,
        detail:
          `The venue holds ${venue.side} ${D.toString(venue.volume)} ${venue.canonical} that ` +
          'this system did not open. Adopting it brings it under the risk rules.',
      });
    }

    // The check that matters most, whoever opened the position.
    if (venue.stopPrice === undefined) {
      divergences.push({
        kind: 'POSITION_UNPROTECTED',
        severity: 'critical',
        action: 'attach-stop',
        canonical: venue.canonical,
        positionId: venue.positionId,
        local: '—',
        venue: `${venue.side} ${D.toString(venue.volume)}, no stop`,
        detail:
          `${venue.canonical} ${venue.side} ${D.toString(venue.volume)} has no stop at the ` +
          'venue. Its downside is unbounded until one is attached.',
      });
    }
  }

  // A protective order for an instrument with no position behind it will, if
  // triggered, open a position in the opposite direction.
  const openInstruments = new Set(input.venuePositions.map((p) => p.canonical));
  for (const order of input.venueOrders) {
    if (!mayExistAtVenue(order.state)) continue;
    if (openInstruments.has(order.canonical)) continue;
    if (!isProtective(order)) continue;
    divergences.push({
      kind: 'ORPHANED_PROTECTIVE_ORDER',
      severity: 'warning',
      action: 'cancel-orphan',
      canonical: order.canonical,
      venueOrderId: order.venueOrderId,
      local: 'no position',
      venue: `${order.state} ${D.toString(order.requestedQty)}`,
      detail:
        `A protective order rests on ${order.canonical} with no position behind it. If it ` +
        'triggers it will open a new position rather than close one.',
    });
  }

  // --- Account --------------------------------------------------------------

  if (input.localAccount !== undefined && input.venueAccount !== undefined) {
    const pairs: Array<[DivergenceKind, string, Dec, Dec]> = [
      ['BALANCE_MISMATCH', 'balance', input.localAccount.balance, input.venueAccount.balance],
      ['EQUITY_MISMATCH', 'equity', input.localAccount.equity, input.venueAccount.equity],
    ];
    for (const [kind, label, local, venue] of pairs) {
      const diff = D.abs(D.sub(local, venue));
      if (D.gt(diff, input.moneyTolerance)) {
        divergences.push({
          kind,
          severity: 'critical',
          action: 'adopt-venue',
          local: D.toString(local),
          venue: D.toString(venue),
          detail:
            `Account ${label} disagrees by ${D.toString(diff)}: local ${D.toString(local)}, ` +
            `venue ${D.toString(venue)}.`,
        });
      }
    }
  }

  return {
    divergences,
    checkedAt: input.now,
    ordersCompared: input.localOrders.length + input.venueOrders.length,
    positionsCompared: input.localPositions.length + input.venuePositions.length,
    clean: divergences.length === 0,
  };
}

/**
 * Whether an order is protective. Encoded as an explicit marker rather than
 * inferred from price, because inferring it wrong means cancelling a stop.
 */
function isProtective(order: VenueOrderView): boolean {
  return (
    order.clientOrderId !== undefined &&
    (order.clientOrderId.startsWith('sl-') || order.clientOrderId.startsWith('tp-'))
  );
}

/** Highest severity present, for deciding whether to wake the operator. */
export function worstSeverity(result: ReconcileResult): Severity | undefined {
  if (result.divergences.some((d) => d.severity === 'critical')) return 'critical';
  if (result.divergences.some((d) => d.severity === 'warning')) return 'warning';
  if (result.divergences.length > 0) return 'info';
  return undefined;
}

/** Divergences that block trading until resolved. */
export function blocksTrading(result: ReconcileResult): readonly Divergence[] {
  return result.divergences.filter(
    (d) =>
      d.severity === 'critical' &&
      (d.action === 'alert-operator' || d.kind === 'POSITION_UNPROTECTED'),
  );
}
