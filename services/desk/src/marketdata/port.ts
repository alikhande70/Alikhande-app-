import * as D from '@keel/core';
import type { Dec } from '@keel/core';

/**
 * The market-data plane (ADR-0013).
 *
 * Two independently-sourced planes, never mixed:
 *
 * - **execution** — prices from the broker. The only prices used to validate,
 *   size or price an order.
 * - **reference** — an independent provider, used for charts and context and to
 *   catch a broker feed that has frozen while still looking connected.
 *
 * The plane travels with every value, so the UI can render an executable price
 * and a reference price differently. A reference price that looks executable is
 * a trade placed against a number nobody will honour.
 */

export type Plane = 'execution' | 'reference';

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export interface Tick {
  readonly canonical: string;
  readonly bid: Dec;
  readonly ask: Dec;
  /** Last traded price, when the venue reports one. */
  readonly last?: Dec;
  /** Source timestamp from the venue. Never arrival time. */
  readonly asOf: number;
  readonly plane: Plane;
  readonly origin: string;
}

export interface Bar {
  readonly t: number;
  readonly o: Dec;
  readonly h: Dec;
  readonly l: Dec;
  readonly c: Dec;
  readonly v: Dec;
}

export type MarketDataEvent =
  | { readonly type: 'connected'; readonly at: number }
  | { readonly type: 'disconnected'; readonly at: number; readonly reason: string }
  | { readonly type: 'tick'; readonly tick: Tick }
  | { readonly type: 'error'; readonly at: number; readonly detail: string; readonly fatal: boolean };

export interface MarketDataProvider {
  readonly name: string;
  readonly plane: Plane;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  subscribe(canonicals: readonly string[]): Promise<void>;
  unsubscribe(canonicals: readonly string[]): Promise<void>;
  getBars(canonical: string, timeframe: Timeframe, limit: number): Promise<readonly Bar[]>;
  on(handler: (e: MarketDataEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Staleness — one authority for the whole system
// ---------------------------------------------------------------------------

export type Freshness =
  /** Recent enough to trade against. */
  | 'live'
  /** Older than expected but still usable for reading the market. */
  | 'aging'
  /** Too old to be trusted for anything. */
  | 'stale';

export interface StalenessBudget {
  /** Beyond this, a value is `aging`. */
  readonly liveMs: number;
  /** Beyond this, a value is `stale`. */
  readonly staleMs: number;
}

/**
 * Budgets by instrument class. A quiet FX pair at 03:00 legitimately goes
 * seconds without a tick; a crypto perp does not. Using one budget everywhere
 * either cries wolf overnight or misses a genuinely frozen feed.
 */
export const DEFAULT_BUDGETS: Readonly<Record<string, StalenessBudget>> = {
  fx: { liveMs: 3_000, staleMs: 30_000 },
  metal: { liveMs: 3_000, staleMs: 30_000 },
  crypto: { liveMs: 2_000, staleMs: 15_000 },
  index: { liveMs: 5_000, staleMs: 60_000 },
  default: { liveMs: 3_000, staleMs: 30_000 },
};

export function budgetFor(assetClass: string): StalenessBudget {
  return DEFAULT_BUDGETS[assetClass] ?? (DEFAULT_BUDGETS.default as StalenessBudget);
}

/**
 * Classify a value's freshness.
 *
 * The desk computes this and puts the answer on the wire; the client never
 * works it out for itself. Two implementations of "is this stale?" will
 * eventually disagree, and the moment they do, the app shows a live badge over
 * a dead price.
 */
export function freshness(asOf: number, now: number, budget: StalenessBudget): Freshness {
  const age = now - asOf;
  // A source timestamp in the future means clock skew between us and the venue.
  // Treat it as live rather than as an error, but never as more authoritative
  // than a real reading — the age is clamped at zero, not negative.
  if (age <= budget.liveMs) return 'live';
  if (age <= budget.staleMs) return 'aging';
  return 'stale';
}

export function ageMs(asOf: number, now: number): number {
  return Math.max(0, now - asOf);
}

/** Whether a value may be used to build or validate an order. */
export function isTradeable(f: Freshness): boolean {
  return f === 'live';
}

/**
 * Human-readable age, for a badge. Deliberately blunt at the top end: "3m ago"
 * reads as a fact, where a spinner reads as "loading" and hides the problem.
 */
export function describeAge(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

/** Mid price. Advisory only — orders are priced from bid or ask, never the mid. */
export function mid(tick: Tick): Dec {
  return D.Decimal.div(D.Decimal.add(tick.bid, tick.ask), D.dec(2), Math.max(tick.bid.s, tick.ask.s) + 1, 'half-even');
}

export function spread(tick: Tick): Dec {
  return D.Decimal.sub(tick.ask, tick.bid);
}

/**
 * A quote whose bid is above its ask is impossible, and a venue that emits one
 * is malfunctioning. Reject it rather than letting it reach sizing, where it
 * would produce a negative stop distance.
 */
export function isCrossed(tick: Tick): boolean {
  return D.Decimal.gt(tick.bid, tick.ask);
}
