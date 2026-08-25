import type { Dec, InstrumentSpec, OrderState } from '@keel/core';

/**
 * The broker abstraction (ADR-0007).
 *
 * The universal failure of broker abstractions is a lowest-common-denominator
 * interface that pretends every venue behaves the same. That pretence is where
 * duplicate fills and phantom stops come from. So an adapter here must
 * *declare* what it can guarantee, and the engine refuses behaviours the
 * adapter cannot support rather than emulating them silently.
 */

export interface BrokerCapabilities {
  /**
   * Whether our id survives the round trip.
   * `none` disables automatic retry entirely: a retry without a dedupe key can
   * duplicate a position, which is worse than any outage.
   */
  readonly clientOrderId: 'native' | 'emulated' | 'none';
  /** Whether an order can be located by our id after an ambiguous send. */
  readonly findByClientOrderId: boolean;
  /** Whether fills arrive as a push stream, or must be polled. */
  readonly streamsFills: boolean;
  /**
   * Whether a stop can be attached in the same request as the entry.
   * When false there is a window in which the position is naked, and the engine
   * must know that rather than assume protection.
   */
  readonly atomicStopLoss: boolean;
  readonly partialFills: boolean;
  readonly supportsPartialClose: boolean;
  /** Whether the venue stamps its own time. Local stamping is a fallback. */
  readonly serverTimeSource: 'broker' | 'local';
  /** Netting and hedging give "close position" different meanings. */
  readonly positionModel: 'netting' | 'hedging';
  readonly maxOrdersPerSecond: number;
}

export interface BrokerQuote {
  readonly canonical: string;
  readonly bid: Dec;
  readonly ask: Dec;
  /** Venue timestamp, not arrival time. */
  readonly asOf: number;
}

export interface BrokerAccount {
  readonly currency: string;
  readonly balance: Dec;
  readonly equity: Dec;
  readonly marginUsed: Dec;
  readonly marginFree: Dec;
  readonly asOf: number;
}

export interface BrokerPosition {
  readonly positionId: string;
  readonly canonical: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly volume: Dec;
  readonly entryPrice: Dec;
  readonly stopPrice?: Dec;
  readonly takeProfitPrice?: Dec;
  readonly unrealisedPnl?: Dec;
  readonly openedAt: number;
  /** Our id, when the venue preserved it. */
  readonly clientOrderId?: string;
}

export interface BrokerOrder {
  readonly venueOrderId: string;
  readonly clientOrderId?: string;
  readonly canonical: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly state: OrderState;
  readonly requestedQty: Dec;
  readonly filledQty: Dec;
  readonly limitPrice?: Dec;
  readonly stopPrice?: Dec;
  readonly avgFillPrice?: Dec;
  readonly createdAt: number;
}

export interface BrokerOrderRequest {
  /** Deterministic, derived from the intent id. The dedupe key end to end. */
  readonly clientOrderId: string;
  readonly canonical: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly kind: 'market' | 'limit' | 'stop' | 'stop_limit';
  readonly volume: Dec;
  readonly limitPrice?: Dec;
  readonly stopTriggerPrice?: Dec;
  /** Protective stop to attach. Honoured atomically only if capabilities say so. */
  readonly stopLoss?: Dec;
  readonly takeProfit?: Dec;
  readonly timeInForce: string;
  /** Maximum acceptable deviation from the reference price. */
  readonly maxSlippage?: Dec;
}

/**
 * The result of a submission.
 *
 * `ambiguous` is the whole point of this type existing. An adapter must return
 * it for any timeout, socket error, 5xx, or unparseable response — anything
 * short of the venue explicitly saying yes or no. Collapsing those into
 * `rejected` is the single most common cause of duplicate retail execution.
 */
export type BrokerSubmitResult =
  | {
      readonly outcome: 'acked';
      readonly venueOrderId: string;
      readonly state: OrderState;
      readonly filledQty: Dec;
      readonly avgFillPrice?: Dec;
      readonly at: number;
      readonly venueStatus?: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly reason: string;
      readonly code?: string;
      readonly at: number;
    }
  | { readonly outcome: 'ambiguous'; readonly reason: string; readonly at: number };

/** The answer to "does the venue have this order?" after an ambiguous send. */
export type LookupResult =
  | { readonly found: true; readonly order: BrokerOrder }
  /** Positive evidence of absence: the venue searched and does not have it. */
  | { readonly found: false; readonly evidence: string }
  /** We could not get a trustworthy answer. Never treat this as absence. */
  | { readonly found: 'indeterminate'; readonly reason: string };

export type BrokerEvent =
  | { readonly type: 'connected'; readonly at: number }
  | { readonly type: 'disconnected'; readonly reason: string; readonly at: number }
  | {
      readonly type: 'fill';
      readonly at: number;
      readonly fillId: string;
      readonly venueOrderId: string;
      readonly clientOrderId?: string;
      readonly qty: Dec;
      readonly price: Dec;
    }
  | { readonly type: 'order'; readonly at: number; readonly order: BrokerOrder }
  | { readonly type: 'position'; readonly at: number; readonly position: BrokerPosition }
  | {
      readonly type: 'positionClosed';
      readonly at: number;
      readonly positionId: string;
      readonly exitPrice: Dec;
      readonly netPnl: Dec;
      readonly costs: Dec;
    }
  | { readonly type: 'account'; readonly at: number; readonly account: BrokerAccount }
  | { readonly type: 'quote'; readonly at: number; readonly quote: BrokerQuote };

export type BrokerEventHandler = (e: BrokerEvent) => void;

export interface BrokerPort {
  readonly name: string;
  readonly capabilities: BrokerCapabilities;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  getInstruments(): Promise<readonly InstrumentSpec[]>;
  getAccount(): Promise<BrokerAccount>;
  getPositions(): Promise<readonly BrokerPosition[]>;
  getOpenOrders(): Promise<readonly BrokerOrder[]>;
  getQuote(canonical: string): Promise<BrokerQuote | undefined>;

  placeOrder(req: BrokerOrderRequest): Promise<BrokerSubmitResult>;
  cancelOrder(venueOrderId: string, clientOrderId: string): Promise<BrokerSubmitResult>;
  modifyPosition(
    positionId: string,
    stopLoss: Dec | undefined,
    takeProfit: Dec | undefined,
  ): Promise<BrokerSubmitResult>;
  closePosition(
    positionId: string,
    volume: Dec | undefined,
    clientOrderId: string,
  ): Promise<BrokerSubmitResult>;

  /**
   * Locate an order by our id. Required for safe recovery from an ambiguous
   * send; adapters that cannot do this declare `findByClientOrderId: false`
   * and the engine disables automatic retry for them.
   */
  findByClientOrderId(clientOrderId: string): Promise<LookupResult>;

  on(handler: BrokerEventHandler): () => void;
}

/**
 * Whether an adapter can be safely retried after an ambiguous send.
 *
 * Without both a durable client id and a way to search by it, a retry is a coin
 * flip between "no position" and "two positions". The engine consults this and
 * escalates to the operator instead.
 */
export function supportsSafeRetry(c: BrokerCapabilities): boolean {
  return c.clientOrderId !== 'none' && c.findByClientOrderId;
}

/** Human-readable summary of what this venue can and cannot guarantee. */
export function describeCapabilities(c: BrokerCapabilities): string[] {
  const notes: string[] = [];
  if (c.clientOrderId === 'none') {
    notes.push('No client order id: an ambiguous send cannot be retried automatically.');
  } else if (c.clientOrderId === 'emulated') {
    notes.push('Client order id is emulated (stored in a comment field); it may be truncated.');
  }
  if (!c.findByClientOrderId) {
    notes.push('Cannot search by client order id: unknown outcomes need manual resolution.');
  }
  if (!c.streamsFills) notes.push('Fills are polled, not streamed: expect delay on fill events.');
  if (!c.atomicStopLoss) {
    notes.push(
      'Stops cannot be attached atomically: there is a window where a new position is naked.',
    );
  }
  if (c.serverTimeSource === 'local') {
    notes.push('Venue does not stamp time: timestamps are local and may drift.');
  }
  notes.push(
    c.positionModel === 'netting'
      ? 'Netting account: opposing orders reduce the same position.'
      : 'Hedging account: opposing orders create separate positions.',
  );
  return notes;
}
