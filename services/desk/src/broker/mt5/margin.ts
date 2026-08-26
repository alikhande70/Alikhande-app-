import type { Dec } from '@keel/core';
import * as D from '@keel/core';

/**
 * Request-specific margin, as MT5 actually models it.
 *
 * `InstrumentSpec.marginRate` is a single scalar, and MT5 has no such thing to
 * give. Required margin depends on the proposed order — its type, volume, price
 * — and on the account's current state at that moment. MetaTrader exposes it
 * through `OrderCalcMargin`, per request, not per symbol.
 *
 * So margin is a *fact about one proposed order*, carried with provenance and a
 * timestamp, and it expires. It is never cached onto an instrument, because an
 * instrument-level margin figure would be a value the venue never asserted.
 *
 * Absence is the important case. A margin that could not be obtained is
 * `unavailable`, and the risk governor blocks on it. It must never become
 * `0.00`: that reads as "this order needs no margin" and clears the free-margin
 * rule for any funded account, which is how a stale rate silently disables a
 * risk control.
 */

export type Mt5MarginOutcome =
  | {
      readonly status: 'available';
      readonly requiredAccountCurrency: Dec;
      /** Which MT5 call produced this, for the audit trail. */
      readonly source: 'OrderCalcMargin';
      /** Venue UTC ms at which the figure was computed. */
      readonly asOfUtcMs: number;
      /** Echoed so a figure can never be applied to a different request. */
      readonly requestFingerprint: Mt5MarginRequestFingerprint;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: string;
      /** Distinguishes "the venue said no" from "we never heard back". */
      readonly certainty: 'refused' | 'unknown';
    };

export interface Mt5MarginRequestFingerprint {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly volume: string;
  readonly price: string;
}

export class Mt5MarginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mt5MarginError';
  }
}

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

function decimalField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !DECIMAL.test(field)) {
    throw new Mt5MarginError(`margin.${key} must be a non-negative plain decimal string`);
  }
  return field;
}

/**
 * Parse an agent margin response.
 *
 * Fails closed in every direction: a malformed body, a missing field, a
 * mismatched fingerprint and a negative figure all produce `unavailable`
 * rather than a number. The caller cannot accidentally read a partially
 * understood response as a margin.
 */
export function parseMt5MarginResponse(
  value: unknown,
  expected: Mt5MarginRequestFingerprint,
): Mt5MarginOutcome {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      status: 'unavailable',
      reason: 'margin response was not an object',
      certainty: 'unknown',
    };
  }
  const row = value as Record<string, unknown>;

  if (row.status === 'unavailable') {
    const reason =
      typeof row.reason === 'string' && row.reason.length > 0
        ? row.reason
        : 'venue did not supply a reason';
    // A venue that explicitly declines is a different fact from silence, and the
    // operator should be able to tell them apart.
    return { status: 'unavailable', reason, certainty: 'refused' };
  }

  try {
    const required = decimalField(row, 'requiredAccountCurrency');
    const asOf = row.asOfUtcMs;
    if (typeof asOf !== 'number' || !Number.isFinite(asOf) || asOf <= 0) {
      throw new Mt5MarginError('margin.asOfUtcMs must be a positive finite number');
    }
    const fingerprint = row.requestFingerprint;
    if (typeof fingerprint !== 'object' || fingerprint === null) {
      throw new Mt5MarginError('margin.requestFingerprint is required');
    }
    const fp = fingerprint as Record<string, unknown>;
    // A margin figure computed for a different order is worse than none: it
    // looks authoritative and describes something else.
    if (
      fp.symbol !== expected.symbol ||
      fp.side !== expected.side ||
      fp.volume !== expected.volume ||
      fp.price !== expected.price
    ) {
      throw new Mt5MarginError('margin response fingerprint does not match the proposed request');
    }

    return {
      status: 'available',
      requiredAccountCurrency: D.dec(required),
      source: 'OrderCalcMargin',
      asOfUtcMs: asOf,
      requestFingerprint: expected,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
      certainty: 'unknown',
    };
  }
}

/**
 * Whether a margin figure is still usable.
 *
 * Margin depends on account state, so a figure from ten minutes ago describes an
 * account that may no longer exist. Staleness makes it unavailable rather than
 * approximately right.
 */
export function marginIsFresh(
  outcome: Mt5MarginOutcome,
  nowUtcMs: number,
  maxAgeMs: number,
): boolean {
  if (outcome.status !== 'available') return false;
  const age = nowUtcMs - outcome.asOfUtcMs;
  return age >= 0 && age <= maxAgeMs;
}

/**
 * The value to hand the risk governor: a Dec when it is genuinely known and
 * fresh, `undefined` otherwise. There is deliberately no third option and no
 * default.
 */
export function marginForGovernor(
  outcome: Mt5MarginOutcome,
  nowUtcMs: number,
  maxAgeMs: number,
): Dec | undefined {
  return marginIsFresh(outcome, nowUtcMs, maxAgeMs) && outcome.status === 'available'
    ? outcome.requiredAccountCurrency
    : undefined;
}
