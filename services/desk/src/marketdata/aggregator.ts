import * as D from '@keel/core';
import type { Dec } from '@keel/core';
import type { Bar, Tick, Timeframe } from './port.js';
import { TIMEFRAME_MS, mid } from './port.js';

/**
 * Tick to bar aggregation.
 *
 * Pure functions plus a small stateful accumulator, so the bucketing logic is
 * testable off any network and any clock. Bars are the chart's data, and a
 * chart that quietly mis-buckets is worse than no chart: it shows a level that
 * was never there.
 */

/** The start of the bucket a timestamp falls in, in UTC. */
export function bucketStart(t: number, timeframe: Timeframe): number {
  const size = TIMEFRAME_MS[timeframe];
  if (timeframe === '1d') {
    // Daily bars align to UTC midnight, which is a calendar operation, not a
    // modulo — though for UTC specifically the two agree. Kept explicit so a
    // future session-aligned daily bar has an obvious place to live.
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  return Math.floor(t / size) * size;
}

export interface AggregatorOptions {
  readonly timeframe: Timeframe;
  /** How many completed bars to retain. Bounded so memory cannot grow forever. */
  readonly retain: number;
  /**
   * Which price forms the bar. Mid is the honest default for a chart: a bid
   * series and an ask series each draw a chart the market never traded at.
   */
  readonly priceSource?: 'mid' | 'bid' | 'ask' | 'last';
}

interface MutableBar {
  t: number;
  o: Dec;
  h: Dec;
  l: Dec;
  c: Dec;
  v: Dec;
  ticks: number;
}

export class BarAggregator {
  private readonly completed: Bar[] = [];
  private current: MutableBar | undefined;

  constructor(private readonly opts: AggregatorOptions) {}

  /**
   * Feed a tick. Returns the bar that just completed, if any.
   *
   * Out-of-order ticks are handled explicitly: a tick belonging to an already
   * completed bucket is *dropped*, not merged. Merging it would silently
   * rewrite history a chart has already drawn and a decision may already have
   * been made on.
   */
  push(tick: Tick): { completed?: Bar; dropped?: 'late' } {
    const price = this.priceOf(tick);
    const start = bucketStart(tick.asOf, this.opts.timeframe);

    if (this.current === undefined) {
      this.current = { t: start, o: price, h: price, l: price, c: price, v: D.dec('1'), ticks: 1 };
      return {};
    }

    if (start < this.current.t) return { dropped: 'late' };

    if (start === this.current.t) {
      this.current.h = D.Decimal.max(this.current.h, price);
      this.current.l = D.Decimal.min(this.current.l, price);
      this.current.c = price;
      this.current.ticks += 1;
      this.current.v = D.dec(String(this.current.ticks));
      return {};
    }

    // A new bucket. Close the old one.
    const done = this.freeze(this.current);
    this.completed.push(done);
    while (this.completed.length > this.opts.retain) this.completed.shift();
    this.current = { t: start, o: price, h: price, l: price, c: price, v: D.dec('1'), ticks: 1 };
    return { completed: done };
  }

  /**
   * Completed bars, oldest first. The forming bar is deliberately excluded —
   * ask for it explicitly, so nothing treats a partial bar as final by accident.
   */
  bars(): readonly Bar[] {
    return this.completed;
  }

  /** The bar still forming, if any. Always render this differently. */
  partial(): Bar | undefined {
    return this.current === undefined ? undefined : this.freeze(this.current);
  }

  /** Completed bars plus the forming one, with a flag saying which is which. */
  snapshot(): { bars: readonly Bar[]; lastBarPartial: boolean } {
    const p = this.partial();
    return p === undefined
      ? { bars: this.completed, lastBarPartial: false }
      : { bars: [...this.completed, p], lastBarPartial: true };
  }

  /** Seed from historical bars fetched over REST, oldest first. */
  seed(bars: readonly Bar[]): void {
    for (const b of bars) {
      this.completed.push(b);
      while (this.completed.length > this.opts.retain) this.completed.shift();
    }
  }

  private freeze(b: MutableBar): Bar {
    return { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
  }

  private priceOf(tick: Tick): Dec {
    switch (this.opts.priceSource ?? 'mid') {
      case 'bid':
        return tick.bid;
      case 'ask':
        return tick.ask;
      case 'last':
        return tick.last ?? mid(tick);
      default:
        return mid(tick);
    }
  }
}

/**
 * Re-bucket completed bars into a coarser timeframe.
 *
 * Only exact multiples are permitted. Building 4h bars from 15m is exact;
 * building them from 1h is exact; building anything from an incommensurate
 * timeframe produces boundaries that drift, and a drifting boundary silently
 * moves every high and low.
 */
export function resample(bars: readonly Bar[], from: Timeframe, to: Timeframe): readonly Bar[] {
  const fromMs = TIMEFRAME_MS[from];
  const toMs = TIMEFRAME_MS[to];
  if (toMs % fromMs !== 0) {
    throw new Error(
      `cannot resample ${from} into ${to}: ${toMs} is not a multiple of ${fromMs}, so bucket ` +
        'boundaries would drift and every high and low would move',
    );
  }
  const out: Bar[] = [];
  let acc: MutableBar | undefined;
  for (const b of bars) {
    const start = bucketStart(b.t, to);
    if (acc === undefined || acc.t !== start) {
      if (acc !== undefined) out.push({ t: acc.t, o: acc.o, h: acc.h, l: acc.l, c: acc.c, v: acc.v });
      acc = { t: start, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, ticks: 1 };
      continue;
    }
    acc.h = D.Decimal.max(acc.h, b.h);
    acc.l = D.Decimal.min(acc.l, b.l);
    acc.c = b.c;
    acc.v = D.Decimal.add(acc.v, b.v);
  }
  if (acc !== undefined) out.push({ t: acc.t, o: acc.o, h: acc.h, l: acc.l, c: acc.c, v: acc.v });
  return out;
}

/**
 * Average True Range over completed bars.
 *
 * Advisory only, so float arithmetic would be acceptable — but keeping it exact
 * costs nothing here and means an ATR-derived stop suggestion lands on the tick
 * grid without a rounding surprise.
 */
export function atr(bars: readonly Bar[], period: number): Dec | undefined {
  if (bars.length < period + 1) return undefined;
  const window = bars.slice(-(period + 1));
  const ranges: Dec[] = [];
  for (let i = 1; i < window.length; i++) {
    const cur = window[i] as Bar;
    const prev = window[i - 1] as Bar;
    const hl = D.Decimal.sub(cur.h, cur.l);
    const hc = D.Decimal.abs(D.Decimal.sub(cur.h, prev.c));
    const lc = D.Decimal.abs(D.Decimal.sub(cur.l, prev.c));
    ranges.push(D.Decimal.max(hl, D.Decimal.max(hc, lc)));
  }
  const sum = D.Decimal.sum(ranges);
  return D.Decimal.div(sum, D.dec(String(ranges.length)), (bars[0] as Bar).c.s + 2, 'half-even');
}

/** Detect gaps in a bar series — missing buckets that should be there. */
export function findGaps(bars: readonly Bar[], timeframe: Timeframe): readonly { from: number; to: number; missing: number }[] {
  const size = TIMEFRAME_MS[timeframe];
  const gaps: { from: number; to: number; missing: number }[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1] as Bar;
    const cur = bars[i] as Bar;
    const expected = prev.t + size;
    if (cur.t > expected) {
      gaps.push({ from: expected, to: cur.t, missing: Math.round((cur.t - expected) / size) });
    }
  }
  return gaps;
}
