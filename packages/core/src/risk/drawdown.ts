import type { Dec } from '../money/decimal.js';
import * as D from '../money/decimal.js';
import { lastLocalTimeAtOrBefore } from '../time/zone.js';

/**
 * Funded-account drawdown models.
 *
 * A drawdown breach is terminal in a way a losing trade is not: it ends the
 * account. The models here mirror what firms actually enforce in 2026 — the
 * industry moved from intraday-trailing toward end-of-day-trailing, and the
 * balance-versus-equity distinction decides whether an open position's floating
 * loss eats the buffer immediately or not.
 *
 * The tracker is deliberately conservative: it computes the floor the *firm*
 * would compute, and a `warning` band before it, so the operator sees the wall
 * coming rather than hitting it.
 */

export type DrawdownModel =
  | { readonly kind: 'none' }
  /** Fixed floor: `startingBalance - amount`, never moves. */
  | { readonly kind: 'static'; readonly amount: Dec }
  /** Floor trails the running high-water mark, updated on every tick. */
  | { readonly kind: 'trailing-intraday'; readonly amount: Dec }
  /** Floor trails the high-water mark as at each daily close only. */
  | { readonly kind: 'trailing-eod'; readonly amount: Dec };

/**
 * Which figure the firm measures.
 * - `equity` includes floating P&L, so an open loser consumes the buffer now.
 * - `balance` counts only closed trades, which is materially more forgiving.
 */
export type DrawdownBasis = 'equity' | 'balance';

export interface DrawdownConfig {
  readonly model: DrawdownModel;
  readonly basis: DrawdownBasis;
  /**
   * Many firms stop trailing once the floor reaches the starting balance, so
   * the account can never be closed at a loss to the trader once it is in
   * profit by the drawdown amount.
   */
  readonly lockAtStartingBalance: boolean;
  readonly startingBalance: Dec;
  /** `soft` flattens and locks out for the day; `hard` ends the account. */
  readonly breachAction: 'soft' | 'hard';
  /** Fraction of the buffer remaining at which to start warning. 0.25 = last quarter. */
  readonly warnAtRemainingFraction: Dec;
  /** IANA zone for the daily close used by `trailing-eod`. */
  readonly dayBoundaryTimeZone: string;
  /** Local `HH:MM` of the daily close. */
  readonly dayBoundaryLocalTime: string;
}

export interface DrawdownState {
  /** Highest observed value of the tracked basis, per the model's update rule. */
  readonly highWater: Dec;
  /** The value the account must stay above. */
  readonly floor: Dec;
  /** Start of the day-window whose close last updated `highWater`. */
  readonly currentDayStart: number;
  /** Highest value seen so far within the current day, staged for the EOD update. */
  readonly dayHigh: Dec;
  readonly breached: boolean;
  readonly breachedAt?: number;
  readonly lastUpdatedAt: number;
}

export interface DrawdownReading {
  readonly state: DrawdownState;
  /** How much the tracked basis may still fall before breaching. */
  readonly buffer: Dec;
  /** `buffer` as a fraction of the drawdown allowance. 1 = untouched. */
  readonly bufferFraction: Dec;
  readonly status: 'ok' | 'warning' | 'breached' | 'not-applicable';
  /** Emitted exactly once, on the transition into a breach. */
  readonly justBreached: boolean;
  readonly explain: string;
}

function allowance(model: DrawdownModel): Dec | undefined {
  return model.kind === 'none' ? undefined : model.amount;
}

export function initialDrawdownState(config: DrawdownConfig, at: number): DrawdownState {
  const amount = allowance(config.model);
  return {
    highWater: config.startingBalance,
    floor: amount === undefined ? D.ZERO : D.sub(config.startingBalance, amount),
    currentDayStart: dayStart(config, at),
    dayHigh: config.startingBalance,
    breached: false,
    lastUpdatedAt: at,
  };
}

function dayStart(config: DrawdownConfig, at: number): number {
  return lastLocalTimeAtOrBefore(at, config.dayBoundaryTimeZone, config.dayBoundaryLocalTime);
}

/**
 * Advance the tracker with a new account observation.
 *
 * Pure: the caller persists the returned state. Once `breached` is set it is
 * never cleared here — clearing a breach is an operator decision that goes
 * through the ledger, not an arithmetic side effect.
 */
export function updateDrawdown(
  prev: DrawdownState,
  config: DrawdownConfig,
  observation: { readonly balance: Dec; readonly equity: Dec; readonly at: number },
): DrawdownReading {
  const amount = allowance(config.model);
  if (amount === undefined) {
    return {
      state: { ...prev, lastUpdatedAt: observation.at },
      buffer: D.ZERO,
      bufferFraction: D.ONE,
      status: 'not-applicable',
      justBreached: false,
      explain: 'No drawdown model configured.',
    };
  }

  const value = config.basis === 'equity' ? observation.equity : observation.balance;
  const boundary = dayStart(config, observation.at);
  const dayRolled = boundary > prev.currentDayStart;

  let highWater = prev.highWater;
  let dayHigh = D.max(prev.dayHigh, value);

  switch (config.model.kind) {
    case 'static':
      // Floor never moves off the starting balance.
      break;
    case 'trailing-intraday':
      highWater = D.max(highWater, value);
      break;
    case 'trailing-eod':
      if (dayRolled) {
        // The day that just ended contributes its high; then a fresh day begins.
        highWater = D.max(highWater, prev.dayHigh);
        dayHigh = value;
      }
      break;
    case 'none':
      break;
  }

  let floor = D.sub(highWater, amount);
  if (config.lockAtStartingBalance && D.gt(floor, config.startingBalance)) {
    floor = config.startingBalance;
  }

  const alreadyBreached = prev.breached;
  const nowBelow = D.lt(value, floor);
  const breached = alreadyBreached || nowBelow;
  const justBreached = !alreadyBreached && nowBelow;

  const buffer = D.sub(value, floor);
  const bufferFraction = D.isZero(amount)
    ? D.ZERO
    : D.max(D.ZERO, D.div(buffer, amount, 4, 'down'));

  const status: DrawdownReading['status'] = breached
    ? 'breached'
    : D.lte(bufferFraction, config.warnAtRemainingFraction)
      ? 'warning'
      : 'ok';

  const state: DrawdownState = {
    highWater,
    floor,
    currentDayStart: dayRolled ? boundary : prev.currentDayStart,
    dayHigh,
    breached,
    ...(breached ? { breachedAt: prev.breachedAt ?? observation.at } : {}),
    lastUpdatedAt: observation.at,
  };

  return {
    state,
    buffer,
    bufferFraction,
    status,
    justBreached,
    explain: explain(config, state, value, buffer),
  };
}

function explain(config: DrawdownConfig, state: DrawdownState, value: Dec, buffer: Dec): string {
  const basis = config.basis === 'equity' ? 'equity (includes floating P&L)' : 'closed balance';
  const model =
    config.model.kind === 'static'
      ? 'static floor'
      : config.model.kind === 'trailing-eod'
        ? 'floor trails the daily close'
        : config.model.kind === 'trailing-intraday'
          ? 'floor trails live equity'
          : 'no model';
  if (state.breached) {
    return `Breached. ${basis} ${D.toString(value)} is below the floor ${D.toString(state.floor)} (${model}).`;
  }
  return (
    `${D.toString(buffer)} of buffer left: ${basis} is ${D.toString(value)}, ` +
    `floor is ${D.toString(state.floor)} (${model}, high-water ${D.toString(state.highWater)}).`
  );
}

/**
 * The largest loss that can be taken without breaching, given the current
 * reading. Used to cap per-trade risk near the wall: a 1% rule is irrelevant if
 * only 0.3% of drawdown buffer remains.
 */
export function maxLossBeforeBreach(reading: DrawdownReading): Dec {
  return D.max(D.ZERO, reading.buffer);
}
