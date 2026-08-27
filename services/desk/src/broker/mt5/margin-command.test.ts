import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateMt5Command } from './command-validation.js';

const VALID = {
  symbol: 'XAUUSD',
  side: 'buy',
  kind: 'market',
  volume: '0.10',
  price: '2500.25',
};

describe('MT5 calc_margin command', () => {
  it('accepts one exact positive proposal fingerprint', () => {
    expect(validateMt5Command('calc_margin', VALID)).toEqual({
      command: 'calc_margin',
      payload: VALID,
    });
  });

  it.each([
    ['zero volume', { ...VALID, volume: '0' }],
    ['negative volume', { ...VALID, volume: '-0.10' }],
    ['exponent volume', { ...VALID, volume: '1e-1' }],
    ['zero price', { ...VALID, price: '0.00' }],
    ['bad side', { ...VALID, side: 'long' }],
    ['bad kind', { ...VALID, kind: 'instant' }],
    ['missing symbol', { ...VALID, symbol: undefined }],
    ['unknown field', { ...VALID, leverage: '100' }],
  ])('fails closed for %s', (_label, value) => {
    expect(() => validateMt5Command('calc_margin', value)).toThrow();
  });

  it('keeps the MQL5 margin primitive read-only', () => {
    const marginSource = readFileSync(
      new URL('../../../../../../mt5/KeelMargin.mqh', import.meta.url),
      'utf8',
    );
    const agentSource = readFileSync(
      new URL('../../../../../../mt5/KeelAgent.mq5', import.meta.url),
      'utf8',
    );

    expect(marginSource).toContain('OrderCalcMargin(');
    expect(marginSource).not.toContain('OrderSend(');
    expect(marginSource).not.toContain('OrderSendAsync(');
    expect(agentSource).toContain('#include "KeelMargin.mqh"');
    expect(agentSource).toContain('command=="calc_margin"');
  });
});
