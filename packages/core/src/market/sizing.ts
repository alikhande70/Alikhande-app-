import type { Dec } from '../money/decimal.js';
import * as D from '../money/decimal.js';
import type { FxBook } from './fx.js';
import type { InstrumentSpec } from './instrument.js';
import * as I from './instrument.js';

/**
 * Risk-first position sizing.
 *
 * The operator states a stop and a risk budget; the size is derived. The inverse
 * — pick a size, then discover what it risks — is how accounts die, and this
 * module deliberately does not offer it.
 *
 * Every failure mode returns a structured reason. Nothing here rounds a problem
 * away: a size below the venue minimum is reported as "cannot express this risk
 * at this stop", not quietly bumped to the minimum.
 */

export type Side = 'buy' | 'sell';

export interface SizingRequest {
  readonly spec: InstrumentSpec;
  readonly accountCurrency: string;
  /** Risk budget in account currency, already resolved from a percentage. */
  readonly riskBudget: Dec;
  readonly entry: Dec;
  readonly stop: Dec;
  /** Optional take-profit, used to report the reward:risk ratio. */
  readonly target?: Dec;
  readonly side: Side;
  readonly fx: FxBook;
  readonly now: number;
  /** Freshness budget for any FX rate used in conversion. */
  readonly maxQuoteAgeMs: number;
  /** Current market price, for stops-level validation. Optional but recommended. */
  readonly market?: Dec;
}

export type SizingFailureCode =
  | 'STOP_ON_WRONG_SIDE'
  | 'ZERO_STOP_DISTANCE'
  | 'STOP_TOO_CLOSE'
  | 'PRICE_OFF_TICK'
  | 'SPEC_STALE'
  | 'CONVERSION_UNAVAILABLE'
  | 'RISK_NOT_EXPRESSIBLE'
  | 'VOLUME_ABOVE_MAX'
  | 'NON_POSITIVE_RISK';

export interface SizingTrace {
  readonly stopDistance: Dec;
  readonly stopDistanceTicks: Dec;
  /** Loss for one lot at the stop, in the instrument's quote currency. */
  readonly lossPerLotQuote: Dec;
  /** Loss for one lot at the stop, in account currency. */
  readonly lossPerLotAccount: Dec;
  /** How `lossPerLotAccount` was obtained. */
  readonly valuationMethod: 'venue-tick-value' | 'fx-conversion';
  /** Every FX quote consulted, for traceability. */
  readonly conversionPath: readonly { pair: string; direction: string; rate: string }[];
  /** Oldest input timestamp behind this result. */
  readonly asOf: number;
  /**
   * Set when both valuation methods were available and disagreed beyond
   * tolerance. A disagreement means one of the two inputs is wrong, and the
   * operator should be told rather than shown the average.
   */
  readonly crossCheckDivergencePct?: Dec;
}

export interface SizingSuccess {
  readonly ok: true;
  readonly volume: Dec;
  /** Actual money at risk at this volume — always <= riskBudget after step rounding. */
  readonly riskAtStop: Dec;
  /** Fraction of the budget actually used, e.g. 0.94 after rounding down. */
  readonly budgetUtilisation: Dec;
  readonly notionalQuote: Dec;
  readonly marginQuote: Dec;
  /** Reward:risk, present only when a target was supplied. */
  readonly rewardToRisk?: Dec;
  readonly trace: SizingTrace;
}

export interface SizingFailure {
  readonly ok: false;
  readonly code: SizingFailureCode;
  readonly detail: string;
  /** Populated where the calculation got far enough to be informative. */
  readonly trace?: Partial<SizingTrace>;
  /** The volume the venue would accept, when the blocker is a venue bound. */
  readonly venueBound?: Dec;
  /** Risk that taking `venueBound` would actually incur — so the operator can judge. */
  readonly riskAtVenueBound?: Dec;
}

export type SizingResult = SizingSuccess | SizingFailure;

/** Working precision for money intermediates, trimmed on output. */
const MONEY_SCALE = 8;
/** Cross-check tolerance between venue tick value and FX-derived value: 0.5%. */
const CROSS_CHECK_TOLERANCE = D.dec('0.005');

export function sizePosition(req: SizingRequest): SizingResult {
  const { spec, entry, stop, side } = req;

  if (D.lte(req.riskBudget, D.ZERO)) {
    return {
      ok: false,
      code: 'NON_POSITIVE_RISK',
      detail: `risk budget must be positive, got ${D.toString(req.riskBudget)}`,
    };
  }

  if (I.isSpecStale(spec, req.now)) {
    const ageH = Math.round((req.now - spec.asOf) / 3_600_000);
    return {
      ok: false,
      code: 'SPEC_STALE',
      detail:
        `instrument spec for ${spec.symbol} is ${ageH}h old; ` +
        `contract size and margin can change, so sizing is blocked until it refreshes`,
    };
  }

  if (!I.isOnTick(spec, entry) || !I.isOnTick(spec, stop)) {
    return {
      ok: false,
      code: 'PRICE_OFF_TICK',
      detail:
        `entry ${D.toString(entry)} / stop ${D.toString(stop)} must align to ` +
        `tick size ${D.toString(spec.tickSize)}`,
    };
  }

  // A stop on the wrong side of entry is the classic fat-finger, and it is
  // arithmetically silent: |entry - stop| is happy to size a position that
  // would be stopped out instantly.
  const stopBelow = D.lt(stop, entry);
  if (side === 'buy' && !stopBelow) {
    return {
      ok: false,
      code: 'STOP_ON_WRONG_SIDE',
      detail: `long stop ${D.toString(stop)} must be below entry ${D.toString(entry)}`,
    };
  }
  if (side === 'sell' && stopBelow) {
    return {
      ok: false,
      code: 'STOP_ON_WRONG_SIDE',
      detail: `short stop ${D.toString(stop)} must be above entry ${D.toString(entry)}`,
    };
  }

  const stopDistance = D.abs(D.sub(entry, stop));
  if (D.isZero(stopDistance)) {
    return { ok: false, code: 'ZERO_STOP_DISTANCE', detail: 'entry and stop are identical' };
  }

  if (req.market !== undefined && !I.respectsStopsLevel(spec, req.market, stop)) {
    return {
      ok: false,
      code: 'STOP_TOO_CLOSE',
      detail:
        `stop is ${D.toString(D.abs(D.sub(req.market, stop)))} from market, inside the ` +
        `venue minimum distance of ${D.toString(spec.stopsLevel)}`,
    };
  }

  const stopDistanceTicks = D.div(stopDistance, spec.tickSize, 4, 'down');
  const lossPerLotQuote = D.rescale(
    I.priceMoveValueQuote(spec, D.dec(1), stopDistance),
    MONEY_SCALE,
    'half-even',
  );

  // --- Value one lot's stop loss in account currency -----------------------
  // Two independent routes. The venue's own tick value already includes its
  // conversion and is authoritative when present; the FX route is the fallback
  // and, when both exist, the cross-check.

  let fromVenue: Dec | undefined;
  if (spec.tickValueAccount !== undefined) {
    fromVenue = D.rescale(
      D.mul(stopDistanceTicks, spec.tickValueAccount),
      MONEY_SCALE,
      'half-even',
    );
  }

  const conv = req.fx.convert({
    amount: lossPerLotQuote,
    from: spec.quote,
    to: req.accountCurrency,
    basis: 'worst-case',
    now: req.now,
    maxAgeMs: req.maxQuoteAgeMs,
  });
  const fromFx = conv.ok ? D.rescale(conv.amount, MONEY_SCALE, 'half-even') : undefined;

  if (fromVenue === undefined && fromFx === undefined) {
    const failure = conv.ok ? 'unknown' : `${conv.reason}: ${conv.detail}`;
    return {
      ok: false,
      code: 'CONVERSION_UNAVAILABLE',
      detail:
        `cannot value ${spec.quote} risk in ${req.accountCurrency}. ` +
        `The venue reported no tick value and FX conversion failed (${failure}). ` +
        `Sizing is blocked rather than assuming a 1:1 rate.`,
      trace: { stopDistance, stopDistanceTicks, lossPerLotQuote },
    };
  }

  const lossPerLotAccount = fromVenue ?? (fromFx as Dec);
  const valuationMethod: SizingTrace['valuationMethod'] =
    fromVenue !== undefined ? 'venue-tick-value' : 'fx-conversion';

  let crossCheckDivergencePct: Dec | undefined;
  if (fromVenue !== undefined && fromFx !== undefined && !D.isZero(fromVenue)) {
    const diff = D.abs(D.sub(fromVenue, fromFx));
    const pct = D.div(diff, D.abs(fromVenue), 6, 'half-even');
    if (D.gt(pct, CROSS_CHECK_TOLERANCE)) crossCheckDivergencePct = pct;
  }

  const conversionPath = conv.ok
    ? conv.path.map((h) => ({ pair: h.pair, direction: h.direction, rate: D.toString(h.rate) }))
    : [];
  const asOf = conv.ok ? Math.min(conv.asOf, spec.asOf) : spec.asOf;

  const trace: SizingTrace = {
    stopDistance,
    stopDistanceTicks,
    lossPerLotQuote,
    lossPerLotAccount,
    valuationMethod,
    conversionPath,
    asOf,
    ...(crossCheckDivergencePct !== undefined ? { crossCheckDivergencePct } : {}),
  };

  if (D.lte(lossPerLotAccount, D.ZERO)) {
    return {
      ok: false,
      code: 'CONVERSION_UNAVAILABLE',
      detail: 'per-lot loss valued at zero or less; refusing to divide by it',
      trace,
    };
  }

  // --- Derive volume ------------------------------------------------------
  // Round DOWN, always: rounding up would exceed the operator's stated risk.
  const rawVolume = D.div(req.riskBudget, lossPerLotAccount, 8, 'down');
  const check = I.normalizeVolume(spec, rawVolume);

  if (!check.ok) {
    if (check.code === 'VOLUME_BELOW_MIN') {
      const minRisk = D.rescale(D.mul(spec.minVolume, lossPerLotAccount), 2, 'ceil');
      return {
        ok: false,
        code: 'RISK_NOT_EXPRESSIBLE',
        detail:
          `a ${D.toString(req.riskBudget)} ${req.accountCurrency} risk over a ` +
          `${D.toString(stopDistance)} stop needs ${D.toString(rawVolume)} lots, below the ` +
          `venue minimum of ${D.toString(spec.minVolume)}. Taking the minimum would risk ` +
          `${D.toString(minRisk)} ${req.accountCurrency}. Widen the risk budget or tighten the stop.`,
        trace,
        venueBound: I.volumeAtVenuePrecision(spec, spec.minVolume),
        riskAtVenueBound: minRisk,
      };
    }
    const bound = check.clamped ?? spec.maxVolume;
    return {
      ok: false,
      code: 'VOLUME_ABOVE_MAX',
      detail: check.detail,
      trace,
      venueBound: bound,
      riskAtVenueBound: D.rescale(D.mul(bound, lossPerLotAccount), 2, 'half-even'),
    };
  }

  const volume = check.volume;
  const riskAtStop = D.rescale(D.mul(volume, lossPerLotAccount), 2, 'half-even');
  const budgetUtilisation = D.div(riskAtStop, req.riskBudget, 4, 'down');

  const result: SizingSuccess = {
    ok: true,
    volume,
    riskAtStop,
    budgetUtilisation,
    notionalQuote: D.rescale(I.notionalQuote(spec, volume, entry), 2, 'half-even'),
    marginQuote: D.rescale(I.marginQuote(spec, volume, entry), 2, 'ceil'),
    trace,
    ...(req.target !== undefined
      ? { rewardToRisk: rewardToRisk(entry, stop, req.target, side) }
      : {}),
  };
  return result;
}

/**
 * Reward:risk from prices alone. Returns zero when the target is on the losing
 * side of entry — an inverted target is a mistake, not a negative R trade.
 */
export function rewardToRisk(entry: Dec, stop: Dec, target: Dec, side: Side): Dec {
  const risk = D.abs(D.sub(entry, stop));
  if (D.isZero(risk)) return D.ZERO;
  const reward = side === 'buy' ? D.sub(target, entry) : D.sub(entry, target);
  if (D.lte(reward, D.ZERO)) return D.ZERO;
  return D.div(reward, risk, 2, 'down');
}

/**
 * Where to place the stop, given a fixed volume and a risk budget.
 * The inverse of `sizePosition`, offered only for "I already hold this — where
 * does my remaining risk budget put the stop?" It is never used to open a trade.
 */
export function stopForVolume(
  spec: InstrumentSpec,
  volume: Dec,
  riskBudget: Dec,
  entry: Dec,
  side: Side,
  lossPerLotPerPriceUnit: Dec,
): Dec | undefined {
  const perPrice = D.mul(volume, lossPerLotPerPriceUnit);
  if (D.lte(perPrice, D.ZERO)) return undefined;
  const distance = D.div(riskBudget, perPrice, spec.digits + 2, 'down');
  const rawStop = side === 'buy' ? D.sub(entry, distance) : D.add(entry, distance);
  // Snap the stop toward entry-safety: never further out than the budget allows.
  return I.snapPrice(spec, rawStop, side === 'buy' ? 'up' : 'down');
}
