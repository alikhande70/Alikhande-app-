import type { AssetClass, Dec, InstrumentSpec, OrderState } from '@keel/core';
import * as D from '@keel/core';

/**
 * Pure translation between OANDA's v20 model and ours.
 *
 * Everything here is a total function of its inputs with no clock and no
 * network, because these conversions are where a broker adapter silently goes
 * wrong: a misplaced decimal, a sign convention, a timestamp parsed to the
 * wrong epoch. Those are cheap to test exhaustively and expensive to discover
 * in production, so they live apart from the transport.
 */

// --- Instrument naming -------------------------------------------------------

/**
 * OANDA spells instruments `EUR_USD`; we canonicalise to `EURUSD`.
 *
 * The mapping is mechanical rather than a lookup table, so a newly listed
 * instrument works without a code change. It is also reversible, which matters:
 * every venue call needs the venue's spelling back.
 */
export function toCanonical(oandaName: string): string {
  return oandaName.replace(/_/g, '');
}

/**
 * Canonical to OANDA's spelling.
 *
 * This needs the instrument list, because `XAUUSD` splits as `XAU_USD` while a
 * hypothetical five-letter base would not, and guessing the split point from
 * length alone is how an adapter ends up requesting an instrument that does not
 * exist. Callers that have not loaded instruments yet get `undefined` rather
 * than a plausible-looking guess.
 */
export function toOandaName(
  canonical: string,
  known: ReadonlyMap<string, string>,
): string | undefined {
  return known.get(canonical);
}

// --- Time --------------------------------------------------------------------

/**
 * Parse an OANDA RFC3339 timestamp to epoch milliseconds.
 *
 * OANDA stamps transactions with nanosecond precision (`...T10:30:00.123456789Z`).
 * `Date.parse` truncates the sub-millisecond digits, which is the behaviour we
 * want — but it returns `NaN` for anything it cannot read, and `NaN` flowing
 * into a timestamp produces an event that sorts arbitrarily and ages
 * nonsensically. So an unparseable time is an error, never a fallback to "now":
 * a fabricated timestamp is exactly the kind of invented state this system
 * refuses to produce.
 */
export function parseOandaTime(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new OandaMappingError(
      `cannot parse OANDA timestamp ${JSON.stringify(value)}. Refusing to substitute the local ` +
        'clock, because a fabricated venue timestamp is indistinguishable from a real one later.',
    );
  }
  return ms;
}

export class OandaMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OandaMappingError';
  }
}

// --- Volume ------------------------------------------------------------------

/**
 * OANDA has no lot. It trades in *units* of the base currency — 12,345 units of
 * EUR_USD is a valid, exactly-expressible order, and metals are quoted in
 * ounces.
 *
 * So `contractSize` is 1 for every OANDA instrument and our `volume` is
 * denominated in the venue's own units. The alternative — imposing the MT5
 * convention that one lot is 100,000 units — would mean inventing a contract
 * size per asset class (is silver 5,000 ounces per lot, or 1,000?) and then
 * rounding every computed size onto a grid the venue does not actually impose.
 * Guessing a contract size is guessing the size of every future position.
 *
 * The upside is real: sizing lands on unit precision instead of 0.01 lots, so a
 * risk budget converts to a position far more exactly than a lot-based venue
 * allows.
 */
export const OANDA_CONTRACT_SIZE: Dec = D.dec('1');

/**
 * Signed unit string for an order.
 *
 * OANDA encodes direction in the sign of `units`: positive is long, negative is
 * short. There is no side field, so a sign error is a reversed position rather
 * than a validation failure — which is why this is a named, tested function and
 * not an inline template string.
 */
export function unitsForOrder(volume: Dec, side: 'buy' | 'sell'): string {
  if (D.Decimal.isNegative(volume)) {
    throw new OandaMappingError(
      `volume must be non-negative (direction is carried by 'side'), got ${D.Decimal.toString(volume)}`,
    );
  }
  if (D.Decimal.isZero(volume)) {
    throw new OandaMappingError('refusing to send an order for zero units');
  }
  const signed = side === 'sell' ? D.Decimal.neg(volume) : volume;
  return D.Decimal.toString(signed);
}

/** Absolute volume from OANDA's signed units, plus the side the sign encodes. */
export function volumeFromUnits(units: string): { volume: Dec; side: 'buy' | 'sell' } {
  const parsed = D.dec(units);
  return {
    volume: D.Decimal.abs(parsed),
    // Zero units has no direction. It appears in closed-trade payloads, where
    // the side is carried elsewhere; defaulting to 'buy' here would be a quiet
    // lie, so callers must not rely on it for a zero.
    side: D.Decimal.isNegative(parsed) ? 'sell' : 'buy',
  };
}

// --- Instrument specs --------------------------------------------------------

export interface OandaInstrument {
  readonly name: string;
  readonly type: string;
  readonly displayName?: string;
  readonly pipLocation?: number;
  readonly displayPrecision: number;
  readonly tradeUnitsPrecision: number;
  readonly minimumTradeSize: string;
  readonly maximumOrderUnits: string;
  readonly marginRate: string;
}

/**
 * OANDA's `type` to our asset class.
 *
 * `CFD` covers indices, commodities and more, and OANDA does not tell us which.
 * Rather than infer from the symbol name, everything unrecognised becomes
 * `index`, which affects only pip-size conventions in advisory displays and
 * never the arithmetic of a position. The unknown type is surfaced by the
 * caller rather than swallowed.
 */
export function assetClassOf(type: string): AssetClass {
  switch (type) {
    case 'CURRENCY':
      return 'fx';
    case 'METAL':
      return 'metal';
    default:
      return 'index';
  }
}

/** 10^-precision as an exact decimal: the venue's smallest price increment. */
export function stepOfPrecision(precision: number): Dec {
  if (!Number.isInteger(precision) || precision < 0 || precision > 20) {
    throw new OandaMappingError(`implausible precision from OANDA: ${precision}`);
  }
  return D.raw(1n, precision);
}

/**
 * Build an `InstrumentSpec` from OANDA instrument metadata.
 *
 * Two fields are deliberately zero rather than guessed:
 *
 * - `stopsLevel`: OANDA publishes no minimum distance between the market and a
 *   stop for ordinary orders (unlike MT5's `SYMBOL_TRADE_STOPS_LEVEL`). Zero is
 *   the honest encoding of "the venue does not impose one"; a made-up buffer
 *   would silently push every stop further from where the operator put it.
 * - `freezeLevel`: likewise not a concept in v20.
 *
 * `tickValueAccount` is left undefined on purpose. OANDA does not report a
 * per-tick account-currency value, and the core already derives one through an
 * FX conversion when it is absent — refusing to size when no conversion path
 * exists. Synthesising a number here would bypass that refusal.
 */
export function specFromOanda(inst: OandaInstrument, asOf: number): InstrumentSpec {
  const [base, quote] = splitPair(inst.name);
  const tickSize = stepOfPrecision(inst.displayPrecision);
  const volumeStep = stepOfPrecision(inst.tradeUnitsPrecision);
  return {
    symbol: inst.name,
    canonical: toCanonical(inst.name),
    assetClass: assetClassOf(inst.type),
    base,
    quote,
    digits: inst.displayPrecision,
    tickSize,
    contractSize: OANDA_CONTRACT_SIZE,
    minVolume: D.dec(inst.minimumTradeSize),
    maxVolume: D.dec(inst.maximumOrderUnits),
    volumeStep,
    stopsLevel: D.Decimal.ZERO,
    freezeLevel: D.Decimal.ZERO,
    marginRate: D.dec(inst.marginRate),
    // v20 accounts are netting unless hedging is enabled on the account, which
    // is an account-level fact the adapter reads at connect and overrides here.
    positionModel: 'netting',
    // OANDA's trading day rolls at 17:00 New York, which is also where its
    // daily candles and financing boundaries sit.
    venueTimeZone: 'America/New_York',
    asOf,
  };
}

/**
 * Split `EUR_USD` into its two sides.
 *
 * Instruments without an underscore (some CFDs) have no meaningful currency
 * pair, and reporting the whole name as the base with an empty quote would
 * produce an FX conversion path that cannot exist. Those are rejected so the
 * caller can skip the instrument rather than size against nonsense.
 */
export function splitPair(name: string): [string, string] {
  const parts = name.split('_');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new OandaMappingError(
      `instrument ${JSON.stringify(name)} is not a two-sided pair, so its base and quote cannot ` +
        'be determined and no conversion path can be built for it',
    );
  }
  return [parts[0] as string, parts[1] as string];
}

// --- Order state -------------------------------------------------------------

/**
 * OANDA order state to ours.
 *
 * `PENDING` means resting at the venue, which is `WORKING` here — not
 * `PENDING_SUBMIT`, which in our machine means "we have not sent it yet". That
 * confusion would make a live resting order look like an unsent one and invite a
 * duplicate submission.
 */
export function orderStateFromOanda(state: string, filled: Dec, requested: Dec): OrderState {
  switch (state) {
    case 'PENDING':
      return D.Decimal.isZero(filled) ? 'WORKING' : 'PARTIALLY_FILLED';
    case 'FILLED':
      return 'FILLED';
    case 'CANCELLED':
      // A cancelled order that had already filled part of its size is not
      // simply "cancelled": the fills are real and must not be discarded.
      return D.Decimal.isZero(filled) ? 'CANCELLED' : 'PARTIALLY_FILLED';
    case 'TRIGGERED':
      return D.Decimal.gte(filled, requested) && !D.Decimal.isZero(requested)
        ? 'FILLED'
        : 'WORKING';
    default:
      // An unrecognised state is not assumed benign. UNKNOWN routes it into the
      // resolver, which will establish the truth from the venue.
      return 'UNKNOWN';
  }
}

/**
 * OANDA rejects an order by returning a cancel or reject transaction with a
 * reason. These are definite negatives — the venue considered the order and
 * declined it — as distinct from a transport failure, where it may well have
 * executed.
 */
export function isDefiniteRejection(reason: string | undefined): boolean {
  return reason !== undefined && reason.length > 0;
}
