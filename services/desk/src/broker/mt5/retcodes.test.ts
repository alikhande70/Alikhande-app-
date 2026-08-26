import { describe, expect, it } from 'vitest';
import { classifyMt5Submit, MT5_RETCODE } from './retcodes.js';

describe('MT5 trade-server classification', () => {
  it.each([
    [MT5_RETCODE.PLACED, 'PLACED'],
    [MT5_RETCODE.DONE, 'DONE'],
    [MT5_RETCODE.DONE_PARTIAL, 'DONE_PARTIAL'],
  ])('accepts documented successful retcode %s', (retcode, status) => {
    expect(classifyMt5Submit(true, retcode)).toEqual({ outcome: 'acked', retcode, status });
  });

  it.each([
    MT5_RETCODE.REQUOTE,
    MT5_RETCODE.REJECT,
    MT5_RETCODE.INVALID,
    MT5_RETCODE.INVALID_VOLUME,
    MT5_RETCODE.INVALID_PRICE,
    MT5_RETCODE.INVALID_STOPS,
    MT5_RETCODE.TRADE_DISABLED,
    MT5_RETCODE.MARKET_CLOSED,
    MT5_RETCODE.NO_MONEY,
    MT5_RETCODE.INVALID_FILL,
    MT5_RETCODE.LIMIT_ORDERS,
    MT5_RETCODE.LIMIT_VOLUME,
    MT5_RETCODE.INVALID_ORDER,
  ])('treats explicit refusal %s as rejected', (retcode) => {
    const result = classifyMt5Submit(true, retcode);
    expect(result.outcome).toBe('rejected');
  });

  it.each([
    MT5_RETCODE.ERROR,
    MT5_RETCODE.TIMEOUT,
    MT5_RETCODE.ORDER_CHANGED,
    MT5_RETCODE.NO_CHANGES,
    MT5_RETCODE.LOCKED,
    MT5_RETCODE.CONNECTION,
  ])('does not convert uncertain processing state %s into absence', (retcode) => {
    const result = classifyMt5Submit(true, retcode);
    expect(result.outcome).toBe('ambiguous');
  });

  it('treats OrderSend=false as ambiguous even when a retcode is present', () => {
    expect(classifyMt5Submit(false, MT5_RETCODE.REJECT).outcome).toBe('ambiguous');
  });

  it('treats a missing response as ambiguous', () => {
    expect(classifyMt5Submit(true, undefined)).toEqual({
      outcome: 'ambiguous',
      reason: 'OrderSend returned no trade-server retcode',
    });
  });

  it('fails closed on an unknown future retcode', () => {
    expect(classifyMt5Submit(true, 19999)).toEqual({
      outcome: 'ambiguous',
      retcode: 19999,
      reason: 'unknown MT5 retcode 19999; refusing to infer non-execution',
    });
  });
});
