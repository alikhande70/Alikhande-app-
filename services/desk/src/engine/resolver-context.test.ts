import * as D from '@keel/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Ledger } from '../ledger/ledger.js';
import { lookupContextForIntent } from './resolver.js';

const ledgers: Ledger[] = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
});

function memoryLedger(): Ledger {
  const ledger = new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 1_000 });
  ledgers.push(ledger);
  return ledger;
}

describe('lookupContextForIntent', () => {
  it('reconstructs the fingerprint entirely from the durable ledger', () => {
    const ledger = memoryLedger();
    ledger.append({
      kind: 'intent.created',
      intent: {
        intentId: 'intent-1',
        canonical: 'XAUUSD',
        symbol: 'XAUUSD.m',
        side: 'buy',
        kind: 'market',
        timeInForce: 'GTC',
        volume: '0.07',
        preTradeNote: 'test',
        tags: [],
        clientOrderId: 'k-order-1',
      },
      risk: { verdict: 'pass', checks: [], policyVersion: 1, evaluatedAt: 900 },
    });
    ledger.append({
      kind: 'order.event',
      intentId: 'intent-1',
      event: { type: 'submit.started', at: 1_100 },
    });
    ledger.append({
      kind: 'order.event',
      intentId: 'intent-1',
      event: { type: 'submit.ambiguous', at: 1_850, reason: 'socket reset after transmission' },
    });

    const context = lookupContextForIntent(ledger, 'intent-1');
    expect(context).toMatchObject({
      canonical: 'XAUUSD',
      symbol: 'XAUUSD.m',
      side: 'buy',
      sentNotBefore: 1_100,
      sentNotAfter: 1_850,
    });
    expect(context === undefined ? undefined : D.Decimal.toString(context.volume)).toBe('0.07');
  });

  it('never invents a send window when transmission was not durably started', () => {
    const ledger = memoryLedger();
    ledger.append({
      kind: 'intent.created',
      intent: {
        intentId: 'intent-local',
        canonical: 'EURUSD',
        symbol: 'EURUSD',
        side: 'sell',
        kind: 'market',
        timeInForce: 'GTC',
        volume: '0.10',
        preTradeNote: '',
        tags: [],
        clientOrderId: 'k-local',
      },
      risk: { verdict: 'pass', checks: [], policyVersion: 1, evaluatedAt: 900 },
    });

    expect(lookupContextForIntent(ledger, 'intent-local')).toBeUndefined();
  });

  it('uses the full persisted send interval rather than narrowing it after hindsight', () => {
    const ledger = memoryLedger();
    ledger.append({
      kind: 'intent.created',
      intent: {
        intentId: 'intent-wide',
        canonical: 'GBPJPY',
        symbol: 'GBPJPY',
        side: 'sell',
        kind: 'limit',
        timeInForce: 'GTC',
        volume: '0.20',
        limitPrice: '207.50',
        preTradeNote: '',
        tags: [],
        clientOrderId: 'k-wide',
      },
      risk: { verdict: 'pass', checks: [], policyVersion: 1, evaluatedAt: 900 },
    });
    ledger.append({
      kind: 'order.event',
      intentId: 'intent-wide',
      event: { type: 'submit.started', at: 2_000 },
    });
    ledger.append({
      kind: 'order.event',
      intentId: 'intent-wide',
      event: { type: 'submit.ambiguous', at: 5_000, reason: 'timeout' },
    });

    expect(lookupContextForIntent(ledger, 'intent-wide')).toMatchObject({
      sentNotBefore: 2_000,
      sentNotAfter: 5_000,
    });
  });
});
