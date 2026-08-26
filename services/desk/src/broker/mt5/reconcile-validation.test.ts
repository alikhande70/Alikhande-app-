import { describe, expect, it } from 'vitest';
import { validateMt5HostReconcileResponse } from './reconcile-validation.js';

function baseResponse() {
  return {
    observation: {
      observedAt: 1_700_000_002_000,
      connected: true,
      positionsScanned: true,
      ordersScanned: true,
      historySelected: true,
      historyFrom: 1_699_999_990_000,
      historyTo: 1_700_000_020_000,
      candidates: [],
    },
  };
}

describe('validateMt5HostReconcileResponse', () => {
  it('accepts order evidence only when orderState is explicit and recognised', () => {
    const value = baseResponse();
    value.observation.candidates = [
      {
        kind: 'order',
        ticket: '8001',
        magic: '281474976710777',
        symbol: 'XAUUSD',
        side: 'buy',
        volume: '0.01',
        price: '2500.30',
        serverTime: 1_700_000_000_500,
        orderState: 'REJECTED',
      },
    ];

    const parsed = validateMt5HostReconcileResponse(value);
    expect(parsed.observation.candidates[0]).toMatchObject({
      kind: 'order',
      orderState: 'REJECTED',
    });
  });

  it('rejects order evidence without orderState', () => {
    const value = baseResponse();
    value.observation.candidates = [
      {
        kind: 'order',
        ticket: '8001',
        magic: '281474976710777',
        symbol: 'XAUUSD',
        side: 'buy',
        volume: '0.01',
        serverTime: 1_700_000_000_500,
      },
    ];
    expect(() => validateMt5HostReconcileResponse(value)).toThrow('orderState');
  });

  it('rejects unknown orderState rather than weakening evidence semantics', () => {
    const value = baseResponse();
    value.observation.candidates = [
      {
        kind: 'order',
        ticket: '8001',
        magic: '281474976710777',
        symbol: 'XAUUSD',
        side: 'buy',
        volume: '0.01',
        serverTime: 1_700_000_000_500,
        orderState: 'SOMETHING_NEW',
      },
    ];
    expect(() => validateMt5HostReconcileResponse(value)).toThrow('orderState');
  });

  it('rejects orderState on deal evidence', () => {
    const value = baseResponse();
    value.observation.candidates = [
      {
        kind: 'deal',
        ticket: '9001',
        magic: '281474976710777',
        symbol: 'XAUUSD',
        side: 'buy',
        volume: '0.01',
        serverTime: 1_700_000_000_600,
        orderState: 'FILLED',
      },
    ];
    expect(() => validateMt5HostReconcileResponse(value)).toThrow('forbidden');
  });

  it('rejects incomplete scans and invalid history shape instead of fabricating truth', () => {
    const missing = baseResponse() as { observation: Record<string, unknown> };
    delete missing.observation.historySelected;
    expect(() => validateMt5HostReconcileResponse(missing)).toThrow('historySelected');

    const inverted = baseResponse();
    inverted.observation.historyFrom = 20_000;
    inverted.observation.historyTo = 10_000;
    expect(() => validateMt5HostReconcileResponse(inverted)).toThrow('historyTo');
  });

  it('preserves MT5 uint64 identifiers as exact strings', () => {
    const value = baseResponse();
    value.observation.candidates = [
      {
        kind: 'deal',
        ticket: '18446744073709551615',
        magic: '18446744073709551615',
        symbol: 'XAUUSD',
        side: 'sell',
        volume: '0.01',
        serverTime: 1_700_000_000_600,
        positionId: '18446744073709551615',
      },
    ];
    const parsed = validateMt5HostReconcileResponse(value);
    expect(parsed.observation.candidates[0]?.ticket).toBe('18446744073709551615');
  });
});
