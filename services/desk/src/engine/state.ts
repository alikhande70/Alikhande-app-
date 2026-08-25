import type {
  AccountSnapshot,
  DayStats,
  DrawdownConfig,
  DrawdownReading,
  DrawdownState,
  InstrumentSpec,
  OpenPositionRisk,
  RiskPolicy,
} from '@keel/core';
import * as D from '@keel/core';
import { defaultRiskPolicy, FxBook, initialDrawdownState, updateDrawdown } from '@keel/core';
import type { Database as Db } from 'better-sqlite3';
import type { BrokerQuote } from '../broker/port.js';
import type { Ledger } from '../ledger/ledger.js';
import type { Projector } from '../ledger/projections.js';
import type { Clock } from '../sim/clock.js';

/**
 * The desk's read model.
 *
 * Everything the risk governor needs, assembled from projections plus live
 * quotes. Kept separate from the write path so a read can never mutate state,
 * and so the risk context can be built identically for a preview and for a real
 * submission.
 */

export interface LivePosition {
  readonly positionId: string;
  readonly canonical: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly volume: D.Dec;
  readonly entryPrice: D.Dec;
  readonly stopPrice?: D.Dec;
  readonly takeProfitPrice?: D.Dec;
  readonly openedAt: number;
  readonly intentId?: string;
  readonly foreign: boolean;
  readonly asOf: number;
}

/**
 * Working precision for the spread moving average. Well beyond any venue's
 * price precision, and fixed — see `setExecutionQuote`.
 */
const SPREAD_EMA_SCALE = 10;

export class DeskState {
  private readonly db: Db;
  private readonly fx = new FxBook();
  private readonly quotes = new Map<string, BrokerQuote>();
  private readonly referenceQuotes = new Map<string, BrokerQuote>();
  private readonly typicalSpread = new Map<string, D.Dec>();
  private drawdownState: DrawdownState;
  private policyCache: RiskPolicy;

  constructor(
    private readonly ledger: Ledger,
    readonly projector: Projector,
    private readonly clock: Clock,
    policy?: RiskPolicy,
  ) {
    this.db = ledger.db;
    this.policyCache = policy ?? defaultRiskPolicy();
    this.drawdownState = this.loadDrawdownState();
  }

  // --- Policy ---------------------------------------------------------------

  get policy(): RiskPolicy {
    return this.policyCache;
  }

  setPolicy(p: RiskPolicy): void {
    this.policyCache = p;
  }

  // --- Quotes ---------------------------------------------------------------

  /** Executable prices, from the broker. The only prices used for orders. */
  setExecutionQuote(q: BrokerQuote): void {
    this.quotes.set(q.canonical, q);
    if (/^[A-Z]{6}$/.test(q.canonical)) {
      this.fx.upsert({ pair: q.canonical, bid: q.bid, ask: q.ask, asOf: q.asOf });
    }
    const spread = D.Decimal.sub(q.ask, q.bid);
    const prev = this.typicalSpread.get(q.canonical);
    // Exponential moving average of spread, for the abnormal-spread rule.
    //
    // The rescale is not cosmetic. Each step multiplies the previous average by
    // a 2-decimal weight, so without it the scale grows by two on every quote
    // and overflows the ceiling within a few seconds of a live feed — which is
    // exactly how this was found, by the chaos suite crashing the quote path.
    // Any accumulator fed by its own output has to be re-bounded each step.
    this.typicalSpread.set(
      q.canonical,
      prev === undefined
        ? D.Decimal.rescale(spread, SPREAD_EMA_SCALE, 'half-even')
        : D.Decimal.rescale(
            D.Decimal.add(D.Decimal.mul(prev, D.dec('0.99')), D.Decimal.mul(spread, D.dec('0.01'))),
            SPREAD_EMA_SCALE,
            'half-even',
          ),
    );
  }

  /** Independent prices, for charting and context. Never used to size an order. */
  setReferenceQuote(q: BrokerQuote): void {
    this.referenceQuotes.set(q.canonical, q);
  }

  getExecutionQuote(canonical: string): BrokerQuote | undefined {
    return this.quotes.get(canonical);
  }

  getReferenceQuote(canonical: string): BrokerQuote | undefined {
    return this.referenceQuotes.get(canonical);
  }

  getTypicalSpread(canonical: string): D.Dec | undefined {
    const raw = this.typicalSpread.get(canonical);
    return raw === undefined ? undefined : D.Decimal.rescale(raw, 6, 'half-even');
  }

  get fxBook(): FxBook {
    return this.fx;
  }

  allExecutionQuotes(): readonly BrokerQuote[] {
    return [...this.quotes.values()];
  }

  // --- Instruments ----------------------------------------------------------

  getInstrument(canonical: string): InstrumentSpec | undefined {
    const row = this.db
      .prepare('SELECT spec FROM instruments WHERE canonical = ?')
      .get(canonical) as { spec: string } | undefined;
    if (row === undefined) return undefined;
    return reviveSpec(JSON.parse(row.spec) as Record<string, unknown>);
  }

  allInstruments(): readonly InstrumentSpec[] {
    const rows = this.db.prepare('SELECT spec FROM instruments').all() as Array<{ spec: string }>;
    return rows.map((r) => reviveSpec(JSON.parse(r.spec) as Record<string, unknown>));
  }

  // --- Account --------------------------------------------------------------

  getAccount(): AccountSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM account_state WHERE id = 1').get() as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return {
      currency: row.currency as string,
      balance: D.dec(row.balance as string),
      equity: D.dec(row.equity as string),
      marginUsed: D.dec(row.margin_used as string),
      marginFree: D.dec(row.margin_free as string),
      asOf: row.as_of as number,
      source: row.source as 'broker' | 'derived',
    };
  }

  // --- Positions ------------------------------------------------------------

  openPositions(): readonly LivePosition[] {
    const rows = this.db.prepare('SELECT * FROM positions WHERE closed_at IS NULL').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => {
      const stop = r.stop_price as string | null;
      const tp = r.take_profit as string | null;
      const intentId = r.intent_id as string | null;
      return {
        positionId: r.position_id as string,
        canonical: r.canonical as string,
        symbol: r.symbol as string,
        side: r.side as 'buy' | 'sell',
        volume: D.dec(r.volume as string),
        entryPrice: D.dec(r.entry_price as string),
        openedAt: r.opened_at as number,
        foreign: (r.foreign_origin as number) === 1,
        asOf: r.as_of as number,
        ...(stop !== null ? { stopPrice: D.dec(stop) } : {}),
        ...(tp !== null ? { takeProfitPrice: D.dec(tp) } : {}),
        ...(intentId !== null ? { intentId } : {}),
      };
    });
  }

  /**
   * Open positions expressed as risk.
   *
   * A position without a stop deliberately gets `riskAccount: undefined` rather
   * than a number, because its downside is genuinely unbounded and the governor
   * must refuse to compare it to a cap.
   */
  openPositionRisks(): readonly OpenPositionRisk[] {
    const account = this.getAccount();
    return this.openPositions().map((p) => {
      const spec = this.getInstrument(p.canonical);
      if (p.stopPrice === undefined) {
        return {
          canonical: p.canonical,
          side: p.side,
          volume: p.volume,
          riskUnknownReason: 'no-stop' as const,
        };
      }
      if (spec === undefined || account === undefined) {
        return {
          canonical: p.canonical,
          side: p.side,
          volume: p.volume,
          riskUnknownReason: 'cannot-value' as const,
        };
      }
      const distance = D.Decimal.abs(D.Decimal.sub(p.entryPrice, p.stopPrice));
      const quoteLoss = D.priceMoveValueQuote(spec, p.volume, distance);
      const conv = this.fx.convert({
        amount: quoteLoss,
        from: spec.quote,
        to: account.currency,
        basis: 'worst-case',
        now: this.clock.now(),
        maxAgeMs: 60_000,
      });
      if (!conv.ok) {
        // It has a stop; we just cannot price it right now.
        return {
          canonical: p.canonical,
          side: p.side,
          volume: p.volume,
          riskUnknownReason: 'cannot-value' as const,
        };
      }
      return {
        canonical: p.canonical,
        side: p.side,
        volume: p.volume,
        riskAccount: D.Decimal.rescale(conv.amount, 2, 'half-even'),
      };
    });
  }

  // --- Risk state -----------------------------------------------------------

  private loadDrawdownState(): DrawdownState {
    const row = this.db.prepare('SELECT * FROM risk_state WHERE id = 1').get() as
      | Record<string, unknown>
      | undefined;
    const cfg = this.policyCache.drawdown;
    if (row === undefined) return initialDrawdownState(cfg, this.clock.now());
    const breachedAt = row.breached_at as number | null;
    return {
      highWater: D.dec(row.high_water as string),
      floor: D.dec(row.floor as string),
      currentDayStart: row.current_day_start as number,
      dayHigh: D.dec(row.day_high as string),
      breached: (row.breached as number) === 1,
      lastUpdatedAt: row.last_updated_at as number,
      ...(breachedAt !== null ? { breachedAt } : {}),
    };
  }

  /** Recompute drawdown from the current account. Returns the reading. */
  refreshDrawdown(account: AccountSnapshot, config?: DrawdownConfig): DrawdownReading {
    const cfg = config ?? this.policyCache.drawdown;
    const reading = updateDrawdown(this.drawdownState, cfg, {
      balance: account.balance,
      equity: account.equity,
      at: account.asOf,
    });
    this.drawdownState = reading.state;
    return reading;
  }

  currentDrawdown(): DrawdownReading {
    const account = this.getAccount();
    if (account === undefined) {
      return {
        state: this.drawdownState,
        buffer: D.Decimal.ZERO,
        bufferFraction: D.Decimal.ONE,
        status: 'not-applicable',
        justBreached: false,
        explain: 'No account snapshot yet.',
      };
    }
    return updateDrawdown(this.drawdownState, this.policyCache.drawdown, {
      balance: account.balance,
      equity: account.equity,
      at: account.asOf,
    });
  }

  dayStats(): DayStats {
    const row = this.db.prepare('SELECT * FROM risk_state WHERE id = 1').get() as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) {
      const account = this.getAccount();
      return {
        dayOpenBalance: account?.balance ?? D.dec('0.00'),
        tradesToday: 0,
        consecutiveLosses: 0,
      };
    }
    const lastLoss = row.last_loss_at as number | null;
    const open = row.day_open_balance as string;
    return {
      dayOpenBalance: open === '0' ? (this.getAccount()?.balance ?? D.dec('0.00')) : D.dec(open),
      tradesToday: row.trades_today as number,
      consecutiveLosses: row.consecutive_losses as number,
      ...(lastLoss !== null ? { lastLossAt: lastLoss } : {}),
    };
  }

  /**
   * The trading-day boundary this desk has already rolled to, from durable
   * state rather than memory.
   *
   * This must not live in a field initialised at start-up: a desk restarted
   * mid-day would then believe no day had been rolled, roll one immediately,
   * and reset the day's loss counter — silently clearing the daily loss limit
   * after a bad morning. Restarting a process must never widen a risk limit.
   */
  persistedDayStart(): number {
    const row = this.db.prepare('SELECT current_day_start FROM risk_state WHERE id = 1').get() as
      | { current_day_start: number }
      | undefined;
    return row?.current_day_start ?? 0;
  }

  lockout(): { until: number; reason: string } | undefined {
    const row = this.db
      .prepare('SELECT lockout_until, lockout_reason FROM risk_state WHERE id = 1')
      .get() as { lockout_until: number | null; lockout_reason: string | null } | undefined;
    if (row?.lockout_until == null) return undefined;
    if (row.lockout_until <= this.clock.now()) return undefined;
    return { until: row.lockout_until, reason: row.lockout_reason ?? 'locked' };
  }

  // --- Orders ---------------------------------------------------------------

  hasIntent(intentId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM orders WHERE intent_id = ?').get(intentId);
    return row !== undefined;
  }

  ordersInState(states: readonly string[]): readonly Record<string, unknown>[] {
    const placeholders = states.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT * FROM orders WHERE state IN (${placeholders})`)
      .all(...states) as Array<Record<string, unknown>>;
  }

  allOrders(limit = 200): readonly Record<string, unknown>[] {
    return this.db
      .prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
  }

  /**
   * Timestamps of materially identical intents, for the double-tap guard.
   * "Identical" is instrument + side + rounded size, which is what a double tap
   * actually produces; a deliberate add nearly always differs in at least one.
   */
  recentIdenticalIntents(
    canonical: string,
    side: string,
    volume: D.Dec,
    windowMs: number,
  ): number[] {
    const since = this.clock.now() - windowMs;
    const rows = this.db
      .prepare(
        `SELECT created_at, requested_qty FROM orders
         WHERE canonical = ? AND side = ? AND created_at >= ? AND state != 'FAILED_LOCAL'`,
      )
      .all(canonical, side, since) as Array<{ created_at: number; requested_qty: string }>;
    return rows
      .filter((r) => D.Decimal.eq(D.dec(r.requested_qty), volume))
      .map((r) => r.created_at);
  }

  get ledgerRef(): Ledger {
    return this.ledger;
  }
}

/** Rehydrate an instrument spec from its stored JSON form. */
export function reviveSpec(raw: Record<string, unknown>): InstrumentSpec {
  const tickValue = raw.tickValueAccount as string | undefined;
  return {
    symbol: raw.symbol as string,
    canonical: raw.canonical as string,
    assetClass: raw.assetClass as InstrumentSpec['assetClass'],
    base: raw.base as string,
    quote: raw.quote as string,
    digits: raw.digits as number,
    tickSize: D.dec(raw.tickSize as string),
    contractSize: D.dec(raw.contractSize as string),
    minVolume: D.dec(raw.minVolume as string),
    maxVolume: D.dec(raw.maxVolume as string),
    volumeStep: D.dec(raw.volumeStep as string),
    stopsLevel: D.dec(raw.stopsLevel as string),
    freezeLevel: D.dec(raw.freezeLevel as string),
    marginRate: D.dec(raw.marginRate as string),
    positionModel: raw.positionModel as InstrumentSpec['positionModel'],
    venueTimeZone: raw.venueTimeZone as string,
    asOf: raw.asOf as number,
    ...(tickValue !== undefined ? { tickValueAccount: D.dec(tickValue) } : {}),
  };
}

/** Serialise an instrument spec to its stored JSON form (decimal strings). */
export function specToJson(spec: InstrumentSpec): Record<string, unknown> {
  return {
    symbol: spec.symbol,
    canonical: spec.canonical,
    assetClass: spec.assetClass,
    base: spec.base,
    quote: spec.quote,
    digits: spec.digits,
    tickSize: D.Decimal.toString(spec.tickSize),
    contractSize: D.Decimal.toString(spec.contractSize),
    minVolume: D.Decimal.toString(spec.minVolume),
    maxVolume: D.Decimal.toString(spec.maxVolume),
    volumeStep: D.Decimal.toString(spec.volumeStep),
    stopsLevel: D.Decimal.toString(spec.stopsLevel),
    freezeLevel: D.Decimal.toString(spec.freezeLevel),
    marginRate: D.Decimal.toString(spec.marginRate),
    positionModel: spec.positionModel,
    venueTimeZone: spec.venueTimeZone,
    asOf: spec.asOf,
    ...(spec.tickValueAccount !== undefined
      ? { tickValueAccount: D.Decimal.toString(spec.tickValueAccount) }
      : {}),
  };
}
