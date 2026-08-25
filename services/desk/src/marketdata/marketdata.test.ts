import * as D from '@keel/core';
import { describe, expect, it } from 'vitest';
import { TestClock } from '../sim/clock.js';
import { BarAggregator, atr, bucketStart, findGaps, resample } from './aggregator.js';
import { DEFAULT_DIVERGENCE, blocksOrderEntry, compareplanes } from './divergence.js';
import type { Bar, Tick } from './port.js';
import { budgetFor, describeAge, freshness, isCrossed, isTradeable, mid, spread } from './port.js';
import { CALM, HOSTILE, SyntheticProvider } from './synthetic.js';

const d = D.dec;
const T0 = Date.UTC(2026, 5, 15, 14, 0);

function tick(over: Partial<Tick> = {}): Tick {
  return {
    canonical: 'XAUUSD',
    bid: d('2400.00'),
    ask: d('2400.30'),
    asOf: T0,
    plane: 'execution',
    origin: 'test',
    ...over,
  };
}

describe('staleness is decided in one place', () => {
  const budget = { liveMs: 3_000, staleMs: 30_000 };

  it('classifies by the source timestamp, not arrival', () => {
    expect(freshness(T0, T0 + 1_000, budget)).toBe('live');
    expect(freshness(T0, T0 + 10_000, budget)).toBe('aging');
    expect(freshness(T0, T0 + 60_000, budget)).toBe('stale');
  });

  it('only "live" may build an order', () => {
    expect(isTradeable('live')).toBe(true);
    expect(isTradeable('aging')).toBe(false);
    expect(isTradeable('stale')).toBe(false);
  });

  it('treats a venue timestamp in the future as live, not as an error', () => {
    // Clock skew between us and the venue is normal and must not be dramatic.
    expect(freshness(T0 + 5_000, T0, budget)).toBe('live');
  });

  it('uses a different budget for a quiet FX pair than for a crypto perp', () => {
    expect(budgetFor('fx').staleMs).toBeGreaterThan(budgetFor('crypto').staleMs);
  });

  it('describes age as a fact, not a spinner', () => {
    expect(describeAge(500)).toBe('500ms');
    expect(describeAge(45_000)).toBe('45s');
    expect(describeAge(300_000)).toBe('5m');
    expect(describeAge(7_200_000)).toBe('2h');
  });
});

describe('quote sanity', () => {
  it('computes mid and spread exactly', () => {
    expect(D.Decimal.toString(mid(tick()))).toBe('2400.150');
    expect(D.Decimal.toString(spread(tick()))).toBe('0.30');
  });

  it('detects a crossed book, which is impossible and must never reach sizing', () => {
    expect(isCrossed(tick())).toBe(false);
    expect(isCrossed(tick({ bid: d('2400.50'), ask: d('2400.30') }))).toBe(true);
  });
});

describe('bar aggregation', () => {
  it('buckets to UTC boundaries', () => {
    expect(bucketStart(Date.UTC(2026, 5, 15, 14, 7, 30), '5m')).toBe(Date.UTC(2026, 5, 15, 14, 5));
    expect(bucketStart(Date.UTC(2026, 5, 15, 14, 7, 30), '1h')).toBe(Date.UTC(2026, 5, 15, 14, 0));
    expect(bucketStart(Date.UTC(2026, 5, 15, 14, 7, 30), '1d')).toBe(Date.UTC(2026, 5, 15));
  });

  it('builds OHLC from ticks and closes the bar at the boundary', () => {
    const agg = new BarAggregator({ timeframe: '1m', retain: 10 });
    agg.push(tick({ bid: d('2400.00'), ask: d('2400.00'), asOf: T0 }));
    agg.push(tick({ bid: d('2405.00'), ask: d('2405.00'), asOf: T0 + 10_000 }));
    agg.push(tick({ bid: d('2395.00'), ask: d('2395.00'), asOf: T0 + 20_000 }));
    agg.push(tick({ bid: d('2402.00'), ask: d('2402.00'), asOf: T0 + 30_000 }));
    expect(agg.bars()).toHaveLength(0); // still forming

    const r = agg.push(tick({ bid: d('2410.00'), ask: d('2410.00'), asOf: T0 + 61_000 }));
    const done = r.completed as Bar;
    expect(D.Decimal.toString(done.o)).toBe('2400.000');
    expect(D.Decimal.toString(done.h)).toBe('2405.000');
    expect(D.Decimal.toString(done.l)).toBe('2395.000');
    expect(D.Decimal.toString(done.c)).toBe('2402.000');
  });

  it('marks the forming bar as partial and never mixes it with completed ones', () => {
    const agg = new BarAggregator({ timeframe: '1m', retain: 10 });
    agg.push(tick({ asOf: T0 }));
    agg.push(tick({ asOf: T0 + 61_000 }));
    const snap = agg.snapshot();
    expect(snap.lastBarPartial).toBe(true);
    expect(snap.bars).toHaveLength(2);
    expect(agg.bars()).toHaveLength(1); // completed only
  });

  it('drops a late tick rather than rewriting a bar already drawn', () => {
    const agg = new BarAggregator({ timeframe: '1m', retain: 10 });
    agg.push(tick({ asOf: T0 }));
    agg.push(tick({ asOf: T0 + 61_000 }));
    const r = agg.push(tick({ bid: d('9999.00'), ask: d('9999.00'), asOf: T0 + 5_000 }));
    expect(r.dropped).toBe('late');
    const first = agg.bars()[0] as Bar;
    expect(D.Decimal.lt(first.h, d('9999'))).toBe(true);
  });

  it('bounds memory by discarding the oldest bars', () => {
    const agg = new BarAggregator({ timeframe: '1m', retain: 3 });
    for (let i = 0; i < 20; i++) agg.push(tick({ asOf: T0 + i * 61_000 }));
    expect(agg.bars().length).toBeLessThanOrEqual(3);
  });

  it('resamples only into exact multiples', () => {
    const agg = new BarAggregator({ timeframe: '1m', retain: 100 });
    for (let i = 0; i < 20; i++) {
      agg.push(tick({ bid: d(`240${i % 10}.00`), ask: d(`240${i % 10}.00`), asOf: T0 + i * 61_000 }));
    }
    const five = resample(agg.bars(), '1m', '5m');
    expect(five.length).toBeGreaterThan(0);
    expect(five.length).toBeLessThan(agg.bars().length);
    expect(() => resample(agg.bars(), '15m', '1h')).not.toThrow();
    expect(() => resample(agg.bars(), '4h', '1d')).not.toThrow(); // 24h / 4h = 6, exact
    // Downsampling is not resampling: you cannot make 4h bars out of daily ones.
    expect(() => resample(agg.bars(), '1d', '4h')).toThrow(/boundaries would drift/);
  });

  it('finds missing buckets', () => {
    const bars: Bar[] = [
      { t: T0, o: d('1'), h: d('1'), l: d('1'), c: d('1'), v: d('1') },
      { t: T0 + 60_000, o: d('1'), h: d('1'), l: d('1'), c: d('1'), v: d('1') },
      { t: T0 + 300_000, o: d('1'), h: d('1'), l: d('1'), c: d('1'), v: d('1') },
    ];
    const gaps = findGaps(bars, '1m');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.missing).toBe(3);
  });

  it('computes ATR exactly, or not at all', () => {
    const bars: Bar[] = Array.from({ length: 20 }, (_, i) => ({
      t: T0 + i * 60_000,
      o: d('2400.00'),
      h: d('2410.00'),
      l: d('2390.00'),
      c: d('2400.00'),
      v: d('1'),
    }));
    expect(D.Decimal.toString(atr(bars, 14) as D.Dec)).toBe('20.0000');
    expect(atr(bars.slice(0, 3), 14)).toBeUndefined();
  });
});

describe('cross-plane divergence', () => {
  it('says nothing useful when a plane is missing', () => {
    expect(compareplanes('XAUUSD', undefined, tick(), T0).verdict).toBe('insufficient-data');
  });

  it('agrees when the planes agree', () => {
    const exec = tick({ plane: 'execution' });
    const ref = tick({ plane: 'reference', bid: d('2400.10'), ask: d('2400.20') });
    const r = compareplanes('XAUUSD', exec, ref, T0 + 500);
    expect(r.verdict).toBe('ok');
    expect(blocksOrderEntry(r.verdict)).toBe(false);
  });

  it('detects a frozen broker feed while the connection still looks healthy', () => {
    const exec = tick({ plane: 'execution', asOf: T0 - 120_000 });
    const ref = tick({ plane: 'reference', asOf: T0 });
    const r = compareplanes('XAUUSD', exec, ref, T0);
    expect(r.verdict).toBe('execution-frozen');
    expect(r.detail).toMatch(/connection may still look healthy/);
    // And that is the one verdict that stops order entry.
    expect(blocksOrderEntry(r.verdict)).toBe(true);
  });

  it('treats a stale reference as a charting problem, not a trading one', () => {
    const exec = tick({ plane: 'execution', asOf: T0 });
    const ref = tick({ plane: 'reference', asOf: T0 - 120_000 });
    const r = compareplanes('XAUUSD', exec, ref, T0);
    expect(r.verdict).toBe('reference-frozen');
    expect(r.detail).toMatch(/broker prices are unaffected/);
    expect(blocksOrderEntry(r.verdict)).toBe(false);
  });

  it('checks freshness before price, so a freeze is not reported as a dislocation', () => {
    // A frozen execution feed will also show a big price difference. Reporting
    // that as "price divergence" would describe the freeze, not the market.
    const exec = tick({ plane: 'execution', bid: d('2300.00'), ask: d('2300.30'), asOf: T0 - 120_000 });
    const ref = tick({ plane: 'reference', asOf: T0 });
    expect(compareplanes('XAUUSD', exec, ref, T0).verdict).toBe('execution-frozen');
  });

  it('reports a genuine price disagreement without naming a culprit', () => {
    const exec = tick({ plane: 'execution', bid: d('2400.00'), ask: d('2400.30') });
    const ref = tick({ plane: 'reference', bid: d('2420.00'), ask: d('2420.30') });
    const r = compareplanes('XAUUSD', exec, ref, T0 + 500);
    expect(r.verdict).toBe('price-divergence');
    expect(r.detail).toMatch(/cannot tell which/);
    expect(D.Decimal.gt(r.differenceFraction as D.Dec, DEFAULT_DIVERGENCE.thresholdFraction)).toBe(true);
  });
});

describe('the synthetic feed produces the pathologies we claim to survive', () => {
  // Pathologies are opt-in per test: HOSTILE's freezes legitimately eat most of
  // a short window, which would make a scheduling assertion measure the wrong
  // thing.
  function makeProvider(seed: number, pathologies = CALM) {
    const clock = new TestClock(T0);
    const provider = new SyntheticProvider({
      clock,
      seed,
      instruments: [D.Fixtures.XAUUSD],
      startPrices: { XAUUSD: '2400.00' },
      pathologies,
      tickIntervalMs: 1_000,
      plane: 'execution',
    });
    return { clock, provider };
  }

  it('emits ticks on a schedule', async () => {
    const { clock, provider } = makeProvider(1, CALM);
    const ticks: Tick[] = [];
    provider.on((e) => {
      if (e.type === 'tick') ticks.push(e.tick);
    });
    await provider.connect();
    await provider.subscribe(['XAUUSD']);
    await clock.advance(60_000);
    expect(ticks.length).toBeGreaterThan(30);
    expect(ticks.every((t) => t.plane === 'execution')).toBe(true);
  });

  it('produces a frozen feed on demand — quotes stop, connection stays up', async () => {
    const { clock, provider } = makeProvider(2, CALM);
    let last = 0;
    provider.on((e) => {
      if (e.type === 'tick') last = e.tick.asOf;
    });
    await provider.connect();
    await provider.subscribe(['XAUUSD']);
    await clock.advance(10_000);
    const beforeFreeze = last;

    provider.freeze('XAUUSD', 90_000);
    await clock.advance(45_000); // past the 30s stale budget for a metal

    expect(last).toBe(beforeFreeze); // nothing arrived
    expect(provider.isConnected()).toBe(true); // and it still looks fine
    expect(freshness(last, clock.now(), budgetFor('metal'))).toBe('stale');
  });

  it('is deterministic for a given seed', async () => {
    const run = async (seed: number): Promise<string[]> => {
      const { clock, provider } = makeProvider(seed, CALM);
      const out: string[] = [];
      provider.on((e) => {
        if (e.type === 'tick') out.push(D.Decimal.toString(e.tick.bid));
      });
      await provider.connect();
      await provider.subscribe(['XAUUSD']);
      await clock.advance(30_000);
      return out;
    };
    expect(await run(7)).toEqual(await run(7));
    expect(await run(7)).not.toEqual(await run(8));
  });

  it('emits a crossed book when told to, which downstream must refuse', async () => {
    const { clock, provider } = makeProvider(3, { ...CALM, crossedBookRate: 1 });
    const ticks: Tick[] = [];
    provider.on((e) => {
      if (e.type === 'tick') ticks.push(e.tick);
    });
    await provider.connect();
    await provider.subscribe(['XAUUSD']);
    await clock.advance(5_000);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.some((t) => isCrossed(t))).toBe(true);
  });
});
