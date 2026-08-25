import { z } from 'zod';
import {
  AccountSnapshot,
  Alert,
  BarSeries,
  DeskHealth,
  Divergence,
  DrawdownStatus,
  InstrumentSpec,
  JournalEntry,
  Order,
  Position,
  Quote,
  RiskDecision,
} from './domain.js';
import {
  DecimalString,
  IntentId,
  OrderKind,
  ProblemDetail,
  Side,
  TimeInForce,
  Timestamp,
} from './primitives.js';

/** Command and query shapes for the desk's HTTP surface. */

/**
 * An order request.
 *
 * Note what is *absent*: there is no `volume` field on the primary path. The
 * operator states a stop and a risk budget, and the desk derives the size from
 * the venue's contract specification. Letting the client compute size would put
 * the most safety-critical arithmetic in the least trustworthy place.
 */
export const PlaceOrderRequest = z.object({
  intentId: IntentId,
  canonical: z.string(),
  side: Side,
  kind: OrderKind,
  timeInForce: TimeInForce.default('GTC'),
  /** Required for limit/stop orders; ignored for market. */
  price: DecimalString.optional(),
  /** Mandatory unless policy allows stopless entries. */
  stopPrice: DecimalString.optional(),
  takeProfitPrice: DecimalString.optional(),
  /** Risk as a fraction of equity. Capped by policy; the policy always wins. */
  riskPct: DecimalString.optional(),
  /** Alternative to `riskPct`: an absolute budget in account currency. */
  riskAmount: DecimalString.optional(),
  /**
   * Explicit volume. Accepted only with `acknowledgeManualSize`, because it
   * bypasses risk-derived sizing.
   */
  explicitVolume: DecimalString.optional(),
  acknowledgeManualSize: z.boolean().default(false),
  preTradeNote: z.string().max(2000),
  tags: z.array(z.string().max(32)).max(10).default([]),
  /**
   * The quote the operator was looking at. The desk refuses if the market has
   * moved beyond `maxSlippage` since, so a stale screen cannot become a fill.
   */
  referenceQuote: z.object({ bid: DecimalString, ask: DecimalString, asOf: Timestamp }).optional(),
  maxSlippage: DecimalString.optional(),
  /** Break-glass. Never silent: recorded as its own ledger event. */
  override: z.object({ reason: z.string().min(10).max(500) }).optional(),
});
export type PlaceOrderRequest = z.infer<typeof PlaceOrderRequest>;

/**
 * The reply to a submission.
 *
 * `accepted: true` means *the desk has durably recorded the intent and will
 * pursue it*. It does not mean the order is live at the venue, and the field is
 * named to make that hard to misread. Live state arrives over the realtime
 * channel, from the venue.
 */
export const PlaceOrderResponse = z.object({
  intentId: IntentId,
  accepted: z.boolean(),
  order: Order.optional(),
  risk: RiskDecision,
  /** Present when the request was refused before transmission. */
  problem: ProblemDetail.optional(),
  /** True when this intentId had already been submitted; the prior outcome is returned. */
  deduplicated: z.boolean().default(false),
});
export type PlaceOrderResponse = z.infer<typeof PlaceOrderResponse>;

/** Dry-run the full risk evaluation and sizing without sending anything. */
export const PreviewOrderRequest = PlaceOrderRequest.omit({
  intentId: true,
  preTradeNote: true,
}).extend({ preTradeNote: z.string().max(2000).default('') });
export type PreviewOrderRequest = z.infer<typeof PreviewOrderRequest>;

export const PreviewOrderResponse = z.object({
  risk: RiskDecision,
  sizing: z
    .object({
      ok: z.literal(true),
      volume: DecimalString,
      riskAtStop: DecimalString,
      budgetUtilisation: DecimalString,
      notionalQuote: DecimalString,
      marginQuote: DecimalString,
      rewardToRisk: DecimalString.optional(),
      valuationMethod: z.enum(['venue-tick-value', 'fx-conversion']),
      conversionPath: z.array(
        z.object({ pair: z.string(), direction: z.string(), rate: z.string() }),
      ),
      crossCheckDivergencePct: DecimalString.optional(),
    })
    .or(
      z.object({
        ok: z.literal(false),
        code: z.string(),
        detail: z.string(),
        venueBound: DecimalString.optional(),
        riskAtVenueBound: DecimalString.optional(),
      }),
    ),
});
export type PreviewOrderResponse = z.infer<typeof PreviewOrderResponse>;

export const CancelOrderRequest = z.object({
  intentId: IntentId,
  /** Idempotency key for the cancel itself. */
  requestId: z.string().uuid(),
});
export type CancelOrderRequest = z.infer<typeof CancelOrderRequest>;

export const ModifyPositionRequest = z.object({
  positionId: z.string(),
  requestId: z.string().uuid(),
  stopPrice: DecimalString.optional(),
  takeProfitPrice: DecimalString.optional(),
  /** Move the stop to entry. Convenience for the most common adjustment. */
  moveStopToBreakeven: z.boolean().default(false),
});
export type ModifyPositionRequest = z.infer<typeof ModifyPositionRequest>;

export const ClosePositionRequest = z.object({
  positionId: z.string(),
  requestId: z.string().uuid(),
  /** Partial close. Omitted means close in full. */
  volume: DecimalString.optional(),
  reason: z.string().max(500).optional(),
});
export type ClosePositionRequest = z.infer<typeof ClosePositionRequest>;

/**
 * Flatten everything and stop trading.
 *
 * Deliberately its own endpoint rather than a loop of closes: under stress the
 * operator needs one action with one confirmation, and the desk needs to be
 * able to keep retrying the whole set until the venue reports flat.
 */
export const PanicRequest = z.object({
  requestId: z.string().uuid(),
  confirmPhrase: z.literal('FLATTEN'),
  lockoutMinutes: z.number().int().min(0).max(1440).default(0),
});
export type PanicRequest = z.infer<typeof PanicRequest>;

export const PanicResponse = z.object({
  requestId: z.string().uuid(),
  positionsTargeted: z.number().int(),
  ordersTargeted: z.number().int(),
  /** The desk keeps working until the venue reports flat; this is the start, not the end. */
  status: z.enum(['in-progress', 'complete', 'partial']),
  detail: z.string(),
});
export type PanicResponse = z.infer<typeof PanicResponse>;

export const StateSnapshot = z.object({
  health: DeskHealth,
  account: AccountSnapshot.optional(),
  positions: z.array(Position),
  orders: z.array(Order),
  divergences: z.array(Divergence),
  drawdown: DrawdownStatus.optional(),
  alerts: z.array(Alert),
  instruments: z.array(InstrumentSpec),
  quotes: z.array(Quote),
  serverTime: Timestamp,
});
export type StateSnapshot = z.infer<typeof StateSnapshot>;

export const JournalQuery = z.object({
  from: Timestamp.optional(),
  to: Timestamp.optional(),
  canonical: z.string().optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
export type JournalQuery = z.infer<typeof JournalQuery>;

export const JournalResponse = z.object({
  entries: z.array(JournalEntry),
  total: z.number().int().nonnegative(),
});
export type JournalResponse = z.infer<typeof JournalResponse>;

export const BarsQuery = z.object({
  canonical: z.string(),
  timeframe: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']),
  limit: z.number().int().min(1).max(2000).default(500),
  before: Timestamp.optional(),
});
export type BarsQuery = z.infer<typeof BarsQuery>;

export const BarsResponse = BarSeries;
export type BarsResponse = z.infer<typeof BarsResponse>;

/** A question for the copilot. Read-only by construction (ADR-0010). */
export const CopilotAskRequest = z.object({
  question: z.string().min(1).max(2000),
  /** Continue an existing thread. */
  conversationId: z.string().uuid().optional(),
});
export type CopilotAskRequest = z.infer<typeof CopilotAskRequest>;

export const CopilotCitation = z.object({
  /** Which read-only tool produced the value. */
  tool: z.string(),
  /** Record ids the claim rests on. */
  recordIds: z.array(z.string()),
  /** The exact figure cited, for the validator to re-check. */
  value: z.string().optional(),
});
export type CopilotCitation = z.infer<typeof CopilotCitation>;

export const CopilotAskResponse = z.object({
  conversationId: z.string().uuid(),
  answer: z.string(),
  citations: z.array(CopilotCitation),
  /**
   * Set when the citation validator removed a claim the model could not
   * support. Surfaced rather than hidden — a silently-edited answer is worse
   * than a visibly-incomplete one.
   */
  redactions: z.array(z.string()).default([]),
  toolCalls: z.array(z.object({ tool: z.string(), args: z.string() })).default([]),
});
export type CopilotAskResponse = z.infer<typeof CopilotAskResponse>;
