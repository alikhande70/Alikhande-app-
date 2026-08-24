import type { Dec } from '../money/decimal.js';
import * as D from '../money/decimal.js';

/**
 * Currency conversion for risk and P&L.
 *
 * This module exists because the most common silent error in retail position
 * sizing is assuming the quote currency is the account currency. On EURUSD with
 * a USD account that assumption happens to hold; on GBPJPY it does not, and the
 * resulting lot size is wrong by the USDJPY rate — roughly 150x.
 *
 * The rule here is absolute: **if a rate is not available and fresh, conversion
 * fails.** It never falls back to 1.0, never interpolates, never uses a
 * remembered rate past its freshness budget.
 */

export interface FxQuote {
  /** Canonical 6-letter pair, e.g. `USDJPY`. */
  readonly pair: string;
  readonly bid: Dec;
  readonly ask: Dec;
  /** Source timestamp from the venue, epoch ms. Not arrival time. */
  readonly asOf: number;
}

export interface ConversionRequest {
  readonly amount: Dec;
  readonly from: string;
  readonly to: string;
  /**
   * `worst-case` picks whichever side of the spread produces the larger
   * magnitude. Used for risk: it makes losses look bigger, so sizing comes out
   * smaller. `mid` is for display and reporting only.
   */
  readonly basis: 'worst-case' | 'mid';
  readonly now: number;
  readonly maxAgeMs: number;
}

export interface ConversionHop {
  readonly pair: string;
  readonly direction: 'direct' | 'inverse';
  readonly rate: Dec;
  readonly asOf: number;
}

export type ConversionResult =
  | {
      readonly ok: true;
      readonly amount: Dec;
      /** Every quote used, so the number is fully traceable. */
      readonly path: readonly ConversionHop[];
      /** Oldest source timestamp on the path — the honest freshness of the result. */
      readonly asOf: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'NO_PATH' | 'STALE_RATE' | 'ZERO_RATE';
      readonly detail: string;
      /** Currencies we could not bridge, or the stale pair. */
      readonly blockedAt: string;
    };

/** Bridge currencies tried, in order, when no direct or inverse pair exists. */
const BRIDGES = ['USD', 'EUR', 'GBP', 'JPY'] as const;

/** Working scale for intermediate conversion maths. Trimmed by the caller. */
const CONV_SCALE = 12;

export class FxBook {
  private readonly byPair = new Map<string, FxQuote>();

  constructor(quotes: Iterable<FxQuote> = []) {
    for (const q of quotes) this.upsert(q);
  }

  upsert(q: FxQuote): void {
    this.byPair.set(q.pair.toUpperCase(), q);
  }

  get(pair: string): FxQuote | undefined {
    return this.byPair.get(pair.toUpperCase());
  }

  get size(): number {
    return this.byPair.size;
  }

  /**
   * Convert `amount` from one currency to another.
   *
   * Resolution order: identity, direct pair, inverse pair, then a two-hop cross
   * through a bridge currency. Every hop is freshness-checked independently.
   */
  convert(req: ConversionRequest): ConversionResult {
    const from = req.from.toUpperCase();
    const to = req.to.toUpperCase();

    if (from === to) {
      return { ok: true, amount: req.amount, path: [], asOf: req.now };
    }

    const direct = this.hop(from, to, req);
    if (direct.kind === 'stale') return direct.result;
    if (direct.kind === 'ok') {
      return {
        ok: true,
        amount: applyHop(req.amount, direct.hop),
        path: [direct.hop],
        asOf: direct.hop.asOf,
      };
    }

    for (const bridge of BRIDGES) {
      if (bridge === from || bridge === to) continue;
      const first = this.hop(from, bridge, req);
      if (first.kind !== 'ok') continue;
      const second = this.hop(bridge, to, req);
      if (second.kind !== 'ok') continue;
      const mid = applyHop(req.amount, first.hop);
      const out = applyHop(mid, second.hop);
      return {
        ok: true,
        amount: out,
        path: [first.hop, second.hop],
        asOf: Math.min(first.hop.asOf, second.hop.asOf),
      };
    }

    return {
      ok: false,
      reason: 'NO_PATH',
      detail:
        `no fresh quote path from ${from} to ${to}; ` +
        `tried direct, inverse, and bridges ${BRIDGES.join('/')}`,
      blockedAt: `${from}->${to}`,
    };
  }

  private hop(
    from: string,
    to: string,
    req: ConversionRequest,
  ):
    | { kind: 'ok'; hop: ConversionHop }
    | { kind: 'missing' }
    | { kind: 'stale'; result: ConversionResult } {
    const directPair = `${from}${to}`;
    const inversePair = `${to}${from}`;

    const direct = this.byPair.get(directPair);
    if (direct !== undefined) {
      if (req.now - direct.asOf > req.maxAgeMs) {
        return {
          kind: 'stale',
          result: {
            ok: false,
            reason: 'STALE_RATE',
            detail:
              `${directPair} last updated ${req.now - direct.asOf}ms ago, ` +
              `budget is ${req.maxAgeMs}ms`,
            blockedAt: directPair,
          },
        };
      }
      return {
        kind: 'ok',
        hop: {
          pair: directPair,
          direction: 'direct',
          rate: pick(direct, req.basis, 'direct'),
          asOf: direct.asOf,
        },
      };
    }

    const inverse = this.byPair.get(inversePair);
    if (inverse !== undefined) {
      if (req.now - inverse.asOf > req.maxAgeMs) {
        return {
          kind: 'stale',
          result: {
            ok: false,
            reason: 'STALE_RATE',
            detail:
              `${inversePair} last updated ${req.now - inverse.asOf}ms ago, ` +
              `budget is ${req.maxAgeMs}ms`,
            blockedAt: inversePair,
          },
        };
      }
      return {
        kind: 'ok',
        hop: {
          pair: inversePair,
          direction: 'inverse',
          rate: pick(inverse, req.basis, 'inverse'),
          asOf: inverse.asOf,
        },
      };
    }

    return { kind: 'missing' };
  }
}

/**
 * Choose the side of the spread.
 *
 * For a *direct* hop the amount is multiplied by the rate, so worst case (the
 * larger result) is the ask. For an *inverse* hop the amount is divided by the
 * rate, so worst case is the smaller rate — the bid.
 */
function pick(q: FxQuote, basis: 'worst-case' | 'mid', direction: 'direct' | 'inverse'): Dec {
  if (basis === 'mid') {
    return D.div(D.add(q.bid, q.ask), D.dec(2), CONV_SCALE, 'half-even');
  }
  return direction === 'direct' ? q.ask : q.bid;
}

function applyHop(amount: Dec, hop: ConversionHop): Dec {
  if (D.isZero(hop.rate)) {
    throw new Error(`fx: zero rate on ${hop.pair}`);
  }
  return hop.direction === 'direct'
    ? D.rescale(D.mul(amount, hop.rate), CONV_SCALE, 'half-even')
    : D.div(amount, hop.rate, CONV_SCALE, 'half-even');
}
