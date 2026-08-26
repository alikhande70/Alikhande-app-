import type { Mt5ReconcileObservation } from './evidence.js';

/**
 * Wire contract between the desk and the Windows MT5 execution host.
 *
 * Important transport rule: every MT5 ticket/magic is a decimal string. MT5
 * uses 64-bit identifiers and JavaScript Number cannot represent that domain
 * exactly. Prices/volumes are also strings so decimal conversion stays explicit.
 */
export interface Mt5HostAccount {
  readonly login: string;
  readonly server: string;
  readonly company: string;
  readonly currency: string;
  readonly tradeMode: 'demo' | 'contest' | 'real';
  readonly positionModel: 'netting' | 'hedging';
  readonly balance: string;
  readonly equity: string;
  readonly marginUsed: string;
  readonly marginFree: string;
  readonly asOf: number;
}

/**
 * Numerical facts read directly from MT5 SymbolInfo*. These are deliberately
 * separate from Mt5HostInstrument because MT5 cannot prove Keel's semantic
 * asset metadata and because margin is request-specific (OrderCalcMargin), not
 * a trustworthy single instrument constant.
 */
export interface Mt5HostInstrumentFacts {
  readonly symbol: string;
  readonly digits: number;
  readonly point: string;
  readonly tickSize: string;
  readonly contractSize: string;
  readonly minVolume: string;
  readonly maxVolume: string;
  readonly volumeStep: string;
  readonly tickValueAccount?: string;
  readonly stopsLevel: string;
  readonly freezeLevel: string;
  readonly tradeMode: number;
  readonly asOf: number;
}

export interface Mt5HostPosition {
  readonly ticket: string;
  /** POSITION_IDENTIFIER as decimal string, stable across server-side lifecycle changes. */
  readonly positionId: string;
  readonly magic: string;
  readonly symbol: string;
  readonly canonical: string;
  readonly side: 'buy' | 'sell';
  readonly volume: string;
  readonly entryPrice: string;
  readonly stopPrice?: string;
  readonly takeProfitPrice?: string;
  readonly unrealisedPnl?: string;
  readonly openedAt: number;
}

export interface Mt5HostOrder {
  readonly ticket: string;
  readonly magic: string;
  readonly symbol: string;
  readonly canonical: string;
  readonly side: 'buy' | 'sell';
  readonly state:
    | 'PENDING_SUBMIT'
    | 'WORKING'
    | 'PARTIAL'
    | 'FILLED'
    | 'CANCEL_PENDING'
    | 'CANCELLED'
    | 'REJECTED'
    | 'UNKNOWN';
  readonly requestedQty: string;
  readonly filledQty: string;
  readonly limitPrice?: string;
  readonly stopPrice?: string;
  readonly avgFillPrice?: string;
  readonly createdAt: number;
}

export interface Mt5HostQuote {
  readonly canonical: string;
  readonly bid: string;
  readonly ask: string;
  readonly asOf: number;
}

export interface Mt5HostSnapshot {
  readonly protocolVersion: 1;
  readonly hostId: string;
  readonly terminalConnected: boolean;
  readonly tradeAllowed: boolean;
  readonly account: Mt5HostAccount;
  /** Transitional semantic specs; do not populate from guessed MT5 metadata. */
  /** Raw, broker-observed numerical instrument facts suitable for later explicit binding. */
  /**
   * Numerical instrument truth read from MT5. Required.
   *
   * This replaced a richer `instruments` array that also carried asset class,
   * timezone and a margin rate -- none of which MT5 can actually prove. That
   * array was emitted empty by the agent while this one was parsed and consumed
   * by nothing, so the binding layer was binding an always-empty source.
   */
  readonly instrumentFacts: readonly Mt5HostInstrumentFacts[];
  readonly positions: readonly Mt5HostPosition[];
  readonly orders: readonly Mt5HostOrder[];
  readonly quotes: readonly Mt5HostQuote[];
  readonly observedAt: number;
}

export interface Mt5HostOrderRequest {
  readonly clientOrderId: string;
  readonly magic: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly kind: 'market' | 'limit' | 'stop' | 'stop_limit';
  readonly volume: string;
  readonly limitPrice?: string;
  readonly stopTriggerPrice?: string;
  readonly stopLoss?: string;
  readonly takeProfit?: string;
  readonly timeInForce: string;
  readonly maxSlippage?: string;
}

export interface Mt5HostSubmitAck {
  readonly outcome: 'acked';
  readonly retcode: number;
  readonly retcodeName: string;
  readonly orderTicket?: string;
  readonly dealTicket?: string;
  readonly state: Mt5HostOrder['state'];
  readonly filledQty: string;
  readonly avgFillPrice?: string;
  readonly serverTime: number;
}

export interface Mt5HostSubmitRejected {
  readonly outcome: 'rejected';
  readonly retcode?: number;
  readonly retcodeName?: string;
  readonly reason: string;
  readonly serverTime: number;
}

export interface Mt5HostSubmitAmbiguous {
  readonly outcome: 'ambiguous';
  readonly reason: string;
  readonly serverTime: number;
}

export type Mt5HostSubmitResult = Mt5HostSubmitAck | Mt5HostSubmitRejected | Mt5HostSubmitAmbiguous;

export interface Mt5HostReconcileRequest {
  readonly magic: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly volume: string;
  readonly sentNotBefore: number;
  readonly sentNotAfter: number;
}

export interface Mt5HostReconcileResponse {
  readonly observation: Mt5ReconcileObservation;
}

export interface Mt5HostCancelRequest {
  readonly orderTicket: string;
  readonly clientOrderId: string;
  readonly magic: string;
}

export interface Mt5HostModifyRequest {
  readonly positionId: string;
  readonly stopLoss?: string;
  readonly takeProfit?: string;
}

export interface Mt5HostCloseRequest {
  readonly positionId: string;
  readonly volume?: string;
  readonly clientOrderId: string;
  readonly magic: string;
}
