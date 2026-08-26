import type { Dec } from '../money/decimal.js';
import * as D from '../money/decimal.js';

/**
 * Instrument specification.
 *
 * These values come from the broker (MT5 `SymbolInfo*`, OANDA instrument
 * metadata, exchange instrument endpoints). They are never guessed: a missing
 * or stale spec blocks sizing rather than producing a plausible-looking number.
 */

export type AssetClass = 'fx' | 'metal' | 'index' | 'commodity' | 'crypto' | 'equity' | 'future';

/**
 * How the venue accounts for opposing exposure in the same symbol.
 * Getting this wrong silently reverses positions, so it is explicit and
 * adapter-declared rather than assumed.
 */
export type PositionModel = 'netting' | 'hedging';

export interface InstrumentSpec {
  /** Venue-native symbol, exactly as the broker spells it (suffixes included). */
  readonly symbol: string;
  /** Stable canonical id used across venues, e.g. `XAUUSD`. */
  readonly canonical: string;
  readonly assetClass: AssetClass;
  readonly base: string;
  readonly quote: string;
  /** Price decimal places as quoted by the venue. */
  readonly digits: number;
  /** Smallest price increment. */
  readonly tickSize: Dec;
  /** Units of `base` per 1.0 lot. FX major: 100000. XAUUSD: 100. Crypto perp: 1. */
  readonly contractSize: Dec;
  readonly minVolume: Dec;
  readonly maxVolume: Dec;
  readonly volumeStep: Dec;
  /**
   * Profit/loss in the *account* currency for one tick of price movement on one
   * lot, as reported by the venue. When present this is authoritative because
   * the venue has already applied its own conversion. When absent, the value is
   * derived from `contractSize` plus an FX conversion, which requires a quote.
   */
  readonly tickValueAccount?: Dec;
  /** Minimum distance from market for stop/limit prices, in price units. */
  readonly stopsLevel: Dec;
  /** Distance from market inside which modification is refused, in price units. */
  readonly freezeLevel: Dec;
  /** Fraction of notional required as margin (0.01 = 100:1 leverage). */
  /**
   * Fraction of notional required as margin, when the venue genuinely publishes
   * one (0.01 = 100:1).
   *
   * Optional, because MT5 does not have this concept in a usable form. Required
   * margin there depends on the specific proposed order and the account's state
   * at that moment, and is obtained per request through `OrderCalcMargin`. A
   * scalar on the instrument would be a value the venue never asserted.
   *
   * When absent, `marginQuote` returns undefined and the caller must obtain a
   * request-specific figure. It must never be defaulted.
   */
  readonly marginRate?: Dec;
  readonly positionModel: PositionModel;
  /** Venue timezone for session/rollover reasoning (IANA name). */
  readonly venueTimeZone: string;
  /** When this spec was read from the venue. Specs go stale; sizing checks it. */
  readonly asOf: number;
}

export class SpecError extends Error {
  constructor(
    message: string,
    readonly code: SpecErrorCode,
  ) {
    super(message);
    this.name = 'SpecError';
  }
}

export type SpecErrorCode =
  | 'OFF_TICK'
  | 'VOLUME_BELOW_MIN'
  | 'VOLUME_ABOVE_MAX'
  | 'VOLUME_OFF_STEP'
  | 'SPEC_STALE'
  | 'CONVERSION_UNAVAILABLE';

/** One pip in price units. FX convention: 10 ticks on a fractional-pip feed. */
export function pipSize(spec: InstrumentSpec): Dec {
  if (spec.assetClass === 'fx') {
    // 5-digit EURUSD and 3-digit USDJPY quote fractional pips; 4- and 2-digit do not.
    const fractional = spec.digits === 3 || spec.digits === 5;
    return fractional ? D.mul(spec.tickSize, D.dec(10)) : spec.tickSize;
  }
  // Outside FX "pip" is not a defined unit; the tick is the only honest answer.
  return spec.tickSize;
}

/**
 * Snap a price to the instrument's tick grid.
 *
 * `direction` encodes the trading intent, not a formatting preference:
 * - `'safer'` moves the price the way that cannot make a stop tighter or a
 *   limit more aggressive than the caller asked for.
 * - `'nearest'` is only for display and for prices that are not risk-bearing.
 */
export function snapPrice(
  spec: InstrumentSpec,
  price: Dec,
  direction: 'up' | 'down' | 'nearest',
): Dec {
  const mode: D.RoundingMode =
    direction === 'up' ? 'ceil' : direction === 'down' ? 'floor' : 'half-even';
  return D.rescale(D.quantize(price, spec.tickSize, mode), spec.digits, 'half-even');
}

export function isOnTick(spec: InstrumentSpec, price: Dec): boolean {
  return D.isMultipleOf(price, spec.tickSize);
}

export type VolumeCheck =
  | { readonly ok: true; readonly volume: Dec }
  | {
      readonly ok: false;
      readonly code: SpecErrorCode;
      readonly detail: string;
      readonly clamped?: Dec;
    };

/**
 * Validate and normalise an order volume against the venue's constraints.
 *
 * Deliberately does NOT round a too-small volume up to `minVolume`: that would
 * silently exceed the risk the operator asked for. It reports the situation and
 * lets the caller decide.
 */
export function normalizeVolume(spec: InstrumentSpec, requested: Dec): VolumeCheck {
  if (D.lte(requested, D.ZERO)) {
    return { ok: false, code: 'VOLUME_BELOW_MIN', detail: 'volume must be positive' };
  }
  // Quantising at working precision leaves trailing zeros (0.20000000). Venues
  // reject volumes with more precision than their step, so the result is brought
  // back to the step's own scale — exact, since it is already a step multiple.
  const stepped = volumeAtVenuePrecision(spec, D.quantize(requested, spec.volumeStep, 'down'));
  if (D.lt(stepped, spec.minVolume)) {
    return {
      ok: false,
      code: 'VOLUME_BELOW_MIN',
      detail:
        `computed volume ${D.toString(requested)} rounds to ${D.toString(stepped)}, ` +
        `below the venue minimum ${D.toString(spec.minVolume)}`,
      clamped: spec.minVolume,
    };
  }
  if (D.gt(stepped, spec.maxVolume)) {
    return {
      ok: false,
      code: 'VOLUME_ABOVE_MAX',
      detail:
        `computed volume ${D.toString(stepped)} exceeds the venue maximum ` +
        `${D.toString(spec.maxVolume)}`,
      clamped: volumeAtVenuePrecision(spec, D.quantize(spec.maxVolume, spec.volumeStep, 'down')),
    };
  }
  return { ok: true, volume: stepped };
}

/**
 * Express a volume at exactly the precision the venue's step implies.
 * Lossless: the input is already a multiple of the step.
 */
export function volumeAtVenuePrecision(spec: InstrumentSpec, volume: Dec): Dec {
  const stepScale = D.normalize(spec.volumeStep).s;
  return volume.s > stepScale ? D.rescale(volume, stepScale, 'down') : D.rescale(volume, stepScale);
}

/** Notional exposure in the quote currency. */
export function notionalQuote(spec: InstrumentSpec, volume: Dec, price: Dec): Dec {
  return D.mul(D.mul(volume, spec.contractSize), price);
}

/**
 * Margin required in the quote currency, before conversion to account currency.
 *
 * Returns `undefined` when the venue publishes no margin rate — which is the
 * normal case on MT5. Callers must then obtain a request-specific figure rather
 * than substituting a default; a zero here would read as "this order needs no
 * margin" and clear the free-margin rule for any funded account.
 */
export function marginQuote(spec: InstrumentSpec, volume: Dec, price: Dec): Dec | undefined {
  return spec.marginRate === undefined
    ? undefined
    : D.mul(notionalQuote(spec, volume, price), spec.marginRate);
}

/**
 * Value of a price move, in the *quote* currency, for the given volume.
 * Conversion to account currency is a separate, explicit step (see fx.ts) so a
 * missing rate is impossible to overlook.
 */
export function priceMoveValueQuote(spec: InstrumentSpec, volume: Dec, priceDelta: Dec): Dec {
  return D.mul(D.mul(D.abs(priceDelta), spec.contractSize), volume);
}

/** Distance between two prices expressed in ticks. */
export function distanceInTicks(spec: InstrumentSpec, a: Dec, b: Dec): Dec {
  return D.div(D.abs(D.sub(a, b)), spec.tickSize, 2, 'down');
}

/** Whether a pending/stop price respects the venue's minimum stop distance. */
export function respectsStopsLevel(spec: InstrumentSpec, market: Dec, price: Dec): boolean {
  if (D.isZero(spec.stopsLevel)) return true;
  return D.gte(D.abs(D.sub(market, price)), spec.stopsLevel);
}

/** Whether a price is inside the venue's freeze band, where modification is refused. */
export function insideFreezeLevel(spec: InstrumentSpec, market: Dec, price: Dec): boolean {
  if (D.isZero(spec.freezeLevel)) return false;
  return D.lt(D.abs(D.sub(market, price)), spec.freezeLevel);
}

/**
 * A spec older than this is not trusted for sizing. Contract sizes and margin
 * rates do change (weekend margin, holiday schedules, symbol relisting) and a
 * stale spec produces a confidently wrong lot size.
 */
export const SPEC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isSpecStale(
  spec: InstrumentSpec,
  now: number,
  maxAgeMs = SPEC_MAX_AGE_MS,
): boolean {
  return now - spec.asOf > maxAgeMs;
}
