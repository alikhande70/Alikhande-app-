import { describe, expect, it } from 'vitest';
import * as D from '../money/decimal.js';
import { BTCUSD_PERP, EURUSD, FIXTURE_TIME, GBPJPY, XAUUSD } from '../testing/fixtures.js';
import { FxBook } from './fx.js';
import type { SizingRequest } from './sizing.js';
import { rewardToRisk, sizePosition } from './sizing.js';

const d = D.dec;
const now = FIXTURE_TIME;

function book(): FxBook {
  return new FxBook([
    { pair: 'EURUSD', bid: d('1.08500'), ask: d('1.08510'), asOf: now },
    { pair: 'USDJPY', bid: d('150.000'), ask: d('150.010'), asOf: now },
    { pair: 'GBPUSD', bid: d('1.26500'), ask: d('1.26510'), asOf: now },
  ]);
}

function req(over: Partial<SizingRequest>): SizingRequest {
  return {
    spec: XAUUSD,
    accountCurrency: 'USD',
    riskBudget: d('100.00'),
    entry: d('2400.00'),
    stop: d('2395.00'),
    side: 'buy',
    fx: book(),
    now,
    maxQuoteAgeMs: 10_000,
    ...over,
  };
}

describe('sizePosition — the arithmetic', () => {
  it('sizes XAUUSD from risk and stop distance', () => {
    // 5.00 of price x 100 oz/lot = 500 USD per lot at the stop.
    // 100 USD budget / 500 = 0.20 lots exactly.
    const r = sizePosition(req({}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(D.toString(r.volume)).toBe('0.20');
    expect(D.toString(r.riskAtStop)).toBe('100.00');
    expect(D.toString(r.trace.lossPerLotQuote)).toBe('500.00000000');
    expect(r.trace.valuationMethod).toBe('fx-conversion');
    // USD -> USD is the identity, so no quotes were consulted.
    expect(r.trace.conversionPath).toHaveLength(0);
  });

  it('converts a JPY-quoted instrument to a USD account — the 150x trap', () => {
    // GBPJPY: 0.500 of price x 100_000 = 50_000 JPY per lot.
    // Naively treating JPY as USD gives 0.002 lots. Correct is ~0.30.
    const r = sizePosition(
      req({
        spec: GBPJPY,
        entry: d('190.000'),
        stop: d('189.500'),
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(D.toString(r.trace.lossPerLotQuote)).toBe('50000.00000000');
    expect(D.toString(r.volume)).toBe('0.30');
    expect(D.toString(r.riskAtStop)).toBe('100.00');
    expect(r.trace.conversionPath).toEqual([
      { pair: 'USDJPY', direction: 'inverse', rate: '150.000' },
    ]);
  });

  it('bridges through USD for a EUR account holding a JPY-quoted instrument', () => {
    const r = sizePosition(
      req({
        spec: GBPJPY,
        accountCurrency: 'EUR',
        entry: d('190.000'),
        stop: d('189.500'),
        riskBudget: d('100.00'),
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // JPY -> USD -> EUR, two hops, both recorded.
    expect(r.trace.conversionPath.map((h) => h.pair)).toEqual(['USDJPY', 'EURUSD']);
    expect(D.lte(r.riskAtStop, d('100.00'))).toBe(true);
  });

  it('never rounds volume up past the risk budget', () => {
    // 3.33 of price x 100 = 333 USD/lot; 100/333 = 0.3003... -> 0.30
    const r = sizePosition(req({ entry: d('2400.00'), stop: d('2396.67') }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(D.toString(r.volume)).toBe('0.30');
    expect(D.lte(r.riskAtStop, d('100.00'))).toBe(true);
    expect(D.toString(r.riskAtStop)).toBe('99.90');
    expect(D.toString(r.budgetUtilisation)).toBe('0.9990');
  });

  it('uses the venue tick value when the venue provides one', () => {
    const spec = { ...XAUUSD, tickValueAccount: d('1.00') }; // 1 USD/tick/lot
    // 500 ticks of 0.01 over a 5.00 stop -> 500 USD per lot.
    const r = sizePosition(req({ spec }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trace.valuationMethod).toBe('venue-tick-value');
    expect(D.toString(r.volume)).toBe('0.20');
    expect(r.trace.crossCheckDivergencePct).toBeUndefined();
  });

  it('flags a divergence when the venue tick value disagrees with FX maths', () => {
    // Venue claims 2 USD/tick/lot; contract-size maths says 1. One of them is
    // wrong and the operator must be told rather than shown an average.
    const spec = { ...XAUUSD, tickValueAccount: d('2.00') };
    const r = sizePosition(req({ spec }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trace.crossCheckDivergencePct).toBeDefined();
    expect(D.gt(r.trace.crossCheckDivergencePct as D.Dec, d('0.4'))).toBe(true);
    // The venue value wins — it is authoritative — but the flag is raised.
    expect(r.trace.valuationMethod).toBe('venue-tick-value');
  });

  it('computes reward:risk when a target is supplied', () => {
    const r = sizePosition(req({ target: d('2415.00') }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(D.toString(r.rewardToRisk as D.Dec)).toBe('3.00');
  });

  it('reports margin and notional in the quote currency', () => {
    const r = sizePosition(req({}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 0.20 lots x 100 oz x 2400 = 48_000 notional; 0.5% margin = 240.
    expect(D.toString(r.notionalQuote)).toBe('48000.00');
    expect(D.toString(r.marginQuote)).toBe('240.00');
  });

  it('emits volume at exactly the venue step precision, not working precision', () => {
    // A venue that wants 2dp rejects "0.20000000".
    const gold = sizePosition(req({}));
    expect(gold.ok && D.toString(gold.volume)).toBe('0.20');
    const btc = sizePosition(req({ spec: BTCUSD_PERP, entry: d('79000.0'), stop: d('78000.0') }));
    expect(btc.ok && D.toString(btc.volume)).toBe('0.1000');
  });
});

describe('sizePosition — refusals', () => {
  it('refuses a long whose stop is above entry', () => {
    const r = sizePosition(req({ side: 'buy', entry: d('2395.00'), stop: d('2400.00') }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('STOP_ON_WRONG_SIDE');
  });

  it('refuses a short whose stop is below entry', () => {
    const r = sizePosition(req({ side: 'sell', entry: d('2400.00'), stop: d('2395.00') }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('STOP_ON_WRONG_SIDE');
  });

  it('refuses a zero stop distance instead of dividing by zero', () => {
    const r = sizePosition(req({ entry: d('2400.00'), stop: d('2400.00') }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Identical prices trip the side check first; either refusal is correct,
    // what matters is that no division by zero occurs.
    expect(['ZERO_STOP_DISTANCE', 'STOP_ON_WRONG_SIDE']).toContain(r.code);
  });

  it('refuses prices that are not on the tick grid', () => {
    const r = sizePosition(req({ entry: d('2400.005'), stop: d('2395.00') }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('PRICE_OFF_TICK');
  });

  it('refuses a stop inside the venue minimum distance', () => {
    const r = sizePosition(req({ entry: d('2400.00'), stop: d('2399.90'), market: d('2400.00') }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('STOP_TOO_CLOSE');
  });

  it('refuses to size from a stale instrument spec', () => {
    const stale = { ...XAUUSD, asOf: now - 48 * 3_600_000 };
    const r = sizePosition(req({ spec: stale }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('SPEC_STALE');
  });

  it('refuses to assume 1:1 when no FX path exists', () => {
    const r = sizePosition(
      req({
        spec: GBPJPY,
        accountCurrency: 'CHF',
        entry: d('190.000'),
        stop: d('189.500'),
        fx: new FxBook([]), // no rates at all
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('CONVERSION_UNAVAILABLE');
    expect(r.detail).toMatch(/rather than assuming a 1:1 rate/);
  });

  it('refuses to use a stale FX rate', () => {
    const stale = new FxBook([
      { pair: 'USDJPY', bid: d('150.000'), ask: d('150.010'), asOf: now - 60_000 },
    ]);
    const r = sizePosition(
      req({ spec: GBPJPY, entry: d('190.000'), stop: d('189.500'), fx: stale }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('CONVERSION_UNAVAILABLE');
  });

  it('reports — rather than silently taking — a size below the venue minimum', () => {
    // A 1 USD budget over a 5.00 XAUUSD stop needs 0.002 lots. The minimum is
    // 0.01, which would risk 5 USD: five times the intent.
    const r = sizePosition(req({ riskBudget: d('1.00') }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('RISK_NOT_EXPRESSIBLE');
    expect(D.toString(r.venueBound as D.Dec)).toBe('0.01');
    expect(D.toString(r.riskAtVenueBound as D.Dec)).toBe('5.00');
    expect(r.detail).toMatch(/Widen the risk budget or tighten the stop/);
  });

  it('reports the venue cap rather than truncating a huge order', () => {
    const r = sizePosition(req({ riskBudget: d('10000000.00') }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('VOLUME_ABOVE_MAX');
    expect(D.toString(r.venueBound as D.Dec)).toBe('50.00');
  });

  it('refuses a non-positive risk budget', () => {
    expect(sizePosition(req({ riskBudget: d('0') })).ok).toBe(false);
    expect(sizePosition(req({ riskBudget: d('-5') })).ok).toBe(false);
  });
});

describe('sizePosition — instrument variety', () => {
  it('sizes a fractional-lot crypto perp', () => {
    const r = sizePosition(
      req({
        spec: BTCUSD_PERP,
        entry: d('79000.0'),
        stop: d('78000.0'),
        riskBudget: d('100.00'),
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 1000.0 of price x 1 BTC per contract = 1000 USD per unit -> 0.1 units.
    expect(D.toString(r.volume)).toBe('0.1000');
    expect(D.toString(r.riskAtStop)).toBe('100.00');
  });

  it('sizes a 5-digit FX major', () => {
    const r = sizePosition(
      req({ spec: EURUSD, entry: d('1.08500'), stop: d('1.08000'), riskBudget: d('100.00') }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 0.005 x 100_000 = 500 USD/lot -> 0.20 lots.
    expect(D.toString(r.volume)).toBe('0.20');
  });
});

describe('rewardToRisk', () => {
  it('is zero when the target is on the wrong side', () => {
    expect(D.toString(rewardToRisk(d('100'), d('95'), d('98'), 'buy'))).toBe('0');
    expect(D.toString(rewardToRisk(d('100'), d('105'), d('102'), 'sell'))).toBe('0');
  });
  it('truncates rather than flattering the ratio', () => {
    expect(D.toString(rewardToRisk(d('100'), d('95'), d('114.9'), 'buy'))).toBe('2.98');
  });
});
