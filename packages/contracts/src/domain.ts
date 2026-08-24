import { z } from 'zod';
import {
  Certainty,
  DecimalString,
  IntentId,
  OrderKind,
  OrderState,
  Provenance,
  SessionId,
  Severity,
  Side,
  TimeInForce,
  Timestamp,
  Verdict,
} from './primitives.js';

/** Domain objects as they appear on the wire. */

export const InstrumentSpec = z.object({
  symbol: z.string(),
  canonical: z.string(),
  assetClass: z.enum(['fx', 'metal', 'index', 'commodity', 'crypto', 'equity', 'future']),
  base: z.string(),
  quote: z.string(),
  digits: z.number().int().min(0).max(12),
  tickSize: DecimalString,
  contractSize: DecimalString,
  minVolume: DecimalString,
  maxVolume: DecimalString,
  volumeStep: DecimalString,
  tickValueAccount: DecimalString.optional(),
  stopsLevel: DecimalString,
  freezeLevel: DecimalString,
  marginRate: DecimalString,
  positionModel: z.enum(['netting', 'hedging']),
  venueTimeZone: z.string(),
  asOf: Timestamp,
});
export type InstrumentSpec = z.infer<typeof InstrumentSpec>;

export const Quote = z.object({
  canonical: z.string(),
  bid: DecimalString,
  ask: DecimalString,
  spread: DecimalString,
  provenance: Provenance,
  /**
   * True when the desk considers this quote too old to trade against. The
   * client never computes this itself — one authority for staleness.
   */
  stale: z.boolean(),
});
export type Quote = z.infer<typeof Quote>;

export const Bar = z.object({
  t: Timestamp,
  o: DecimalString,
  h: DecimalString,
  l: DecimalString,
  c: DecimalString,
  v: DecimalString,
});
export type Bar = z.infer<typeof Bar>;

export const BarSeries = z.object({
  canonical: z.string(),
  timeframe: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']),
  bars: z.array(Bar),
  provenance: Provenance,
  /** True when the last bar is still forming. */
  lastBarPartial: z.boolean(),
});
export type BarSeries = z.infer<typeof BarSeries>;

export const AccountSnapshot = z.object({
  currency: z.string(),
  balance: DecimalString,
  equity: DecimalString,
  marginUsed: DecimalString,
  marginFree: DecimalString,
  /** Equity / margin used, as a percentage. Undefined with no open margin. */
  marginLevelPct: DecimalString.optional(),
  provenance: Provenance,
});
export type AccountSnapshot = z.infer<typeof AccountSnapshot>;

export const Position = z.object({
  positionId: z.string(),
  canonical: z.string(),
  symbol: z.string(),
  side: Side,
  volume: DecimalString,
  entryPrice: DecimalString,
  currentPrice: DecimalString.optional(),
  stopPrice: DecimalString.optional(),
  takeProfitPrice: DecimalString.optional(),
  unrealisedPnl: DecimalString.optional(),
  /** Money at risk to the stop, account currency. Absent means unbounded. */
  riskAccount: DecimalString.optional(),
  /** Current result expressed in multiples of the risk taken. */
  currentR: DecimalString.optional(),
  openedAt: Timestamp,
  /** The intent that opened it, when this system opened it. */
  intentId: IntentId.optional(),
  /** True when the position was opened outside this system. */
  foreign: z.boolean().default(false),
  provenance: Provenance,
});
export type Position = z.infer<typeof Position>;

export const Order = z.object({
  intentId: IntentId,
  venueOrderId: z.string().optional(),
  canonical: z.string(),
  symbol: z.string(),
  side: Side,
  kind: OrderKind,
  timeInForce: TimeInForce,
  requestedQty: DecimalString,
  filledQty: DecimalString,
  limitPrice: DecimalString.optional(),
  stopPrice: DecimalString.optional(),
  avgFillPrice: DecimalString.optional(),
  attachedStop: DecimalString.optional(),
  attachedTakeProfit: DecimalString.optional(),
  state: OrderState,
  certainty: Certainty,
  /** Rendered verbatim by the UI so the wording cannot drift from the model. */
  certaintyText: z.string(),
  /** Set when communication failed on an order known to exist. */
  knowledgeStaleSince: Timestamp.optional(),
  reason: z.string().optional(),
  resolutionAttempts: z.number().int().nonnegative(),
  createdAt: Timestamp,
  lastEventAt: Timestamp,
  provenance: Provenance,
});
export type Order = z.infer<typeof Order>;

export const RiskCheck = z.object({
  rule: z.string(),
  verdict: Verdict,
  observed: z.string(),
  limit: z.string(),
  message: z.string(),
});
export type RiskCheck = z.infer<typeof RiskCheck>;

export const RiskDecision = z.object({
  verdict: Verdict,
  checks: z.array(RiskCheck),
  cappedVolume: DecimalString.optional(),
  cappedRiskBudget: DecimalString.optional(),
  policyVersion: z.number().int(),
  evaluatedAt: Timestamp,
});
export type RiskDecision = z.infer<typeof RiskDecision>;

export const DrawdownStatus = z.object({
  status: z.enum(['ok', 'warning', 'breached', 'not-applicable']),
  buffer: DecimalString,
  bufferFraction: DecimalString,
  floor: DecimalString,
  highWater: DecimalString,
  explain: z.string(),
  breachedAt: Timestamp.optional(),
});
export type DrawdownStatus = z.infer<typeof DrawdownStatus>;

export const Divergence = z.object({
  kind: z.string(),
  severity: Severity,
  action: z.enum([
    'resolve-unknown',
    'adopt-venue',
    'alert-operator',
    'attach-stop',
    'cancel-orphan',
    'none',
  ]),
  canonical: z.string().optional(),
  intentId: IntentId.optional(),
  venueOrderId: z.string().optional(),
  positionId: z.string().optional(),
  local: z.string(),
  venue: z.string(),
  detail: z.string(),
  firstSeenAt: Timestamp,
  /** Set once the operator has acknowledged it. */
  acknowledgedAt: Timestamp.optional(),
});
export type Divergence = z.infer<typeof Divergence>;

/**
 * The desk's own health, rendered permanently in the app's header.
 * The operator should never have to guess whether what they are looking at is live.
 */
export const DeskHealth = z.object({
  brokerConnected: z.boolean(),
  brokerName: z.string(),
  /** Age of the newest broker message, ms. */
  brokerLagMs: z.number().int().nonnegative().optional(),
  referenceFeedConnected: z.boolean(),
  lastReconcileAt: Timestamp.optional(),
  openDivergences: z.number().int().nonnegative(),
  criticalDivergences: z.number().int().nonnegative(),
  /** Orders currently in an UNKNOWN state, being actively resolved. */
  unresolvedOrders: z.number().int().nonnegative(),
  lockout: z
    .object({ until: Timestamp, reason: z.string() })
    .optional(),
  /** Set when the desk has started but broker credentials have not been unlocked. */
  credentialsLocked: z.boolean(),
  deskStartedAt: Timestamp,
  version: z.string(),
});
export type DeskHealth = z.infer<typeof DeskHealth>;

export const JournalEntry = z.object({
  tradeId: z.string(),
  intentId: IntentId.optional(),
  canonical: z.string(),
  side: Side,
  openedAt: Timestamp,
  closedAt: Timestamp.optional(),
  volume: DecimalString,
  entryPrice: DecimalString,
  exitPrice: DecimalString.optional(),
  stopPrice: DecimalString,
  takeProfitPrice: DecimalString.optional(),
  riskAccount: DecimalString,
  netPnl: DecimalString.optional(),
  costs: DecimalString.optional(),
  r: DecimalString.optional(),
  /** Required before the order is sent. The one deliberate piece of friction. */
  preTradeNote: z.string(),
  postTradeNote: z.string().optional(),
  tags: z.array(z.string()).default([]),
  /** Context captured automatically at entry — never re-typed by the operator. */
  context: z.object({
    session: SessionId.optional(),
    spreadAtEntry: DecimalString.optional(),
    atrAtEntry: DecimalString.optional(),
    minutesToNextHighImpactEvent: z.number().int().optional(),
    inSessionOverlap: z.boolean().optional(),
    entrySlippage: DecimalString.optional(),
    latencyMs: z.number().int().nonnegative().optional(),
    riskCheckSummary: z.string().optional(),
    policyVersion: z.number().int().optional(),
  }),
});
export type JournalEntry = z.infer<typeof JournalEntry>;

export const Alert = z.object({
  alertId: z.string(),
  kind: z.enum([
    'price',
    'risk',
    'divergence',
    'execution',
    'drawdown',
    'connection',
    'session',
    'anomaly',
  ]),
  severity: Severity,
  title: z.string(),
  body: z.string(),
  createdAt: Timestamp,
  /** Deep link target inside the app. */
  route: z.string().optional(),
  acknowledgedAt: Timestamp.optional(),
  /** Set when a push was dispatched, so undelivered alerts can be found. */
  pushDispatchedAt: Timestamp.optional(),
  pushAcknowledgedAt: Timestamp.optional(),
});
export type Alert = z.infer<typeof Alert>;
