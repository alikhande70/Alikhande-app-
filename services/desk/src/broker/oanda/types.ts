/**
 * The subset of v20's response shapes this adapter reads.
 *
 * Deliberately partial. Modelling every field OANDA can return would be a
 * standing maintenance cost for no benefit, and `unknown`-typed extras are
 * safer than optimistically-typed ones. Every numeric field is `string`,
 * because that is how v20 sends them — and parsing them as JS numbers would
 * throw away the exactness the rest of this system is built on.
 */

export interface OandaClientExtensions {
  readonly id?: string;
  readonly tag?: string;
  readonly comment?: string;
}

export interface OandaTransaction {
  readonly id: string;
  readonly time: string;
  readonly type?: string;
  readonly orderID?: string;
  readonly instrument?: string;
  readonly units?: string;
  readonly price?: string;
  readonly reason?: string;
  readonly rejectReason?: string;
  readonly clientExtensions?: OandaClientExtensions;
  readonly tradeOpened?: {
    readonly tradeID: string;
    readonly units: string;
    readonly price?: string;
  };
  readonly tradesClosed?: readonly {
    readonly tradeID: string;
    readonly units: string;
    readonly realizedPL?: string;
  }[];
  readonly tradeReduced?: {
    readonly tradeID: string;
    readonly units: string;
    readonly realizedPL?: string;
  };
  readonly pl?: string;
  readonly commission?: string;
  readonly financing?: string;
  readonly accountBalance?: string;
}

export interface OandaOrderResponse {
  readonly orderCreateTransaction?: OandaTransaction;
  readonly orderFillTransaction?: OandaTransaction;
  readonly orderCancelTransaction?: OandaTransaction;
  readonly orderRejectTransaction?: OandaTransaction;
  readonly lastTransactionID?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface OandaOrder {
  readonly id: string;
  readonly createTime: string;
  readonly state: string;
  readonly type: string;
  readonly instrument?: string;
  readonly units?: string;
  readonly price?: string;
  readonly filledUnits?: string;
  readonly clientExtensions?: OandaClientExtensions;
  readonly tradeID?: string;
}

export interface OandaTrade {
  readonly id: string;
  readonly instrument: string;
  readonly price: string;
  readonly openTime: string;
  readonly initialUnits: string;
  readonly currentUnits: string;
  readonly realizedPL?: string;
  readonly unrealizedPL?: string;
  readonly clientExtensions?: OandaClientExtensions;
  readonly stopLossOrder?: { readonly price?: string; readonly id?: string };
  readonly takeProfitOrder?: { readonly price?: string; readonly id?: string };
}

export interface OandaAccountSummary {
  readonly id: string;
  readonly currency: string;
  readonly balance: string;
  readonly NAV: string;
  readonly marginUsed: string;
  readonly marginAvailable: string;
  readonly unrealizedPL?: string;
  readonly hedgingEnabled?: boolean;
  readonly lastTransactionID?: string;
}

export interface OandaPriceBucket {
  readonly price: string;
  readonly liquidity?: number;
}

export interface OandaClientPrice {
  readonly type?: string;
  readonly instrument: string;
  readonly time: string;
  readonly bids: readonly OandaPriceBucket[];
  readonly asks: readonly OandaPriceBucket[];
  readonly closeoutBid?: string;
  readonly closeoutAsk?: string;
  readonly status?: string;
  readonly tradeable?: boolean;
}

export interface OandaInstrumentList {
  readonly instruments: readonly import('./mapping.js').OandaInstrument[];
}

export interface OandaTransactionPage {
  readonly transactions: readonly OandaTransaction[];
  readonly lastTransactionID?: string;
}
