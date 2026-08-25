/**
 * Chart geometry.
 *
 * All of it pure, so the maths is tested off-device and the Skia component
 * contains only drawing. A chart that mis-scales is a chart that shows a level
 * that was never there, and that is a decision made on a lie — so this is the
 * part that gets tests, not the pixels.
 *
 * Floats are used deliberately and exclusively here: these are screen
 * coordinates, they are advisory, and nothing computed in this file ever sizes
 * an order. Prices arrive as decimal strings and are converted once, at the
 * boundary, by `toPlot`.
 */

export interface PlotBar {
  readonly t: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly paddingTop: number;
  readonly paddingBottom: number;
  readonly paddingRight: number;
}

export interface PriceRange {
  readonly min: number;
  readonly max: number;
}

export interface TimeRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Convert wire bars (decimal strings) to plot bars (floats), once.
 *
 * The boundary is explicit and narrow so that "where does a float enter the
 * system?" has a one-line answer.
 */
export function toPlot(bars: readonly { t: number; o: string; h: string; l: string; c: string }[]): PlotBar[] {
  return bars.map((b) => ({
    t: b.t,
    o: Number(b.o),
    h: Number(b.h),
    l: Number(b.l),
    c: Number(b.c),
  }));
}

/**
 * The price range to draw, given the visible bars.
 *
 * Padded by a fraction of the range rather than a fixed number of pixels, so a
 * gold chart and an FX chart both breathe the same way. A zero-range window
 * (a completely flat market) is widened deliberately rather than dividing by
 * zero later.
 */
export function priceRange(bars: readonly PlotBar[], padFraction = 0.08): PriceRange {
  if (bars.length === 0) return { min: 0, max: 1 };
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const b of bars) {
    if (b.l < min) min = b.l;
    if (b.h > max) max = b.h;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  const span = max - min;
  if (span === 0) {
    const nudge = Math.abs(max) * 0.001 || 1;
    return { min: min - nudge, max: max + nudge };
  }
  const pad = span * padFraction;
  return { min: min - pad, max: max + pad };
}

/** Extend a range to include extra levels — a stop, a target, an alert line. */
export function includeLevels(range: PriceRange, levels: readonly number[]): PriceRange {
  let { min, max } = range;
  for (const level of levels) {
    if (!Number.isFinite(level)) continue;
    if (level < min) min = level;
    if (level > max) max = level;
  }
  return { min, max };
}

export interface Scale {
  /** Price to y. */
  readonly y: (price: number) => number;
  /** y to price. Used for the drag-to-set-stop gesture. */
  readonly priceAt: (y: number) => number;
  /** Time to x. */
  readonly x: (t: number) => number;
  /** x to time, for the crosshair. */
  readonly timeAt: (x: number) => number;
  /** Width of one bar's slot, including its gap. */
  readonly slotWidth: number;
}

export function makeScale(view: Viewport, price: PriceRange, time: TimeRange, barCount: number): Scale {
  const plotTop = view.paddingTop;
  const plotHeight = Math.max(1, view.height - view.paddingTop - view.paddingBottom);
  const plotWidth = Math.max(1, view.width - view.paddingRight);
  const priceSpan = price.max - price.min || 1;
  const timeSpan = time.to - time.from || 1;
  const slotWidth = barCount > 0 ? plotWidth / barCount : plotWidth;

  return {
    // Inverted: higher price is nearer the top, which is the only orientation
    // any trader will accept.
    y: (p: number) => plotTop + (1 - (p - price.min) / priceSpan) * plotHeight,
    priceAt: (y: number) => price.min + (1 - (y - plotTop) / plotHeight) * priceSpan,
    x: (t: number) => ((t - time.from) / timeSpan) * plotWidth,
    timeAt: (x: number) => time.from + (x / plotWidth) * timeSpan,
    slotWidth,
  };
}

/**
 * Which bars are visible, given a pan offset and a zoom level.
 *
 * Returns indices rather than a copy: a chart holding a few thousand bars
 * should not allocate a new array on every frame of a pan.
 */
export function visibleRange(
  totalBars: number,
  barsPerScreen: number,
  panOffsetBars: number,
): { from: number; to: number } {
  const count = Math.max(10, Math.min(totalBars, Math.round(barsPerScreen)));
  // Clamp so a pan can never scroll past either end into empty space.
  const maxOffset = Math.max(0, totalBars - count);
  const offset = Math.max(0, Math.min(maxOffset, Math.round(panOffsetBars)));
  const to = totalBars - offset;
  return { from: Math.max(0, to - count), to };
}

/**
 * "Nice" price gridlines: 1, 2, 2.5 or 5 times a power of ten.
 *
 * Arbitrary tick values make a chart hard to read at a glance, which is the
 * only thing a chart is for.
 */
export function priceTicks(range: PriceRange, targetCount = 5): number[] {
  const span = range.max - range.min;
  if (span <= 0 || !Number.isFinite(span)) return [];
  const rough = span / Math.max(1, targetCount);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const step = (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10) * magnitude;
  const first = Math.ceil(range.min / step) * step;
  const ticks: number[] = [];
  for (let v = first; v <= range.max + step * 1e-9; v += step) {
    // Re-round to kill the float drift that accumulates over an addition loop.
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks;
}

/**
 * The risk geometry drawn on price: the band between entry and stop, and the
 * band between entry and target.
 *
 * This is the feature no general-purpose chart library models, and the reason
 * this renderer is hand-built. Seeing risk as an area on the chart — rather
 * than as a number in a form — is what makes an over-sized position obvious
 * before it is sent.
 */
export interface RiskBands {
  readonly riskTop: number;
  readonly riskBottom: number;
  readonly rewardTop?: number;
  readonly rewardBottom?: number;
  /** Reward:risk, for the label. Undefined without a target. */
  readonly rr?: number;
}

export function riskBands(
  scale: Scale,
  side: 'buy' | 'sell',
  entry: number,
  stop: number,
  target?: number,
): RiskBands {
  const entryY = scale.y(entry);
  const stopY = scale.y(stop);
  const bands: {
    riskTop: number;
    riskBottom: number;
    rewardTop?: number;
    rewardBottom?: number;
    rr?: number;
  } = {
    riskTop: Math.min(entryY, stopY),
    riskBottom: Math.max(entryY, stopY),
  };

  if (target !== undefined && Number.isFinite(target)) {
    const targetY = scale.y(target);
    bands.rewardTop = Math.min(entryY, targetY);
    bands.rewardBottom = Math.max(entryY, targetY);
    const risk = Math.abs(entry - stop);
    const reward = side === 'buy' ? target - entry : entry - target;
    // A target on the losing side is a mistake, not a negative R trade.
    bands.rr = risk > 0 && reward > 0 ? reward / risk : 0;
  }
  return bands;
}

/**
 * The bar nearest an x coordinate, for the crosshair.
 *
 * Returns the index rather than the bar so the caller can decide what to read
 * from it, and so hit-testing stays allocation-free during a drag.
 */
export function barIndexAt(bars: readonly PlotBar[], scale: Scale, x: number): number | undefined {
  if (bars.length === 0) return undefined;
  const t = scale.timeAt(x);
  let best = 0;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let i = 0; i < bars.length; i++) {
    const delta = Math.abs((bars[i] as PlotBar).t - t);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }
  return best;
}

/**
 * Snap a dragged price to the instrument's tick grid, for the stop handle.
 *
 * `direction` is the trading decision, not a rounding preference: dragging a
 * long's stop should never land it *closer* to entry than the finger did, or a
 * careful drag silently tightens the stop.
 */
export function snapToTick(price: number, tickSize: number, direction: 'safer-long' | 'safer-short' | 'nearest'): number {
  if (tickSize <= 0 || !Number.isFinite(tickSize)) return price;
  const units = price / tickSize;
  const snapped =
    direction === 'safer-long'
      ? Math.floor(units)
      : direction === 'safer-short'
        ? Math.ceil(units)
        : Math.round(units);
  // Rounded to kill float drift so the value re-serialises cleanly as a decimal.
  return Number((snapped * tickSize).toFixed(10));
}

/** Format a price for an axis label at the instrument's precision. */
export function formatPrice(price: number, digits: number): string {
  return price.toFixed(digits);
}
