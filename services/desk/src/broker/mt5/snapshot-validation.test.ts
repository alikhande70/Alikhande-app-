import { describe, expect, it } from 'vitest';
import { validateMt5HostSnapshot } from './snapshot-validation.js';

function validSnapshot(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    hostId: 'host-1',
    terminalConnected: true,
    tradeAllowed: true,
    account: {
      login: '12345678',
      server: 'LiteFinance-Demo',
      company: 'LiteFinance',
      currency: 'USD',
      tradeMode: 'demo',
      positionModel: 'hedging',
      balance: '10000.00',
      equity: '10025.50',
      marginUsed: '125.25',
      marginFree: '9900.25',
      asOf: 1_777_000_000_000,
    },
    instruments: [
      {
        symbol: 'XAUUSD',
        canonical: 'XAU_USD',
        assetClass: 'metal',
        base: 'XAU',
        quote: 'USD',
        digits: 2,
        tickSize: '0.01',
        contractSize: '100',
        minVolume: '0.01',
        maxVolume: '100',
        volumeStep: '0.01',
        tickValueAccount: '1.00',
        stopsLevel: '0',
        freezeLevel: '0',
        marginRate: '0.01',
        venueTimeZone: 'Etc/UTC',
        asOf: 1_777_000_000_000,
      },
    ],
    instrumentFacts: [
      {
        symbol: 'XAUUSD.x',
        digits: 2,
        point: '0.01',
        tickSize: '0.01',
        contractSize: '100',
        minVolume: '0.01',
        maxVolume: '100',
        volumeStep: '0.01',
        tickValueAccount: '1.00',
        stopsLevel: '0.00',
        freezeLevel: '0.00',
        tradeMode: 4,
        asOf: 1_777_000_000_000,
      },
    ],
    positions: [
      {
        ticket: '9007199254740993',
        positionId: '9007199254740994',
        magic: '18446744073709551615',
        symbol: 'XAUUSD',
        canonical: 'XAU_USD',
        side: 'buy',
        volume: '0.10',
        entryPrice: '3400.25',
        stopPrice: '3380.00',
        takeProfitPrice: '3440.00',
        unrealisedPnl: '-12.50',
        openedAt: 1_777_000_000_000,
      },
    ],
    orders: [
      {
        ticket: '9007199254740995',
        magic: '42',
        symbol: 'EURUSD',
        canonical: 'EUR_USD',
        side: 'sell',
        state: 'WORKING',
        requestedQty: '0.20',
        filledQty: '0',
        limitPrice: '1.1800',
        createdAt: 1_777_000_000_000,
      },
    ],
    quotes: [
      {
        canonical: 'XAU_USD',
        bid: '3401.10',
        ask: '3401.25',
        asOf: 1_777_000_000_000,
      },
    ],
    observedAt: 1_777_000_000_001,
  };
}

describe('validateMt5HostSnapshot', () => {
  it('accepts a complete snapshot while preserving 64-bit identifiers as strings', () => {
    const snapshot = validateMt5HostSnapshot(validSnapshot());
    expect(snapshot.positions[0]?.ticket).toBe('9007199254740993');
    expect(snapshot.positions[0]?.magic).toBe('18446744073709551615');
    expect(snapshot.account.tradeMode).toBe('demo');
    expect(snapshot.instrumentFacts?.[0]?.symbol).toBe('XAUUSD.x');
    expect(snapshot.instrumentFacts?.[0]?.tickSize).toBe('0.01');
  });

  it('rejects an incomplete snapshot instead of treating missing arrays as empty truth', () => {
    const snapshot = validSnapshot();
    delete snapshot.positions;
    expect(() => validateMt5HostSnapshot(snapshot)).toThrow(/snapshot\.positions must be an array/);
  });

  it('rejects malformed instrument facts instead of inventing a broker spec', () => {
    const snapshot = validSnapshot();
    const facts = snapshot.instrumentFacts as Array<Record<string, unknown>>;
    if (facts[0] === undefined) throw new Error('fixture missing instrument facts');
    facts[0].tickSize = '1e-2';
    expect(() => validateMt5HostSnapshot(snapshot)).toThrow(/plain decimal string/);
  });

  it('rejects unsafe MT5 identifiers outside uint64 range', () => {
    const snapshot = validSnapshot();
    const positions = snapshot.positions as Array<Record<string, unknown>>;
    if (positions[0] === undefined) throw new Error('fixture missing position');
    positions[0].ticket = '18446744073709551616';
    expect(() => validateMt5HostSnapshot(snapshot)).toThrow(/outside the MT5 uint64 domain/);
  });

  it('rejects exponent notation so financial decimals stay explicit on the wire', () => {
    const snapshot = validSnapshot();
    const account = snapshot.account as Record<string, unknown>;
    account.equity = '1e4';
    expect(() => validateMt5HostSnapshot(snapshot)).toThrow(/plain decimal string/);
  });

  it('rejects unsupported order states instead of silently widening broker truth', () => {
    const snapshot = validSnapshot();
    const orders = snapshot.orders as Array<Record<string, unknown>>;
    if (orders[0] === undefined) throw new Error('fixture missing order');
    orders[0].state = 'MAYBE_FILLED';
    expect(() => validateMt5HostSnapshot(snapshot)).toThrow(/unsupported value/);
  });

  it('rejects negative timestamps used for freshness and reconciliation', () => {
    const snapshot = validSnapshot();
    snapshot.observedAt = -1;
    expect(() => validateMt5HostSnapshot(snapshot)).toThrow(/finite non-negative number/);
  });
});
