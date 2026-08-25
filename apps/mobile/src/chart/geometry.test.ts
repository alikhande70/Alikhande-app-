import { describe, expect, it } from 'vitest';
import type { PlotBar, Viewport } from './geometry.js';
import {
  barIndexAt,
  includeLevels,
  makeScale,
  priceRange,
  priceTicks,
  riskBands,
  snapToTick,
  toPlot,
  visibleRange,
} from './geometry.js';

const view: Viewport = {
  width: 390,
  height: 400,
  paddingTop: 16,
  paddingBottom: 24,
  paddingRight: 56,
};

function bars(count: number, base = 2400): PlotBar[] {
  return Array.from({ length: count }, (_, i) => ({
    t: 1_800_000_000_000 + i * 60_000,
    o: base + i,
    h: base + i + 2,
    l: base + i - 2,
    c: base + i + 1,
  }));
}

describe('price range', () => {
  it('covers every high and low with padding', () => {
    const r = priceRange(bars(10));
    expect(r.min).toBeLessThan(2398);
    expect(r.max).toBeGreaterThan(2411);
  });

  it('does not collapse on a completely flat market', () => {
    const flat: PlotBar[] = [{ t: 0, o: 100, h: 100, l: 100, c: 100 }];
    const r = priceRange(flat);
    expect(r.max).toBeGreaterThan(r.min);
  });

  it('survives an empty series without producing NaN', () => {
    const r = priceRange([]);
    expect(Number.isFinite(r.min)).toBe(true);
    expect(Number.isFinite(r.max)).toBe(true);
  });

  it('extends to include a stop that sits outside the visible bars', () => {
    // Otherwise a stop drawn below the window is invisible, which is exactly
    // when the operator most needs to see it.
    const r = includeLevels(priceRange(bars(10)), [2300]);
    expect(r.min).toBeLessThanOrEqual(2300);
  });

  it('ignores a non-finite level rather than poisoning the range', () => {
    const base = priceRange(bars(10));
    expect(includeLevels(base, [Number.NaN])).toEqual(base);
  });
});

describe('scales', () => {
  const b = bars(20);
  const price = priceRange(b);
  const time = { from: (b[0] as PlotBar).t, to: (b[b.length - 1] as PlotBar).t };
  const scale = makeScale(view, price, time, b.length);

  it('puts higher prices nearer the top', () => {
    expect(scale.y(price.max)).toBeLessThan(scale.y(price.min));
  });

  it('round-trips price through y', () => {
    for (const p of [price.min, price.max, (price.min + price.max) / 2]) {
      expect(scale.priceAt(scale.y(p))).toBeCloseTo(p, 6);
    }
  });

  it('round-trips time through x', () => {
    expect(scale.timeAt(scale.x(time.from))).toBeCloseTo(time.from, 0);
    expect(scale.timeAt(scale.x(time.to))).toBeCloseTo(time.to, 0);
  });

  it('leaves room on the right for the price axis', () => {
    expect(scale.x(time.to)).toBeLessThanOrEqual(view.width - view.paddingRight);
  });

  it('does not divide by zero on a degenerate viewport', () => {
    const s = makeScale(
      { ...view, width: 0, height: 0 },
      { min: 1, max: 1 },
      { from: 5, to: 5 },
      0,
    );
    expect(Number.isFinite(s.y(1))).toBe(true);
    expect(Number.isFinite(s.x(5))).toBe(true);
  });
});

describe('visible range', () => {
  it('shows the most recent bars by default', () => {
    expect(visibleRange(1000, 100, 0)).toEqual({ from: 900, to: 1000 });
  });

  it('pans backwards', () => {
    expect(visibleRange(1000, 100, 50)).toEqual({ from: 850, to: 950 });
  });

  it('cannot scroll past the start into empty space', () => {
    expect(visibleRange(1000, 100, 99_999)).toEqual({ from: 0, to: 100 });
  });

  it('cannot scroll past the end', () => {
    expect(visibleRange(1000, 100, -50)).toEqual({ from: 900, to: 1000 });
  });

  it('handles fewer bars than fit on screen', () => {
    expect(visibleRange(20, 100, 0)).toEqual({ from: 0, to: 20 });
  });
});

describe('price ticks', () => {
  it('produces round numbers, not arbitrary ones', () => {
    const ticks = priceTicks({ min: 2390, max: 2410 }, 5);
    expect(ticks.length).toBeGreaterThan(2);
    for (const t of ticks) expect(t % 5).toBeCloseTo(0, 9);
  });

  it('stays inside the range', () => {
    const range = { min: 1.0812, max: 1.0873 };
    for (const t of priceTicks(range, 4)) {
      expect(t).toBeGreaterThanOrEqual(range.min - 1e-9);
      expect(t).toBeLessThanOrEqual(range.max + 1e-9);
    }
  });

  it('does not accumulate float drift across the loop', () => {
    for (const t of priceTicks({ min: 0.1, max: 1.0 }, 9)) {
      expect(String(t).length).toBeLessThan(12);
    }
  });

  it('returns nothing for a degenerate range rather than looping forever', () => {
    expect(priceTicks({ min: 5, max: 5 })).toEqual([]);
    expect(priceTicks({ min: 5, max: Number.NaN })).toEqual([]);
  });
});

describe('risk bands — the reason this chart is hand built', () => {
  const b = bars(20);
  const price = priceRange(b);
  const time = { from: (b[0] as PlotBar).t, to: (b[b.length - 1] as PlotBar).t };
  const scale = makeScale(view, price, time, b.length);

  it('puts a long stop band below entry on screen', () => {
    const bands = riskBands(scale, 'buy', 2410, 2405);
    expect(bands.riskBottom).toBeGreaterThan(bands.riskTop);
    expect(scale.priceAt(bands.riskBottom)).toBeCloseTo(2405, 4);
    expect(scale.priceAt(bands.riskTop)).toBeCloseTo(2410, 4);
  });

  it('puts a short stop band above entry on screen', () => {
    const bands = riskBands(scale, 'sell', 2405, 2410);
    expect(scale.priceAt(bands.riskTop)).toBeCloseTo(2410, 4);
  });

  it('computes reward to risk from the geometry', () => {
    expect(riskBands(scale, 'buy', 2400, 2395, 2415).rr).toBeCloseTo(3, 6);
    expect(riskBands(scale, 'sell', 2400, 2405, 2385).rr).toBeCloseTo(3, 6);
  });

  it('reports zero R for a target on the losing side, not a negative one', () => {
    // An inverted target is a mistake to flag, not a trade with negative reward.
    expect(riskBands(scale, 'buy', 2400, 2395, 2390).rr).toBe(0);
  });

  it('omits the reward band entirely when there is no target', () => {
    const bands = riskBands(scale, 'buy', 2400, 2395);
    expect(bands.rewardTop).toBeUndefined();
    expect(bands.rr).toBeUndefined();
  });
});

describe('stop snapping never tightens a stop', () => {
  it('rounds a long stop away from entry', () => {
    // A finger at 2395.67 on a 0.01 grid must not land at 2395.70.
    expect(snapToTick(2395.678, 0.01, 'safer-long')).toBeCloseTo(2395.67, 10);
  });

  it('rounds a short stop away from entry', () => {
    expect(snapToTick(2405.672, 0.01, 'safer-short')).toBeCloseTo(2405.68, 10);
  });

  it('keeps the drag on the grid for a 5-digit pair', () => {
    const snapped = snapToTick(1.085_437, 0.000_01, 'nearest');
    expect(Number(snapped.toFixed(5))).toBe(snapped);
  });

  it('is inert on a nonsense tick size rather than producing NaN', () => {
    expect(snapToTick(2400, 0, 'nearest')).toBe(2400);
    expect(snapToTick(2400, Number.NaN, 'nearest')).toBe(2400);
  });
});

describe('crosshair hit testing', () => {
  const b = bars(50);
  const time = { from: (b[0] as PlotBar).t, to: (b[b.length - 1] as PlotBar).t };
  const scale = makeScale(view, priceRange(b), time, b.length);

  it('finds the nearest bar to a touch', () => {
    const target = 30;
    const x = scale.x((b[target] as PlotBar).t);
    expect(barIndexAt(b, scale, x)).toBe(target);
  });

  it('clamps at the edges rather than returning nothing', () => {
    expect(barIndexAt(b, scale, -500)).toBe(0);
    expect(barIndexAt(b, scale, 99_999)).toBe(b.length - 1);
  });

  it('returns undefined only when there is genuinely nothing to hit', () => {
    expect(barIndexAt([], scale, 10)).toBeUndefined();
  });
});

describe('the float boundary', () => {
  it('converts wire decimals to plot floats exactly once', () => {
    const plotted = toPlot([{ t: 1, o: '2400.10', h: '2401.00', l: '2399.50', c: '2400.75' }]);
    expect(plotted[0]?.o).toBe(2400.1);
    expect(plotted[0]?.c).toBe(2400.75);
  });
});
