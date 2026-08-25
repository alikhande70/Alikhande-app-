import * as D from '@keel/core';
import { describe, expect, it } from 'vitest';
import type { OandaInstrument } from './mapping.js';
import {
  assetClassOf,
  OANDA_CONTRACT_SIZE,
  OandaMappingError,
  orderStateFromOanda,
  parseOandaTime,
  specFromOanda,
  splitPair,
  stepOfPrecision,
  toCanonical,
  unitsForOrder,
  volumeFromUnits,
} from './mapping.js';

const d = D.dec;

const EUR_USD: OandaInstrument = {
  name: 'EUR_USD',
  type: 'CURRENCY',
  displayName: 'EUR/USD',
  pipLocation: -4,
  displayPrecision: 5,
  tradeUnitsPrecision: 0,
  minimumTradeSize: '1',
  maximumOrderUnits: '100000000',
  marginRate: '0.0333',
};

const XAU_USD: OandaInstrument = {
  name: 'XAU_USD',
  type: 'METAL',
  displayPrecision: 3,
  tradeUnitsPrecision: 2,
  minimumTradeSize: '0.01',
  maximumOrderUnits: '5000',
  marginRate: '0.05',
};

describe('instrument naming', () => {
  it('canonicalises OANDA names', () => {
    expect(toCanonical('EUR_USD')).toBe('EURUSD');
    expect(toCanonical('XAU_USD')).toBe('XAUUSD');
  });

  it('refuses to split a name that is not a two-sided pair', () => {
    // A CFD like `DE30_EUR` splits fine; `SPX500` does not, and reporting the
    // whole thing as the base would invent an FX path that cannot exist.
    expect(() => splitPair('SPX500')).toThrow(OandaMappingError);
    expect(splitPair('EUR_USD')).toEqual(['EUR', 'USD']);
  });
});

describe('timestamps', () => {
  it('parses RFC3339 with nanosecond precision, truncating to milliseconds', () => {
    expect(parseOandaTime('2026-01-15T10:30:00.123456789Z')).toBe(
      Date.UTC(2026, 0, 15, 10, 30, 0, 123),
    );
  });

  it('parses a timestamp with no fractional part', () => {
    expect(parseOandaTime('2026-01-15T10:30:00Z')).toBe(Date.UTC(2026, 0, 15, 10, 30, 0));
  });

  it('throws rather than substituting the local clock', () => {
    // The failure mode this prevents: a venue timestamp that is silently the
    // local one, which then looks authoritative forever after.
    expect(() => parseOandaTime('not a time')).toThrow(/Refusing to substitute the local clock/);
  });
});

describe('units', () => {
  it('encodes direction in the sign', () => {
    expect(unitsForOrder(d('1000'), 'buy')).toBe('1000');
    expect(unitsForOrder(d('1000'), 'sell')).toBe('-1000');
  });

  it('preserves fractional units exactly', () => {
    expect(unitsForOrder(d('0.25'), 'sell')).toBe('-0.25');
  });

  it('refuses a zero order', () => {
    expect(() => unitsForOrder(d('0'), 'buy')).toThrow(/zero units/);
  });

  it('refuses a negative volume, because direction belongs to the side', () => {
    // Otherwise a negative volume on a 'sell' would double-negate into a buy.
    expect(() => unitsForOrder(d('-100'), 'sell')).toThrow(/non-negative/);
  });

  it('round-trips through volumeFromUnits', () => {
    for (const [vol, side] of [
      ['1000', 'buy'],
      ['1000', 'sell'],
      ['0.01', 'sell'],
    ] as const) {
      const back = volumeFromUnits(unitsForOrder(d(vol), side));
      expect(D.Decimal.toString(back.volume)).toBe(D.Decimal.toString(d(vol)));
      expect(back.side).toBe(side);
    }
  });
});

describe('instrument specs', () => {
  it('derives tick size and volume step from the venue precisions', () => {
    const spec = specFromOanda(EUR_USD, 1000);
    expect(spec.digits).toBe(5);
    expect(D.Decimal.toString(spec.tickSize)).toBe('0.00001');
    // tradeUnitsPrecision 0 means whole units.
    expect(D.Decimal.toString(spec.volumeStep)).toBe('1');
    expect(D.Decimal.toString(spec.minVolume)).toBe('1');
  });

  it('keeps a fractional unit step for metals', () => {
    const spec = specFromOanda(XAU_USD, 1000);
    expect(D.Decimal.toString(spec.volumeStep)).toBe('0.01');
    expect(D.Decimal.toString(spec.tickSize)).toBe('0.001');
    expect(spec.assetClass).toBe('metal');
  });

  it('uses a contract size of one, because OANDA trades in units not lots', () => {
    const spec = specFromOanda(EUR_USD, 1000);
    expect(D.Decimal.toString(spec.contractSize)).toBe('1');
    expect(D.Decimal.toString(OANDA_CONTRACT_SIZE)).toBe('1');
  });

  it('leaves tickValueAccount undefined so the core must convert through FX', () => {
    // OANDA reports no per-tick account value. Synthesising one would bypass
    // the core's refusal to size when no conversion path exists.
    expect(specFromOanda(EUR_USD, 1000).tickValueAccount).toBeUndefined();
  });

  it('reports no stops level, because v20 imposes none', () => {
    const spec = specFromOanda(EUR_USD, 1000);
    expect(D.Decimal.isZero(spec.stopsLevel)).toBe(true);
    expect(D.Decimal.isZero(spec.freezeLevel)).toBe(true);
  });

  it('maps asset classes, defaulting unknown CFD types to index', () => {
    expect(assetClassOf('CURRENCY')).toBe('fx');
    expect(assetClassOf('METAL')).toBe('metal');
    expect(assetClassOf('CFD')).toBe('index');
  });

  it('rejects an implausible precision rather than producing a silent zero', () => {
    expect(() => stepOfPrecision(-1)).toThrow(OandaMappingError);
    expect(() => stepOfPrecision(1.5)).toThrow(OandaMappingError);
  });
});

describe('order state', () => {
  it('treats a resting venue order as WORKING, not PENDING_SUBMIT', () => {
    // PENDING_SUBMIT means "we have not sent it". Confusing the two would
    // invite a duplicate submission of an order already live at the venue.
    expect(orderStateFromOanda('PENDING', D.Decimal.ZERO, d('1000'))).toBe('WORKING');
  });

  it('keeps partial fills visible on a cancelled order', () => {
    // The safety property: an IOC order that filled 400 of 1000 and cancelled
    // the rest has a real 400-unit position. Reporting CANCELLED would lose it.
    expect(orderStateFromOanda('CANCELLED', d('400'), d('1000'))).toBe('PARTIALLY_FILLED');
    expect(orderStateFromOanda('CANCELLED', D.Decimal.ZERO, d('1000'))).toBe('CANCELLED');
  });

  it('reports a partially filled resting order as such', () => {
    expect(orderStateFromOanda('PENDING', d('400'), d('1000'))).toBe('PARTIALLY_FILLED');
  });

  it('maps an unrecognised state to UNKNOWN rather than assuming it is benign', () => {
    expect(orderStateFromOanda('SOMETHING_NEW', D.Decimal.ZERO, d('1000'))).toBe('UNKNOWN');
  });
});
