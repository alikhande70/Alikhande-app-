import { describe, expect, it } from 'vitest';
import { Mt5CommandValidationError, validateMt5Command } from './command-validation.js';

const marketOrder = {
  clientOrderId: 'intent-123',
  magic: '700000000001',
  symbol: 'XAUUSD',
  side: 'buy',
  kind: 'market',
  volume: '0.10',
  stopLoss: '2310.50',
  takeProfit: '2350.50',
  timeInForce: 'GTC',
  maxSlippage: '0.50',
} as const;

describe('validateMt5Command', () => {
  it('accepts a fully specified market order without converting decimal strings', () => {
    const result = validateMt5Command('place_order', marketOrder);
    expect(result).toEqual({ command: 'place_order', payload: marketOrder });
    if (result.command === 'place_order') {
      expect(result.payload.volume).toBe('0.10');
      expect(result.payload.magic).toBe('700000000001');
    }
  });

  it('rejects executable commands with unknown fields', () => {
    expect(() =>
      validateMt5Command('place_order', { ...marketOrder, forceRealTrading: true }),
    ).toThrowError(Mt5CommandValidationError);
  });

  it('rejects malformed magic/tickets instead of coercing them to Number', () => {
    expect(() => validateMt5Command('place_order', { ...marketOrder, magic: '7e11' })).toThrow(
      'magic must be an unsigned decimal integer string',
    );
    expect(() =>
      validateMt5Command('cancel_order', {
        orderTicket: '-1',
        clientOrderId: 'intent-123',
        magic: '1',
      }),
    ).toThrow('orderTicket must be an unsigned decimal integer string');
  });

  it('requires the price fields implied by pending-order kind', () => {
    expect(() =>
      validateMt5Command('place_order', {
        ...marketOrder,
        kind: 'limit',
        limitPrice: undefined,
      }),
    ).toThrow('limit order requires limitPrice');

    expect(() =>
      validateMt5Command('place_order', {
        ...marketOrder,
        kind: 'stop',
        stopTriggerPrice: undefined,
      }),
    ).toThrow('stop order requires stopTriggerPrice');
  });

  it('requires at least one protective field for modify_position', () => {
    expect(() => validateMt5Command('modify_position', { positionId: '1234' })).toThrow(
      'modify_position requires stopLoss or takeProfit',
    );
  });

  it('accepts partial-close payloads and preserves optional volume', () => {
    expect(
      validateMt5Command('close_position', {
        positionId: '1234',
        volume: '0.03',
        clientOrderId: 'close-1',
        magic: '700000000001',
      }),
    ).toEqual({
      command: 'close_position',
      payload: {
        positionId: '1234',
        volume: '0.03',
        clientOrderId: 'close-1',
        magic: '700000000001',
      },
    });
  });

  it('rejects reversed reconciliation evidence windows', () => {
    expect(() =>
      validateMt5Command('reconcile', {
        magic: '700000000001',
        symbol: 'XAUUSD',
        side: 'buy',
        volume: '0.10',
        sentNotBefore: 2_000,
        sentNotAfter: 1_000,
      }),
    ).toThrow('sentNotAfter must be greater than or equal to sentNotBefore');
  });

  it('accepts only an empty snapshot payload', () => {
    expect(validateMt5Command('snapshot', {})).toEqual({ command: 'snapshot', payload: {} });
    expect(() => validateMt5Command('snapshot', { surprise: true })).toThrow(
      'unexpected MT5 command field(s): surprise',
    );
  });
});
