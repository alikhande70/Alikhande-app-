import type { Dec, InstrumentSpec } from '@keel/core';
import * as D from '@keel/core';
import type { Clock } from '../sim/clock.js';
import { Rng } from '../sim/rng.js';
import { BarAggregator } from './aggregator.js';
import type { Bar, MarketDataEvent, MarketDataProvider, Tick, Timeframe } from './port.js';

/**
 * A synthetic feed that misbehaves on purpose.
 *
 * Its job is not to look like a market — it is to produce the pathologies the
 * rest of the system claims to survive, deterministically, so those claims can
 * be tested rather than asserted.
 *
 * The most important one is `freeze`: quotes stop arriving while the connection
 * stays up and healthy. That is the failure mode that makes stale data look
 * live, and it is invisible to any check that only asks "are we connected?".
 */

export type Regime = 'trend' | 'range' | 'volatile';

export interface SyntheticPathologies {
  /** Probability per tick that the spread widens sharply for a while. */
  readonly spreadWideningRate: number;
  /** Probability per tick that the feed goes silent while staying connected. */
  readonly freezeRate: number;
  /** How long a freeze lasts. */
  readonly freezeDurationMs: number;
  /** Probability per tick of a price gap with no intervening prints. */
  readonly gapRate: number;
  /** Probability per tick of a spike that immediately reverts. */
  readonly spikeRate: number;
  /** Probability per tick that the venue emits a crossed (bid > ask) book. */
  readonly crossedBookRate: number;
}

export const CALM: SyntheticPathologies = {
  spreadWideningRate: 0,
  freezeRate: 0,
  freezeDurationMs: 0,
  gapRate: 0,
  spikeRate: 0,
  crossedBookRate: 0,
};

export const HOSTILE: SyntheticPathologies = {
  spreadWideningRate: 0.02,
  freezeRate: 0.005,
  freezeDurationMs: 45_000,
  gapRate: 0.01,
  spikeRate: 0.005,
  crossedBookRate: 0.001,
};

export interface SyntheticOptions {
  readonly clock: Clock;
  readonly seed: number;
  readonly instruments: readonly InstrumentSpec[];
  readonly startPrices: Readonly<Record<string, string>>;
  readonly regime?: Regime;
  readonly tickIntervalMs?: number;
  readonly pathologies?: SyntheticPathologies;
  readonly plane?: 'execution' | 'reference';
}

interface SymbolState {
  spec: InstrumentSpec;
  price: Dec;
  spreadTicks: number;
  widenUntil: number;
  frozenUntil: number;
  drift: number;
}

export class SyntheticProvider implements MarketDataProvider {
  readonly name = 'synthetic';
  readonly plane: 'execution' | 'reference';

  private readonly rng: Rng;
  private readonly handlers = new Set<(e: MarketDataEvent) => void>();
  private readonly states = new Map<string, SymbolState>();
  private readonly aggregators = new Map<string, BarAggregator>();
  private readonly subscribed = new Set<string>();
  private connected = false;
  private cancelTimer: (() => void) | undefined;

  constructor(private readonly opts: SyntheticOptions) {
    this.plane = opts.plane ?? 'reference';
    this.rng = new Rng(opts.seed);
    for (const spec of opts.instruments) {
      const start = opts.startPrices[spec.canonical];
      if (start === undefined) continue;
      this.states.set(spec.canonical, {
        spec,
        price: D.dec(start),
        spreadTicks: spec.assetClass === 'fx' ? 10 : 30,
        widenUntil: 0,
        frozenUntil: 0,
        drift: opts.regime === 'trend' ? 0.15 : 0,
      });
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  on(handler: (e: MarketDataEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(e: MarketDataEvent): void {
    for (const h of this.handlers) h(e);
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.emit({ type: 'connected', at: this.opts.clock.now() });
    this.cancelTimer = this.opts.clock.setInterval(
      () => this.tick(),
      this.opts.tickIntervalMs ?? 1_000,
    );
  }

  async disconnect(): Promise<void> {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.connected = false;
    this.emit({ type: 'disconnected', at: this.opts.clock.now(), reason: 'stopped' });
  }

  async subscribe(canonicals: readonly string[]): Promise<void> {
    for (const c of canonicals) this.subscribed.add(c);
  }

  async unsubscribe(canonicals: readonly string[]): Promise<void> {
    for (const c of canonicals) this.subscribed.delete(c);
  }

  async getBars(canonical: string, timeframe: Timeframe, limit: number): Promise<readonly Bar[]> {
    const agg = this.aggregatorFor(canonical, timeframe);
    return agg.bars().slice(-limit);
  }

  /** Force a freeze, for a test that needs one deterministically. */
  freeze(canonical: string, durationMs: number): void {
    const s = this.states.get(canonical);
    if (s !== undefined) s.frozenUntil = this.opts.clock.now() + durationMs;
  }

  private aggregatorFor(canonical: string, timeframe: Timeframe): BarAggregator {
    const key = `${canonical}:${timeframe}`;
    const existing = this.aggregators.get(key);
    if (existing !== undefined) return existing;
    const created = new BarAggregator({ timeframe, retain: 500 });
    this.aggregators.set(key, created);
    return created;
  }

  private tick(): void {
    if (!this.connected) return;
    const p = this.opts.pathologies ?? CALM;
    const now = this.opts.clock.now();

    for (const canonical of this.subscribed) {
      const s = this.states.get(canonical);
      if (s === undefined) continue;

      // A frozen feed stays connected and simply says nothing. Nothing about
      // the transport reveals it; only the age of the last tick does.
      if (now < s.frozenUntil) continue;
      if (this.rng.chance(p.freezeRate)) {
        s.frozenUntil = now + p.freezeDurationMs;
        continue;
      }

      const volatility =
        this.opts.regime === 'volatile' ? 3 : this.opts.regime === 'range' ? 0.6 : 1;
      let moveTicks = Math.round(this.rng.normal(s.drift, 4 * volatility));
      if (this.rng.chance(p.gapRate)) moveTicks *= 12;

      const spike = this.rng.chance(p.spikeRate);
      if (spike) moveTicks *= 25;

      s.price = D.snapPrice(
        s.spec,
        D.Decimal.add(s.price, D.Decimal.mul(s.spec.tickSize, D.dec(String(moveTicks)))),
        'nearest',
      );
      if (D.Decimal.lte(s.price, D.Decimal.ZERO)) {
        s.price = D.dec(this.opts.startPrices[canonical] ?? '1');
      }

      if (this.rng.chance(p.spreadWideningRate)) s.widenUntil = now + 20_000;
      const widen = now < s.widenUntil ? 6 : 1;
      const halfSpread = D.Decimal.mul(
        s.spec.tickSize,
        D.dec(String(Math.max(1, Math.round((s.spreadTicks * widen) / 2)))),
      );

      let bid = D.snapPrice(s.spec, D.Decimal.sub(s.price, halfSpread), 'down');
      let ask = D.snapPrice(s.spec, D.Decimal.add(s.price, halfSpread), 'up');
      if (this.rng.chance(p.crossedBookRate)) {
        // A venue bug: bid above ask. Downstream must refuse it.
        const t = bid;
        bid = ask;
        ask = t;
      }

      const tick: Tick = {
        canonical,
        bid,
        ask,
        last: s.price,
        asOf: now,
        plane: this.plane,
        origin: this.name,
      };
      this.emit({ type: 'tick', tick });

      for (const tf of ['1m', '5m', '1h'] as const) {
        this.aggregatorFor(canonical, tf).push(tick);
      }

      if (spike) {
        // Spikes revert; that is what makes them dangerous to act on.
        s.price = D.snapPrice(
          s.spec,
          D.Decimal.sub(s.price, D.Decimal.mul(s.spec.tickSize, D.dec(String(moveTicks)))),
          'nearest',
        );
      }
    }
  }
}
