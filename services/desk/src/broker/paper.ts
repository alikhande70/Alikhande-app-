import type { Dec, InstrumentSpec } from '@keel/core';
import * as D from '@keel/core';
import type { Clock } from '../sim/clock.js';
import { Rng } from '../sim/rng.js';
import type {
  BrokerAccount,
  BrokerCapabilities,
  BrokerEvent,
  BrokerEventHandler,
  BrokerOrder,
  BrokerOrderRequest,
  BrokerPort,
  BrokerPosition,
  BrokerQuote,
  BrokerSubmitResult,
  LookupResult,
} from './port.js';

/**
 * A trading venue that behaves badly on purpose.
 *
 * This is not a stub. It is the substrate every other component is tested
 * against, so it models the things that actually go wrong at a real broker:
 * latency with a fat tail, slippage, partial fills, requotes, rejections for
 * margin and stops-level, disconnections, and — most importantly — responses
 * that never arrive, leaving the caller genuinely unable to tell whether the
 * order landed.
 *
 * Every behaviour is drawn from a seeded RNG, so any failure the chaos suite
 * finds replays exactly.
 */

export interface PaperFaults {
  /** Probability a submit returns no usable answer, having *possibly* executed. */
  readonly ambiguousRate: number;
  /** Probability a submit is explicitly rejected. */
  readonly rejectRate: number;
  /** Probability a market order fills in more than one piece. */
  readonly partialFillRate: number;
  /** Probability a requote pushes the fill price away from the quote. */
  readonly requoteRate: number;
  /** Probability the connection drops on any given tick. */
  readonly disconnectRate: number;
  /**
   * Probability that an "ambiguous" submit nevertheless executed at the venue.
   * This is the parameter that makes the simulator dangerous, and useful: the
   * engine must handle both branches without ever double-sending.
   */
  readonly ambiguousButExecutedRate: number;
  /** Probability a fill event is silently dropped, so only reconciliation finds it. */
  readonly dropFillEventRate: number;
  /** Probability a fill event is delivered twice. */
  readonly duplicateFillEventRate: number;
}

export const NO_FAULTS: PaperFaults = {
  ambiguousRate: 0,
  rejectRate: 0,
  partialFillRate: 0,
  requoteRate: 0,
  disconnectRate: 0,
  ambiguousButExecutedRate: 0.5,
  dropFillEventRate: 0,
  duplicateFillEventRate: 0,
};

/** Roughly what a decent retail ECN feels like on a busy day. */
export const REALISTIC_FAULTS: PaperFaults = {
  ambiguousRate: 0.01,
  rejectRate: 0.01,
  partialFillRate: 0.08,
  requoteRate: 0.05,
  disconnectRate: 0.0005,
  ambiguousButExecutedRate: 0.5,
  dropFillEventRate: 0.01,
  duplicateFillEventRate: 0.005,
};

export interface PaperConfig {
  readonly seed: number;
  readonly currency: string;
  readonly startingBalance: Dec;
  readonly instruments: readonly InstrumentSpec[];
  readonly faults: PaperFaults;
  /** Median submit round trip. The tail is log-normal from there. */
  readonly medianLatencyMs: number;
  /** Slippage standard deviation, in ticks. */
  readonly slippageTicks: number;
  /** Commission per lot per side, account currency. */
  readonly commissionPerLot: Dec;
  readonly capabilities?: Partial<BrokerCapabilities>;
}

interface SimOrder {
  venueOrderId: string;
  clientOrderId: string;
  canonical: string;
  symbol: string;
  side: 'buy' | 'sell';
  kind: BrokerOrderRequest['kind'];
  state: BrokerOrder['state'];
  requestedQty: Dec;
  filledQty: Dec;
  limitPrice?: Dec;
  stopTriggerPrice?: Dec;
  stopLoss?: Dec;
  takeProfit?: Dec;
  avgFillPrice?: Dec;
  createdAt: number;
  /** Remaining pieces of a partial fill, delivered on later ticks. */
  pendingPieces: Dec[];
}

interface SimPosition {
  positionId: string;
  canonical: string;
  symbol: string;
  side: 'buy' | 'sell';
  volume: Dec;
  entryPrice: Dec;
  stopPrice?: Dec;
  takeProfitPrice?: Dec;
  openedAt: number;
  clientOrderId?: string;
}

const DEFAULT_CAPS: BrokerCapabilities = {
  clientOrderId: 'native',
  findByClientOrderId: true,
  streamsFills: true,
  atomicStopLoss: true,
  partialFills: true,
  supportsPartialClose: true,
  serverTimeSource: 'broker',
  positionModel: 'hedging',
  maxOrdersPerSecond: 10,
};

export class PaperBroker implements BrokerPort {
  readonly name = 'paper';
  readonly capabilities: BrokerCapabilities;

  private readonly rng: Rng;
  private readonly handlers = new Set<BrokerEventHandler>();
  private readonly specs = new Map<string, InstrumentSpec>();
  private readonly quotes = new Map<string, BrokerQuote>();
  private readonly orders = new Map<string, SimOrder>();
  private readonly byClientId = new Map<string, string>();
  private readonly positions = new Map<string, SimPosition>();
  /** Which position each order opened, so its later fills accumulate into it. */
  private readonly positionByOrder = new Map<string, string>();
  private readonly closedPositionIds = new Set<string>();

  private connected = false;
  private balance: Dec;
  private realisedCosts: Dec = D.dec('0.00');
  private idSeq = 0;
  /** Orders the venue holds but has not told us about — the ambiguous branch. */
  private readonly hidden = new Set<string>();

  constructor(
    private readonly cfg: PaperConfig,
    private readonly clock: Clock,
  ) {
    this.capabilities = { ...DEFAULT_CAPS, ...cfg.capabilities };
    this.rng = new Rng(cfg.seed);
    this.balance = cfg.startingBalance;
    for (const s of cfg.instruments) this.specs.set(s.canonical, s);
  }

  // --- Lifecycle -----------------------------------------------------------

  async connect(): Promise<void> {
    await this.clock.sleep(this.rng.latencyMs(this.cfg.medianLatencyMs));
    this.connected = true;
    this.emit({ type: 'connected', at: this.clock.now() });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.emit({ type: 'disconnected', reason: 'client requested', at: this.clock.now() });
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Force a disconnection, as the chaos suite does. */
  forceDisconnect(reason: string): void {
    this.connected = false;
    this.emit({ type: 'disconnected', reason, at: this.clock.now() });
  }

  on(handler: BrokerEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(e: BrokerEvent): void {
    for (const h of this.handlers) h(e);
  }

  // --- Market --------------------------------------------------------------

  /** Feed a quote in. The engine's market-data plane drives this in production. */
  setQuote(q: BrokerQuote): void {
    this.quotes.set(q.canonical, q);
    if (this.connected) this.emit({ type: 'quote', at: q.asOf, quote: q });
  }

  async getQuote(canonical: string): Promise<BrokerQuote | undefined> {
    return this.quotes.get(canonical);
  }

  async getInstruments(): Promise<readonly InstrumentSpec[]> {
    this.assertConnected();
    return [...this.specs.values()];
  }

  // --- Account -------------------------------------------------------------

  async getAccount(): Promise<BrokerAccount> {
    this.assertConnected();
    return this.accountNow();
  }

  private accountNow(): BrokerAccount {
    const unrealised = D.Decimal.sum([...this.positions.values()].map((p) => this.pnlOf(p)));
    const equity = D.Decimal.add(this.balance, unrealised);
    const marginUsed = D.Decimal.sum(
      [...this.positions.values()].map((p) => {
        const spec = this.specs.get(p.canonical);
        if (spec === undefined) return D.Decimal.ZERO;
        return D.marginQuote(spec, p.volume, p.entryPrice);
      }),
    );
    return {
      currency: this.cfg.currency,
      balance: D.Decimal.rescale(this.balance, 2, 'half-even'),
      equity: D.Decimal.rescale(equity, 2, 'half-even'),
      marginUsed: D.Decimal.rescale(marginUsed, 2, 'half-even'),
      marginFree: D.Decimal.rescale(D.Decimal.sub(equity, marginUsed), 2, 'half-even'),
      asOf: this.clock.now(),
    };
  }

  private pnlOf(p: SimPosition): Dec {
    const q = this.quotes.get(p.canonical);
    const spec = this.specs.get(p.canonical);
    if (q === undefined || spec === undefined) return D.Decimal.ZERO;
    const exit = p.side === 'buy' ? q.bid : q.ask;
    const move =
      p.side === 'buy' ? D.Decimal.sub(exit, p.entryPrice) : D.Decimal.sub(p.entryPrice, exit);
    return D.Decimal.mul(D.Decimal.mul(move, spec.contractSize), p.volume);
  }

  async getPositions(): Promise<readonly BrokerPosition[]> {
    this.assertConnected();
    return [...this.positions.values()].map((p) => ({
      positionId: p.positionId,
      canonical: p.canonical,
      symbol: p.symbol,
      side: p.side,
      volume: p.volume,
      entryPrice: p.entryPrice,
      ...(p.stopPrice !== undefined ? { stopPrice: p.stopPrice } : {}),
      ...(p.takeProfitPrice !== undefined ? { takeProfitPrice: p.takeProfitPrice } : {}),
      unrealisedPnl: D.Decimal.rescale(this.pnlOf(p), 2, 'half-even'),
      openedAt: p.openedAt,
      ...(p.clientOrderId !== undefined ? { clientOrderId: p.clientOrderId } : {}),
    }));
  }

  async getOpenOrders(): Promise<readonly BrokerOrder[]> {
    this.assertConnected();
    return [...this.orders.values()]
      .filter((o) => !this.hidden.has(o.venueOrderId))
      .filter((o) => o.state === 'WORKING' || o.state === 'PARTIALLY_FILLED')
      .map((o) => this.toBrokerOrder(o));
  }

  // --- Submission ----------------------------------------------------------

  async placeOrder(req: BrokerOrderRequest): Promise<BrokerSubmitResult> {
    const latency = this.rng.latencyMs(this.cfg.medianLatencyMs);
    await this.clock.sleep(latency);
    const at = this.clock.now();

    if (!this.connected) {
      return { outcome: 'ambiguous', reason: 'not connected when the request was made', at };
    }

    // Idempotency: the venue itself deduplicates on client order id, which is
    // what makes a retry safe when the capability says it is supported.
    const existingId = this.byClientId.get(req.clientOrderId);
    if (existingId !== undefined) {
      const existing = this.orders.get(existingId);
      if (existing !== undefined) {
        return {
          outcome: 'acked',
          venueOrderId: existing.venueOrderId,
          state: existing.state,
          filledQty: existing.filledQty,
          ...(existing.avgFillPrice !== undefined ? { avgFillPrice: existing.avgFillPrice } : {}),
          at,
          venueStatus: 'duplicate client order id; returning the original',
        };
      }
    }

    const spec = this.specs.get(req.canonical);
    if (spec === undefined) {
      return {
        outcome: 'rejected',
        reason: `unknown instrument ${req.canonical}`,
        code: 'NO_SYMBOL',
        at,
      };
    }
    const quote = this.quotes.get(req.canonical);
    if (quote === undefined) {
      return { outcome: 'rejected', reason: 'no price for instrument', code: 'OFF_QUOTES', at };
    }

    const volumeCheck = D.normalizeVolume(spec, req.volume);
    if (!volumeCheck.ok) {
      return { outcome: 'rejected', reason: volumeCheck.detail, code: 'INVALID_VOLUME', at };
    }

    // Stops-level: the venue refuses a protective stop too close to market.
    const market = req.side === 'buy' ? quote.ask : quote.bid;
    if (req.stopLoss !== undefined && !D.respectsStopsLevel(spec, market, req.stopLoss)) {
      return {
        outcome: 'rejected',
        reason: 'stop is inside the minimum distance',
        code: 'INVALID_STOPS',
        at,
      };
    }

    if (this.rng.chance(this.cfg.faults.rejectRate)) {
      return {
        outcome: 'rejected',
        reason: 'venue rejected: temporary market condition',
        code: 'REQUOTE',
        at,
      };
    }

    const margin = D.marginQuote(spec, volumeCheck.volume, market);
    const account = this.accountNow();
    if (D.Decimal.gt(margin, account.marginFree)) {
      return { outcome: 'rejected', reason: 'not enough free margin', code: 'NO_MONEY', at };
    }

    // Create the order at the venue *before* deciding whether to answer. That
    // ordering is what makes the ambiguous branch realistic: the venue really
    // did receive it, and the caller really cannot tell.
    const order = this.createOrder(req, spec, quote, at);

    if (this.rng.chance(this.cfg.faults.ambiguousRate)) {
      if (this.rng.chance(this.cfg.faults.ambiguousButExecutedRate)) {
        // It really executed — we just never said so. `hidden` suppresses the
        // event stream, so the only ways to find out are a lookup by client
        // order id or reconciliation. This is the branch that makes a naive
        // "timeout means it failed" client open a second position.
        this.hidden.add(order.venueOrderId);
        this.settle(order, spec, quote, at);
        this.clock.setTimeout(() => {
          this.hidden.delete(order.venueOrderId);
        }, 2_000);
      } else {
        // It did not execute: roll it back, as a venue that failed mid-write would.
        this.orders.delete(order.venueOrderId);
        this.byClientId.delete(order.clientOrderId);
      }
      return { outcome: 'ambiguous', reason: 'no response from venue within timeout', at };
    }

    this.settle(order, spec, quote, at);
    const settled = this.orders.get(order.venueOrderId) as SimOrder;
    return {
      outcome: 'acked',
      venueOrderId: settled.venueOrderId,
      state: settled.state,
      filledQty: settled.filledQty,
      ...(settled.avgFillPrice !== undefined ? { avgFillPrice: settled.avgFillPrice } : {}),
      at,
    };
  }

  private createOrder(
    req: BrokerOrderRequest,
    spec: InstrumentSpec,
    _quote: BrokerQuote,
    at: number,
  ): SimOrder {
    const venueOrderId = `PV-${++this.idSeq}`;
    const order: SimOrder = {
      venueOrderId,
      clientOrderId: req.clientOrderId,
      canonical: req.canonical,
      symbol: req.symbol,
      side: req.side,
      kind: req.kind,
      state: 'WORKING',
      requestedQty: D.volumeAtVenuePrecision(spec, req.volume),
      filledQty: D.Decimal.rescale(D.Decimal.ZERO, D.Decimal.normalize(spec.volumeStep).s),
      ...(req.limitPrice !== undefined ? { limitPrice: req.limitPrice } : {}),
      ...(req.stopTriggerPrice !== undefined ? { stopTriggerPrice: req.stopTriggerPrice } : {}),
      ...(req.stopLoss !== undefined ? { stopLoss: req.stopLoss } : {}),
      ...(req.takeProfit !== undefined ? { takeProfit: req.takeProfit } : {}),
      createdAt: at,
      pendingPieces: [],
    };
    this.orders.set(venueOrderId, order);
    this.byClientId.set(req.clientOrderId, venueOrderId);
    return order;
  }

  /** Fill a market order now; leave a resting order working. */
  private settle(order: SimOrder, spec: InstrumentSpec, quote: BrokerQuote, at: number): void {
    if (order.kind !== 'market') {
      this.emit({ type: 'order', at, order: this.toBrokerOrder(order) });
      return;
    }
    const pieces = this.rng.chance(this.cfg.faults.partialFillRate)
      ? this.splitVolume(order.requestedQty, spec)
      : [order.requestedQty];

    const first = pieces[0] as Dec;
    order.pendingPieces = pieces.slice(1);
    this.applyFill(order, first, spec, quote, at);

    // Remaining pieces arrive on subsequent ticks, as they would in reality.
    let delay = 0;
    for (const piece of order.pendingPieces) {
      delay += this.rng.int(50, 400);
      this.clock.setTimeout(() => {
        const live = this.orders.get(order.venueOrderId);
        const q = this.quotes.get(order.canonical);
        if (live === undefined || q === undefined) return;
        if (live.state === 'CANCELLED') return;
        this.applyFill(live, piece, spec, q, this.clock.now());
      }, delay);
    }
  }

  private splitVolume(total: Dec, spec: InstrumentSpec): Dec[] {
    const stepScale = D.Decimal.normalize(spec.volumeStep).s;
    const half = D.Decimal.quantize(
      D.Decimal.div(total, D.dec(2), stepScale + 2, 'down'),
      spec.volumeStep,
      'down',
    );
    const firstPiece = D.volumeAtVenuePrecision(spec, half);
    if (D.Decimal.lte(firstPiece, D.Decimal.ZERO) || D.Decimal.gte(firstPiece, total))
      return [total];
    return [firstPiece, D.volumeAtVenuePrecision(spec, D.Decimal.sub(total, firstPiece))];
  }

  private applyFill(
    order: SimOrder,
    qty: Dec,
    spec: InstrumentSpec,
    quote: BrokerQuote,
    at: number,
  ): void {
    const base = order.side === 'buy' ? quote.ask : quote.bid;
    const price = this.withSlippage(base, spec, order.side);
    order.filledQty = D.Decimal.add(order.filledQty, qty);
    order.avgFillPrice =
      order.avgFillPrice === undefined
        ? price
        : D.Decimal.div(
            D.Decimal.add(
              D.Decimal.mul(order.avgFillPrice, D.Decimal.sub(order.filledQty, qty)),
              D.Decimal.mul(price, qty),
            ),
            order.filledQty,
            spec.digits + 2,
            'half-even',
          );
    order.state = D.Decimal.gte(order.filledQty, order.requestedQty)
      ? 'FILLED'
      : 'PARTIALLY_FILLED';

    this.openOrAdjustPosition(order, qty, price, spec, at);

    const commission = D.Decimal.rescale(
      D.Decimal.mul(qty, this.cfg.commissionPerLot),
      2,
      'half-even',
    );
    this.balance = D.Decimal.sub(this.balance, commission);
    this.realisedCosts = D.Decimal.add(this.realisedCosts, commission);

    const fillId = `PF-${order.venueOrderId}-${D.Decimal.toString(order.filledQty)}`;
    const event: BrokerEvent = {
      type: 'fill',
      at,
      fillId,
      venueOrderId: order.venueOrderId,
      clientOrderId: order.clientOrderId,
      qty,
      price,
    };

    if (this.hidden.has(order.venueOrderId)) return; // the ambiguous branch stays silent
    if (this.rng.chance(this.cfg.faults.dropFillEventRate)) return; // only reconciliation will find it
    this.emit(event);
    if (this.rng.chance(this.cfg.faults.duplicateFillEventRate)) this.emit(event);
    this.emit({ type: 'order', at, order: this.toBrokerOrder(order) });
    this.emit({ type: 'account', at, account: this.accountNow() });
  }

  private withSlippage(base: Dec, spec: InstrumentSpec, side: 'buy' | 'sell'): Dec {
    const requote = this.rng.chance(this.cfg.faults.requoteRate) ? 3 : 1;
    const ticks = Math.round(Math.abs(this.rng.normal(0, this.cfg.slippageTicks)) * requote);
    if (ticks === 0) return base;
    // Slippage is adverse: buys fill higher, sells fill lower.
    const delta = D.Decimal.mul(spec.tickSize, D.dec(ticks));
    return D.snapPrice(
      spec,
      side === 'buy' ? D.Decimal.add(base, delta) : D.Decimal.sub(base, delta),
      'nearest',
    );
  }

  private openOrAdjustPosition(
    order: SimOrder,
    qty: Dec,
    price: Dec,
    spec: InstrumentSpec,
    at: number,
  ): void {
    // A partially filled order produces several deals but ONE position. An
    // earlier version of this simulator opened a position per fill, which made
    // one order look like two positions carrying the same client order id —
    // indistinguishable, from the outside, from a duplicate execution. A venue
    // model that gets this wrong tests the wrong thing.
    const fromSameOrder = this.positionByOrder.get(order.venueOrderId);
    const existing = fromSameOrder === undefined ? undefined : this.positions.get(fromSameOrder);
    if (existing !== undefined) {
      const total = D.Decimal.add(existing.volume, qty);
      existing.entryPrice = D.Decimal.div(
        D.Decimal.add(
          D.Decimal.mul(existing.entryPrice, existing.volume),
          D.Decimal.mul(price, qty),
        ),
        total,
        spec.digits + 2,
        'half-even',
      );
      existing.volume = total;
      this.emit({ type: 'position', at, position: this.toBrokerPosition(existing) });
      return;
    }

    if (this.capabilities.positionModel === 'netting') {
      const opposite = [...this.positions.values()].find(
        (p) => p.canonical === order.canonical && p.side !== order.side,
      );
      if (opposite !== undefined) {
        const closeQty = D.Decimal.min(qty, opposite.volume);
        this.reducePosition(opposite, closeQty, price, spec, at);
        const remainder = D.Decimal.sub(qty, closeQty);
        if (D.Decimal.lte(remainder, D.Decimal.ZERO)) return;
        this.newPosition(order, remainder, price, at);
        return;
      }
      const same = [...this.positions.values()].find(
        (p) => p.canonical === order.canonical && p.side === order.side,
      );
      if (same !== undefined) {
        const total = D.Decimal.add(same.volume, qty);
        same.entryPrice = D.Decimal.div(
          D.Decimal.add(D.Decimal.mul(same.entryPrice, same.volume), D.Decimal.mul(price, qty)),
          total,
          spec.digits + 2,
          'half-even',
        );
        same.volume = total;
        this.emit({ type: 'position', at, position: this.toBrokerPosition(same) });
        return;
      }
    }
    this.newPosition(order, qty, price, at);
  }

  private newPosition(order: SimOrder, qty: Dec, price: Dec, at: number): void {
    const p: SimPosition = {
      positionId: `PP-${++this.idSeq}`,
      canonical: order.canonical,
      symbol: order.symbol,
      side: order.side,
      volume: qty,
      entryPrice: price,
      ...(order.stopLoss !== undefined ? { stopPrice: order.stopLoss } : {}),
      ...(order.takeProfit !== undefined ? { takeProfitPrice: order.takeProfit } : {}),
      openedAt: at,
      clientOrderId: order.clientOrderId,
    };
    this.positions.set(p.positionId, p);
    this.positionByOrder.set(order.venueOrderId, p.positionId);
    this.emit({ type: 'position', at, position: this.toBrokerPosition(p) });
  }

  private reducePosition(
    p: SimPosition,
    qty: Dec,
    price: Dec,
    spec: InstrumentSpec,
    at: number,
  ): void {
    const move =
      p.side === 'buy' ? D.Decimal.sub(price, p.entryPrice) : D.Decimal.sub(p.entryPrice, price);
    const pnl = D.Decimal.rescale(
      D.Decimal.mul(D.Decimal.mul(move, spec.contractSize), qty),
      2,
      'half-even',
    );
    this.balance = D.Decimal.add(this.balance, pnl);
    p.volume = D.Decimal.sub(p.volume, qty);
    if (D.Decimal.lte(p.volume, D.Decimal.ZERO)) {
      this.positions.delete(p.positionId);
      for (const [orderId, positionId] of this.positionByOrder) {
        if (positionId === p.positionId) this.positionByOrder.delete(orderId);
      }
      this.closedPositionIds.add(p.positionId);
      this.emit({
        type: 'positionClosed',
        at,
        positionId: p.positionId,
        exitPrice: price,
        netPnl: pnl,
        costs: D.dec('0.00'),
      });
    } else {
      this.emit({ type: 'position', at, position: this.toBrokerPosition(p) });
    }
    this.emit({ type: 'account', at, account: this.accountNow() });
  }

  // --- Amendments ----------------------------------------------------------

  async cancelOrder(venueOrderId: string, _clientOrderId: string): Promise<BrokerSubmitResult> {
    await this.clock.sleep(this.rng.latencyMs(this.cfg.medianLatencyMs));
    const at = this.clock.now();
    if (!this.connected) return { outcome: 'ambiguous', reason: 'not connected', at };
    const order = this.orders.get(venueOrderId);
    if (order === undefined)
      return { outcome: 'rejected', reason: 'unknown order', code: 'NO_ORDER', at };
    if (order.state === 'FILLED') {
      return { outcome: 'rejected', reason: 'order already filled', code: 'TOO_LATE', at };
    }
    order.state = 'CANCELLED';
    order.pendingPieces = [];
    this.emit({ type: 'order', at, order: this.toBrokerOrder(order) });
    return { outcome: 'acked', venueOrderId, state: 'CANCELLED', filledQty: order.filledQty, at };
  }

  async modifyPosition(
    positionId: string,
    stopLoss: Dec | undefined,
    takeProfit: Dec | undefined,
  ): Promise<BrokerSubmitResult> {
    await this.clock.sleep(this.rng.latencyMs(this.cfg.medianLatencyMs));
    const at = this.clock.now();
    if (!this.connected) return { outcome: 'ambiguous', reason: 'not connected', at };
    const p = this.positions.get(positionId);
    if (p === undefined)
      return { outcome: 'rejected', reason: 'unknown position', code: 'NO_POSITION', at };
    const spec = this.specs.get(p.canonical);
    const quote = this.quotes.get(p.canonical);
    if (spec !== undefined && quote !== undefined && stopLoss !== undefined) {
      const market = p.side === 'buy' ? quote.bid : quote.ask;
      if (D.insideFreezeLevel(spec, market, stopLoss)) {
        return {
          outcome: 'rejected',
          reason: 'price is inside the freeze level',
          code: 'FROZEN',
          at,
        };
      }
      if (!D.respectsStopsLevel(spec, market, stopLoss)) {
        return {
          outcome: 'rejected',
          reason: 'stop is inside the minimum distance',
          code: 'INVALID_STOPS',
          at,
        };
      }
    }
    if (stopLoss !== undefined) p.stopPrice = stopLoss;
    if (takeProfit !== undefined) p.takeProfitPrice = takeProfit;
    this.emit({ type: 'position', at, position: this.toBrokerPosition(p) });
    return { outcome: 'acked', venueOrderId: positionId, state: 'FILLED', filledQty: p.volume, at };
  }

  async closePosition(
    positionId: string,
    volume: Dec | undefined,
    _clientOrderId: string,
  ): Promise<BrokerSubmitResult> {
    await this.clock.sleep(this.rng.latencyMs(this.cfg.medianLatencyMs));
    const at = this.clock.now();
    if (!this.connected) return { outcome: 'ambiguous', reason: 'not connected', at };
    const p = this.positions.get(positionId);
    if (p === undefined) {
      return { outcome: 'rejected', reason: 'unknown position', code: 'NO_POSITION', at };
    }
    const spec = this.specs.get(p.canonical);
    const quote = this.quotes.get(p.canonical);
    if (spec === undefined || quote === undefined) {
      return { outcome: 'rejected', reason: 'no price to close against', code: 'OFF_QUOTES', at };
    }
    const qty = volume ?? p.volume;
    const price = p.side === 'buy' ? quote.bid : quote.ask;
    this.reducePosition(p, D.Decimal.min(qty, p.volume), price, spec, at);
    return { outcome: 'acked', venueOrderId: positionId, state: 'FILLED', filledQty: qty, at };
  }

  async findByClientOrderId(clientOrderId: string): Promise<LookupResult> {
    await this.clock.sleep(this.rng.latencyMs(this.cfg.medianLatencyMs));
    if (!this.connected) {
      return { found: 'indeterminate', reason: 'not connected; absence cannot be established' };
    }
    const id = this.byClientId.get(clientOrderId);
    if (id === undefined) {
      return { found: false, evidence: `client order id ${clientOrderId} not present at venue` };
    }
    const order = this.orders.get(id);
    if (order === undefined) {
      return { found: false, evidence: `client order id ${clientOrderId} not present at venue` };
    }
    return { found: true, order: this.toBrokerOrder(order) };
  }

  // --- Simulation driver ---------------------------------------------------

  /**
   * Advance the venue: trigger stops and targets, and maybe drop the connection.
   * The engine's market-data loop calls this after each quote update.
   */
  tick(): void {
    if (this.connected && this.rng.chance(this.cfg.faults.disconnectRate)) {
      this.forceDisconnect('simulated network interruption');
      return;
    }
    if (!this.connected) return;
    const at = this.clock.now();
    for (const p of [...this.positions.values()]) {
      const q = this.quotes.get(p.canonical);
      const spec = this.specs.get(p.canonical);
      if (q === undefined || spec === undefined) continue;
      const mark = p.side === 'buy' ? q.bid : q.ask;
      const hitStop =
        p.stopPrice !== undefined &&
        (p.side === 'buy' ? D.Decimal.lte(mark, p.stopPrice) : D.Decimal.gte(mark, p.stopPrice));
      const hitTarget =
        p.takeProfitPrice !== undefined &&
        (p.side === 'buy'
          ? D.Decimal.gte(mark, p.takeProfitPrice)
          : D.Decimal.lte(mark, p.takeProfitPrice));
      if (hitStop || hitTarget) {
        // Stops fill at the trigger plus slippage, not at the trigger. Modelling
        // them as exact is the single biggest lie a paper simulator can tell.
        const trigger = hitStop ? (p.stopPrice as Dec) : (p.takeProfitPrice as Dec);
        const fill = hitStop
          ? this.withSlippage(trigger, spec, p.side === 'buy' ? 'sell' : 'buy')
          : trigger;
        this.reducePosition(p, p.volume, fill, spec, at);
      }
    }
  }

  // --- Helpers -------------------------------------------------------------

  private assertConnected(): void {
    if (!this.connected) throw new Error('paper broker: not connected');
  }

  private toBrokerOrder(o: SimOrder): BrokerOrder {
    return {
      venueOrderId: o.venueOrderId,
      clientOrderId: o.clientOrderId,
      canonical: o.canonical,
      symbol: o.symbol,
      side: o.side,
      state: o.state,
      requestedQty: o.requestedQty,
      filledQty: o.filledQty,
      ...(o.limitPrice !== undefined ? { limitPrice: o.limitPrice } : {}),
      ...(o.stopTriggerPrice !== undefined ? { stopPrice: o.stopTriggerPrice } : {}),
      ...(o.avgFillPrice !== undefined ? { avgFillPrice: o.avgFillPrice } : {}),
      createdAt: o.createdAt,
    };
  }

  private toBrokerPosition(p: SimPosition): BrokerPosition {
    return {
      positionId: p.positionId,
      canonical: p.canonical,
      symbol: p.symbol,
      side: p.side,
      volume: p.volume,
      entryPrice: p.entryPrice,
      ...(p.stopPrice !== undefined ? { stopPrice: p.stopPrice } : {}),
      ...(p.takeProfitPrice !== undefined ? { takeProfitPrice: p.takeProfitPrice } : {}),
      unrealisedPnl: D.Decimal.rescale(this.pnlOf(p), 2, 'half-even'),
      openedAt: p.openedAt,
      ...(p.clientOrderId !== undefined ? { clientOrderId: p.clientOrderId } : {}),
    };
  }
}
