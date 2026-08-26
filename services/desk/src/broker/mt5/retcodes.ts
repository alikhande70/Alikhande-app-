/**
 * MT5 trade-server return codes that matter to the adapter.
 *
 * Source: MetaQuotes MQL5 Reference, "Return Codes of the Trade Server".
 * Keep the numeric values here instead of importing an MQL5-only enum so the
 * desk and its tests can reason about the wire protocol without MetaTrader.
 */
export const MT5_RETCODE = {
  REQUOTE: 10004,
  REJECT: 10006,
  CANCEL: 10007,
  PLACED: 10008,
  DONE: 10009,
  DONE_PARTIAL: 10010,
  ERROR: 10011,
  TIMEOUT: 10012,
  INVALID: 10013,
  INVALID_VOLUME: 10014,
  INVALID_PRICE: 10015,
  INVALID_STOPS: 10016,
  TRADE_DISABLED: 10017,
  MARKET_CLOSED: 10018,
  NO_MONEY: 10019,
  PRICE_CHANGED: 10020,
  PRICE_OFF: 10021,
  INVALID_EXPIRATION: 10022,
  ORDER_CHANGED: 10023,
  TOO_MANY_REQUESTS: 10024,
  NO_CHANGES: 10025,
  SERVER_DISABLES_AT: 10026,
  CLIENT_DISABLES_AT: 10027,
  LOCKED: 10028,
  FROZEN: 10029,
  INVALID_FILL: 10030,
  CONNECTION: 10031,
  ONLY_REAL: 10032,
  LIMIT_ORDERS: 10033,
  LIMIT_VOLUME: 10034,
  INVALID_ORDER: 10035,
  POSITION_CLOSED: 10036,
  INVALID_CLOSE_VOLUME: 10038,
  CLOSE_ORDER_EXIST: 10039,
} as const;

export type Mt5SubmitClassification =
  | { readonly outcome: 'acked'; readonly retcode: number; readonly status: string }
  | { readonly outcome: 'rejected'; readonly retcode: number; readonly reason: string }
  | { readonly outcome: 'ambiguous'; readonly retcode?: number; readonly reason: string };

const STATUS = new Map<number, string>([
  [MT5_RETCODE.PLACED, 'PLACED'],
  [MT5_RETCODE.DONE, 'DONE'],
  [MT5_RETCODE.DONE_PARTIAL, 'DONE_PARTIAL'],
]);

/**
 * These responses are explicit statements that the requested operation was not
 * accepted in its submitted form. They are safe to surface as a rejection.
 *
 * Retcodes that can mean "processing state uncertain" are intentionally NOT in
 * this set. Being conservative costs a reconciliation pass; being optimistic
 * can duplicate a live position.
 */
const DEFINITE_REJECTIONS = new Map<number, string>([
  [MT5_RETCODE.REQUOTE, 'broker requoted the request'],
  [MT5_RETCODE.REJECT, 'broker rejected the request'],
  [MT5_RETCODE.CANCEL, 'request was cancelled'],
  [MT5_RETCODE.INVALID, 'invalid request'],
  [MT5_RETCODE.INVALID_VOLUME, 'invalid volume'],
  [MT5_RETCODE.INVALID_PRICE, 'invalid price'],
  [MT5_RETCODE.INVALID_STOPS, 'invalid stops'],
  [MT5_RETCODE.TRADE_DISABLED, 'trading is disabled'],
  [MT5_RETCODE.MARKET_CLOSED, 'market is closed'],
  [MT5_RETCODE.NO_MONEY, 'insufficient funds'],
  [MT5_RETCODE.PRICE_CHANGED, 'price changed before the request could complete'],
  [MT5_RETCODE.PRICE_OFF, 'no quote was available to process the request'],
  [MT5_RETCODE.INVALID_EXPIRATION, 'invalid expiration'],
  [MT5_RETCODE.TOO_MANY_REQUESTS, 'too many requests'],
  [MT5_RETCODE.SERVER_DISABLES_AT, 'automated trading disabled by server'],
  [MT5_RETCODE.CLIENT_DISABLES_AT, 'automated trading disabled by terminal'],
  [MT5_RETCODE.FROZEN, 'order or position is frozen'],
  [MT5_RETCODE.INVALID_FILL, 'unsupported filling mode'],
  [MT5_RETCODE.ONLY_REAL, 'operation is only allowed on a real account'],
  [MT5_RETCODE.LIMIT_ORDERS, 'pending-order limit reached'],
  [MT5_RETCODE.LIMIT_VOLUME, 'position/order volume limit reached'],
  [MT5_RETCODE.INVALID_ORDER, 'order type is invalid or prohibited'],
  [MT5_RETCODE.POSITION_CLOSED, 'position is already closed'],
  [MT5_RETCODE.INVALID_CLOSE_VOLUME, 'close volume exceeds position volume'],
  [MT5_RETCODE.CLOSE_ORDER_EXIST, 'a close order already exists for the position'],
]);

/**
 * Classify one OrderSend result without pretending a missing/unclear response
 * is a rejection.
 *
 * `orderSendReturned=false` is always ambiguous here. A local failure can occur
 * before transmission, but proving that requires transport evidence from the
 * agent; the desk must not infer non-execution from the boolean alone.
 */
export function classifyMt5Submit(
  orderSendReturned: boolean,
  retcode: number | undefined,
): Mt5SubmitClassification {
  if (!orderSendReturned) {
    return {
      outcome: 'ambiguous',
      ...(retcode === undefined ? {} : { retcode }),
      reason: 'OrderSend returned false; transmission/execution cannot be proven absent',
    };
  }

  if (retcode === undefined) {
    return { outcome: 'ambiguous', reason: 'OrderSend returned no trade-server retcode' };
  }

  const status = STATUS.get(retcode);
  if (status !== undefined) return { outcome: 'acked', retcode, status };

  const rejection = DEFINITE_REJECTIONS.get(retcode);
  if (rejection !== undefined) return { outcome: 'rejected', retcode, reason: rejection };

  switch (retcode) {
    case MT5_RETCODE.ERROR:
      return { outcome: 'ambiguous', retcode, reason: 'trade-server processing error' };
    case MT5_RETCODE.TIMEOUT:
      return { outcome: 'ambiguous', retcode, reason: 'trade-server timeout' };
    case MT5_RETCODE.ORDER_CHANGED:
      return { outcome: 'ambiguous', retcode, reason: 'order state changed while processing' };
    case MT5_RETCODE.NO_CHANGES:
      return { outcome: 'ambiguous', retcode, reason: 'server reported no changes; resulting state must be read back' };
    case MT5_RETCODE.LOCKED:
      return { outcome: 'ambiguous', retcode, reason: 'request is locked for processing' };
    case MT5_RETCODE.CONNECTION:
      return { outcome: 'ambiguous', retcode, reason: 'terminal has no confirmed trade-server connection' };
    default:
      return {
        outcome: 'ambiguous',
        retcode,
        reason: `unknown MT5 retcode ${retcode}; refusing to infer non-execution`,
      };
  }
}
