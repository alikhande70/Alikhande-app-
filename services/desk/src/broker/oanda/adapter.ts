import type { Dec, InstrumentSpec } from '@keel/core';
import * as D from '@keel/core';
import type { Logger } from 'pino';
import type { Clock } from '../../sim/clock.js';
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
} from '../port.js';
import type { OandaClient, OandaResult } from './client.js';
import {
  orderStateFromOanda,
  parseOandaTime,
  specFromOanda,
  toCanonical,
  unitsForOrder,
  volumeFromUnits,
} from './mapping.js';
import type { StreamChunkSource } from './stream.js';
import { OandaStreams } from './stream.js';
import type {
  OandaAccountSummary,
  OandaClientPrice,
  OandaInstrumentList,
  OandaOrder,
  OandaOrderResponse,
  OandaTrade,
  OandaTransaction,
} from './types.js';

/**
 * OANDA v20 adapter.
 *
 * Two properties of v20 shape this design more than anything else.
 *
 * **Client ids are native and addressable.** `clientExtensions.id` survives the
 * round trip, and both orders and trades can be fetched by it with an `@`
 * prefix. That is exactly the primitive an ambiguous send needs, so this
 * adapter can honestly declare `findByClientOrderId: true` — and the engine is
 * therefore allowed to retry.
 *
 * **The id migrates from the order to the trade on fill.** A market order that
 * fills immediately may no longer be addressable as an order, while the trade it
 * opened carries the same id. So the adapter sets `clientExtensions` *and*
 * `tradeClientExtensions` to the same value and looks in both places before
 * concluding anything is absent. Checking only orders would report a filled
 * position as "never existed" — the worst answer this system can give.
 */

/** OANDA publishes 120 requests/second per account; this is well inside it. */
const MAX_ORDERS_PER_SECOND = 10;

const BASE_CAPABILITIES: BrokerCapabilities = {
  clientOrderId: 'native',
  findByClientOrderId: true,
  streamsFills: true,
  atomicStopLoss: true,
  // A market order sent IOC can fill partially; FOK cannot. Both are reachable
  // from `timeInForce`, so the adapter must be able to handle a partial.
  partialFills: true,
  supportsPartialClose: true,
  serverTimeSource: 'broker',
  // Corrected at connect from the account's own `hedgingEnabled`.
  positionModel: 'netting',
  maxOrdersPerSecond: MAX_ORDERS_PER_SECOND,
};

/**
 * Order types that represent something the operator asked for.
 *
 * OANDA returns protective stops and take-profits as first-class pending
 * orders. They are already surfaced on the position they protect, so listing
 * them again as open orders would double-count every protected position and
 * make the reconciler report divergences against intents that never existed.
 */
const ENTRY_ORDER_TYPES = new Set(['MARKET', 'LIMIT', 'STOP', 'MARKET_IF_TOUCHED']);

export interface OandaBrokerOptions {
  readonly client: OandaClient;
  readonly clock: Clock;
  readonly log: Logger;
  /** Instruments to stream prices for. Everything else is fetched on demand. */
  readonly instruments?: readonly string[];
  /** Injected in tests so the stream paths run without a network. */
  readonly streamSource?: StreamChunkSource;
}

export class OandaBroker implements BrokerPort {
  readonly name: string;

  private caps: BrokerCapabilities = BASE_CAPABILITIES;
  private readonly handlers = new Set<BrokerEventHandler>();
  private readonly specs = new Map<string, InstrumentSpec>();
  /** canonical -> OANDA's spelling, so we never guess where to split a pair. */
  private readonly venueNames = new Map<string, string>();
  private connected = false;
  private streams: OandaStreams | undefined;

  constructor(private readonly opts: OandaBrokerOptions) {
    this.name = `oanda:${opts.client.environment}`;
  }

  get capabilities(): BrokerCapabilities {
    return this.caps;
  }

  isConnected(): boolean {
    return this.connected;
  }

  on(handler: BrokerEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(e: BrokerEvent): void {
    for (const h of this.handlers) h(e);
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * Connect by proving the account is reachable, not by assuming it.
   *
   * The summary call does three jobs: it validates the token and account id
   * together, it tells us whether the account nets or hedges, and it gives the
   * `lastTransactionID` the transaction stream resumes from. A failure here is
   * a hard failure — starting a trading desk against an account we could not
   * read is how a session begins with a wrong position model.
   */
  async connect(): Promise<void> {
    const summary = await this.opts.client.get<{ account: OandaAccountSummary }>(
      this.opts.client.accountPath('/summary'),
    );
    if (!summary.ok) {
      throw new Error(`OANDA connect failed: ${describeFailure(summary)}`);
    }

    const account = summary.data.account;
    const hedging = account.hedgingEnabled === true;
    this.caps = { ...BASE_CAPABILITIES, positionModel: hedging ? 'hedging' : 'netting' };

    await this.loadInstruments();

    this.connected = true;
    this.emit({ type: 'connected', at: this.opts.clock.now() });
    this.opts.log.info(
      {
        account: account.id,
        currency: account.currency,
        positionModel: this.caps.positionModel,
        instruments: this.specs.size,
      },
      'oanda connected',
    );

    this.streams = new OandaStreams({
      client: this.opts.client,
      clock: this.opts.clock,
      log: this.opts.log,
      instruments: this.streamableNames(),
      ...(account.lastTransactionID === undefined
        ? {}
        : { lastTransactionId: account.lastTransactionID }),
      onTransaction: (tx) => this.onTransaction(tx),
      onPrice: (price) => this.onPrice(price),
      onDisconnected: (reason) => {
        this.connected = false;
        this.emit({ type: 'disconnected', reason, at: this.opts.clock.now() });
      },
      onReconnected: () => {
        this.connected = true;
        this.emit({ type: 'connected', at: this.opts.clock.now() });
      },
      ...(this.opts.streamSource === undefined ? {} : { source: this.opts.streamSource }),
    });
    this.streams.start();
  }

  async disconnect(): Promise<void> {
    this.streams?.stop();
    this.streams = undefined;
    this.connected = false;
    this.emit({ type: 'disconnected', reason: 'client disconnected', at: this.opts.clock.now() });
  }

  private streamableNames(): readonly string[] {
    const wanted = this.opts.instruments;
    if (wanted === undefined) return [...this.venueNames.values()];
    const names: string[] = [];
    for (const canonical of wanted) {
      const name = this.venueNames.get(canonical);
      if (name === undefined) {
        this.opts.log.warn(
          { canonical },
          'instrument is configured but the account cannot trade it; not streaming it',
        );
        continue;
      }
      names.push(name);
    }
    return names;
  }

  // --- Reference data --------------------------------------------------------

  private async loadInstruments(): Promise<void> {
    const res = await this.opts.client.get<OandaInstrumentList>(
      this.opts.client.accountPath('/instruments'),
    );
    if (!res.ok) throw new Error(`could not load OANDA instruments: ${describeFailure(res)}`);

    const at = this.opts.clock.now();
    for (const inst of res.data.instruments) {
      try {
        const spec = { ...specFromOanda(inst, at), positionModel: this.caps.positionModel };
        this.specs.set(spec.canonical, spec);
        this.venueNames.set(spec.canonical, inst.name);
      } catch (err) {
        // One unparseable instrument must not stop the desk from trading the
        // rest. It is skipped loudly: sizing on it would have to be refused
        // anyway, and refusing at size time with no explanation is worse.
        this.opts.log.warn(
          { instrument: inst.name, reason: err instanceof Error ? err.message : String(err) },
          'skipping instrument whose specification could not be mapped',
        );
      }
    }
  }

  async getInstruments(): Promise<readonly InstrumentSpec[]> {
    if (this.specs.size === 0) await this.loadInstruments();
    return [...this.specs.values()];
  }

  async getAccount(): Promise<BrokerAccount> {
    const res = await this.opts.client.get<{ account: OandaAccountSummary }>(
      this.opts.client.accountPath('/summary'),
    );
    if (!res.ok) throw new Error(`could not read the OANDA account: ${describeFailure(res)}`);
    const a = res.data.account;
    return {
      currency: a.currency,
      balance: D.dec(a.balance),
      // NAV is OANDA's equity: balance plus unrealised P&L.
      equity: D.dec(a.NAV),
      marginUsed: D.dec(a.marginUsed),
      marginFree: D.dec(a.marginAvailable),
      // The summary carries no server timestamp, so this one is stamped on
      // arrival. Execution and price times below are the venue's own.
      asOf: this.opts.clock.now(),
    };
  }

  async getQuote(canonical: string): Promise<BrokerQuote | undefined> {
    const name = this.venueNames.get(canonical);
    if (name === undefined) return undefined;
    const res = await this.opts.client.get<{ prices: readonly OandaClientPrice[] }>(
      `${this.opts.client.accountPath('/pricing')}?instruments=${encodeURIComponent(name)}`,
    );
    if (!res.ok) return undefined;
    const price = res.data.prices[0];
    return price === undefined ? undefined : this.toQuote(price);
  }

  private toQuote(price: OandaClientPrice): BrokerQuote | undefined {
    const bid = price.bids[0];
    const ask = price.asks[0];
    // A price with an empty book side is not a quote. Substituting the closeout
    // price would produce a spread the venue never showed.
    if (bid === undefined || ask === undefined) return undefined;
    return {
      canonical: toCanonical(price.instrument),
      bid: D.dec(bid.price),
      ask: D.dec(ask.price),
      asOf: parseOandaTime(price.time),
    };
  }

  // --- Positions and orders --------------------------------------------------

  /**
   * Open positions, modelled as OANDA *trades*.
   *
   * v20 has both a position (netted per instrument) and a trade (an individual
   * open parcel). Trades are used here because they are what can be closed
   * partially, protected individually, and addressed by client id — all three
   * of which this system needs. On a netting account there is normally one
   * trade per instrument, so the distinction rarely shows.
   */
  async getPositions(): Promise<readonly BrokerPosition[]> {
    const res = await this.opts.client.get<{ trades: readonly OandaTrade[] }>(
      this.opts.client.accountPath('/openTrades'),
    );
    if (!res.ok) throw new Error(`could not read OANDA positions: ${describeFailure(res)}`);
    return res.data.trades.map((t) => this.toPosition(t));
  }

  private toPosition(t: OandaTrade): BrokerPosition {
    const { volume, side } = volumeFromUnits(t.currentUnits);
    const stop = t.stopLossOrder?.price;
    const tp = t.takeProfitOrder?.price;
    const pnl = t.unrealizedPL;
    const clientId = t.clientExtensions?.id;
    return {
      positionId: t.id,
      canonical: toCanonical(t.instrument),
      symbol: t.instrument,
      side,
      volume,
      entryPrice: D.dec(t.price),
      openedAt: parseOandaTime(t.openTime),
      ...(stop === undefined ? {} : { stopPrice: D.dec(stop) }),
      ...(tp === undefined ? {} : { takeProfitPrice: D.dec(tp) }),
      ...(pnl === undefined ? {} : { unrealisedPnl: D.dec(pnl) }),
      ...(clientId === undefined ? {} : { clientOrderId: clientId }),
    };
  }

  async getOpenOrders(): Promise<readonly BrokerOrder[]> {
    const res = await this.opts.client.get<{ orders: readonly OandaOrder[] }>(
      this.opts.client.accountPath('/pendingOrders'),
    );
    if (!res.ok) throw new Error(`could not read OANDA orders: ${describeFailure(res)}`);
    return res.data.orders
      .filter((o) => ENTRY_ORDER_TYPES.has(o.type))
      .map((o) => this.toOrder(o))
      .filter((o): o is BrokerOrder => o !== undefined);
  }

  /**
   * Map a v20 order.
   *
   * Returns `undefined` for an order with no instrument or units — which in
   * practice means a dependent order that slipped through the type filter.
   * Inventing a zero volume for it would put a phantom order in the book.
   */
  private toOrder(o: OandaOrder): BrokerOrder | undefined {
    if (o.instrument === undefined || o.units === undefined) return undefined;
    const { volume, side } = volumeFromUnits(o.units);
    const filled =
      o.filledUnits === undefined ? D.Decimal.ZERO : D.Decimal.abs(D.dec(o.filledUnits));
    const clientId = o.clientExtensions?.id;
    const price = o.price;
    return {
      venueOrderId: o.id,
      canonical: toCanonical(o.instrument),
      symbol: o.instrument,
      side,
      state: orderStateFromOanda(o.state, filled, volume),
      requestedQty: volume,
      filledQty: filled,
      createdAt: parseOandaTime(o.createTime),
      ...(clientId === undefined ? {} : { clientOrderId: clientId }),
      ...(price === undefined
        ? {}
        : o.type === 'STOP'
          ? { stopPrice: D.dec(price) }
          : { limitPrice: D.dec(price) }),
    };
  }

  // --- Execution -------------------------------------------------------------

  async placeOrder(req: BrokerOrderRequest): Promise<BrokerSubmitResult> {
    const at = () => this.opts.clock.now();
    const name = this.venueNames.get(req.canonical);
    if (name === undefined) {
      return {
        outcome: 'rejected',
        reason: `${req.canonical} is not tradeable on this OANDA account`,
        code: 'UNKNOWN_INSTRUMENT',
        at: at(),
      };
    }

    let units: string;
    try {
      units = unitsForOrder(req.volume, req.side);
    } catch (err) {
      // A volume we cannot express is refused locally, before the network.
      // Nothing was sent, so this is unambiguously a rejection.
      return {
        outcome: 'rejected',
        reason: err instanceof Error ? err.message : String(err),
        code: 'INVALID_VOLUME',
        at: at(),
      };
    }

    const order: Record<string, unknown> = {
      type: oandaOrderType(req.kind),
      instrument: name,
      units,
      timeInForce: req.timeInForce,
      positionFill: 'DEFAULT',
      // The same id on both. On fill the order may cease to be addressable
      // while the trade takes the id over; recovery needs to find either.
      clientExtensions: { id: req.clientOrderId },
      tradeClientExtensions: { id: req.clientOrderId },
    };

    if (req.kind === 'limit' && req.limitPrice !== undefined) {
      order.price = D.Decimal.toString(req.limitPrice);
    }
    if ((req.kind === 'stop' || req.kind === 'stop_limit') && req.stopTriggerPrice !== undefined) {
      order.price = D.Decimal.toString(req.stopTriggerPrice);
    }
    if (req.stopLoss !== undefined) {
      // Attached to the fill, so the position is never briefly naked. This is
      // what lets the adapter declare atomicStopLoss: true.
      order.stopLossOnFill = { price: D.Decimal.toString(req.stopLoss), timeInForce: 'GTC' };
    }
    if (req.takeProfit !== undefined) {
      order.takeProfitOnFill = { price: D.Decimal.toString(req.takeProfit), timeInForce: 'GTC' };
    }
    if (req.maxSlippage !== undefined && req.kind === 'market') {
      order.priceBound = D.Decimal.toString(req.maxSlippage);
    }

    const res = await this.opts.client.post<OandaOrderResponse>(
      this.opts.client.accountPath('/orders'),
      { order },
    );

    return this.interpretOrderResponse(res, at());
  }

  /**
   * Turn a v20 order response into one of the three outcomes.
   *
   * The order of these checks is the whole safety argument, so it is worth
   * stating: a fill is inspected *before* a cancellation, because an IOC order
   * that fills part of its size and cancels the rest returns both, and reading
   * the cancel first would report a real, live position as a rejection.
   */
  private interpretOrderResponse(
    res: OandaResult<OandaOrderResponse>,
    fallbackAt: number,
  ): BrokerSubmitResult {
    if (!res.ok) {
      if (res.certainty === 'indeterminate') {
        return { outcome: 'ambiguous', reason: res.reason, at: fallbackAt };
      }
      const rejectTx = res.data as OandaOrderResponse | undefined;
      const reason =
        rejectTx?.orderRejectTransaction?.rejectReason ?? res.errorMessage ?? 'rejected by OANDA';
      const code = res.errorCode ?? rejectTx?.orderRejectTransaction?.rejectReason;
      return {
        outcome: 'rejected',
        reason,
        at: fallbackAt,
        ...(code === undefined ? {} : { code }),
      };
    }

    const body = res.data;
    const fill = body.orderFillTransaction;
    const create = body.orderCreateTransaction;
    const cancel = body.orderCancelTransaction;
    const venueOrderId = create?.id ?? fill?.orderID;

    if (fill !== undefined) {
      const filled = fill.units === undefined ? D.Decimal.ZERO : D.Decimal.abs(D.dec(fill.units));
      const requested = create?.units === undefined ? filled : D.Decimal.abs(D.dec(create.units));
      // Both a fill and a cancel means an IOC order that took what liquidity
      // there was. That is a partial fill, not a rejection.
      const state =
        cancel !== undefined && D.Decimal.lt(filled, requested) ? 'PARTIALLY_FILLED' : 'FILLED';
      const price = fill.price;
      return {
        outcome: 'acked',
        venueOrderId: venueOrderId ?? fill.id,
        state,
        filledQty: filled,
        at: safeTime(fill.time, fallbackAt),
        ...(price === undefined ? {} : { avgFillPrice: D.dec(price) }),
        ...(cancel?.reason === undefined ? {} : { venueStatus: cancel.reason }),
      };
    }

    if (cancel !== undefined) {
      // Created then immediately cancelled with nothing filled: the venue
      // considered it and declined. A definite negative — most often a FOK
      // market order that could not be filled in full.
      return {
        outcome: 'rejected',
        reason: `OANDA cancelled the order on submission: ${cancel.reason ?? 'no reason given'}`,
        at: safeTime(cancel.time, fallbackAt),
        ...(cancel.reason === undefined ? {} : { code: cancel.reason }),
      };
    }

    if (create !== undefined && venueOrderId !== undefined) {
      return {
        outcome: 'acked',
        venueOrderId,
        state: 'WORKING',
        filledQty: D.Decimal.ZERO,
        at: safeTime(create.time, fallbackAt),
      };
    }

    // A 2xx we cannot interpret. The order may exist; only the venue knows.
    return {
      outcome: 'ambiguous',
      reason:
        'OANDA returned success but the response contained no create, fill or cancel transaction, ' +
        'so whether the order exists cannot be read from it',
      at: fallbackAt,
    };
  }

  async cancelOrder(venueOrderId: string, clientOrderId: string): Promise<BrokerSubmitResult> {
    const at = this.opts.clock.now();
    const specifier =
      venueOrderId === '' ? clientSpecifier(clientOrderId) : encodeURIComponent(venueOrderId);
    const res = await this.opts.client.put<OandaOrderResponse>(
      `${this.opts.client.accountPath(`/orders/${specifier}`)}/cancel`,
    );

    if (!res.ok) {
      if (res.certainty === 'indeterminate') {
        return { outcome: 'ambiguous', reason: res.reason, at };
      }
      return {
        outcome: 'rejected',
        reason: res.errorMessage,
        at,
        ...(res.errorCode === undefined ? {} : { code: res.errorCode }),
      };
    }

    const cancel = res.data.orderCancelTransaction;
    return {
      outcome: 'acked',
      venueOrderId: cancel?.orderID ?? venueOrderId,
      state: 'CANCELLED',
      filledQty: D.Decimal.ZERO,
      at: safeTime(cancel?.time, at),
    };
  }

  async modifyPosition(
    positionId: string,
    stopLoss: Dec | undefined,
    takeProfit: Dec | undefined,
  ): Promise<BrokerSubmitResult> {
    const at = this.opts.clock.now();
    // `undefined` means "leave this one alone", matching every other adapter.
    // Omitting the key does that; sending null would remove the protection.
    const body: Record<string, unknown> = {};
    if (stopLoss !== undefined) {
      body.stopLoss = { price: D.Decimal.toString(stopLoss), timeInForce: 'GTC' };
    }
    if (takeProfit !== undefined) {
      body.takeProfit = { price: D.Decimal.toString(takeProfit), timeInForce: 'GTC' };
    }
    if (Object.keys(body).length === 0) {
      return {
        outcome: 'rejected',
        reason: 'neither a stop nor a take profit was supplied, so there is nothing to modify',
        code: 'NO_CHANGE',
        at,
      };
    }

    const res = await this.opts.client.put<Record<string, unknown>>(
      `${this.opts.client.accountPath(`/trades/${encodeURIComponent(positionId)}`)}/orders`,
      body,
    );

    if (!res.ok) {
      return res.certainty === 'indeterminate'
        ? { outcome: 'ambiguous', reason: res.reason, at }
        : {
            outcome: 'rejected',
            reason: res.errorMessage,
            at,
            ...(res.errorCode === undefined ? {} : { code: res.errorCode }),
          };
    }

    return {
      outcome: 'acked',
      venueOrderId: positionId,
      state: 'FILLED',
      filledQty: D.Decimal.ZERO,
      at,
    };
  }

  async closePosition(
    positionId: string,
    volume: Dec | undefined,
    _clientOrderId: string,
  ): Promise<BrokerSubmitResult> {
    const at = this.opts.clock.now();
    // "ALL" rather than a computed unit count when closing in full: it closes
    // whatever is actually open, which is the right thing if the position moved
    // between our read and this write.
    const units = volume === undefined ? 'ALL' : D.Decimal.toString(D.Decimal.abs(volume));
    const res = await this.opts.client.put<OandaOrderResponse>(
      `${this.opts.client.accountPath(`/trades/${encodeURIComponent(positionId)}`)}/close`,
      { units },
    );
    return this.interpretOrderResponse(res, at);
  }

  // --- Recovery --------------------------------------------------------------

  /**
   * Locate an order by our client id, looking in both places it can live.
   *
   * The distinction between "the venue searched and does not have it" and "we
   * could not get an answer" is the entire value of this method, so a lookup
   * that fails for any reason other than a clean 404 returns `indeterminate`.
   * The resolver requires repeated, separated negatives on a healthy connection
   * before it will conclude absence, and this is the evidence it reasons over.
   */
  async findByClientOrderId(clientOrderId: string): Promise<LookupResult> {
    const specifier = clientSpecifier(clientOrderId);

    const orderRes = await this.opts.client.get<{ order: OandaOrder }>(
      this.opts.client.accountPath(`/orders/${specifier}`),
    );
    if (orderRes.ok) {
      const mapped = this.toOrder(orderRes.data.order);
      if (mapped !== undefined) return { found: true, order: mapped };
      // The venue returned the order and we could not map it. That is our
      // problem, not evidence of anything: the order demonstrably exists.
      return {
        found: 'indeterminate',
        reason:
          `OANDA returned an order for ${specifier} that could not be mapped (no instrument or ` +
          'units). The order exists; its shape is unreadable.',
      };
    }
    const orderAbsent = absenceOrReason(orderRes, `/orders/${specifier}`);
    if (orderAbsent !== true) return orderAbsent;

    // Not addressable as an order. On a filled market order the id has moved to
    // the trade, so absence here is not absence.
    const tradeRes = await this.opts.client.get<{ trade: OandaTrade }>(
      this.opts.client.accountPath(`/trades/${specifier}`),
    );
    if (tradeRes.ok) {
      return { found: true, order: this.orderFromTrade(tradeRes.data.trade, clientOrderId) };
    }
    const tradeAbsent = absenceOrReason(tradeRes, `/trades/${specifier}`);
    if (tradeAbsent !== true) return tradeAbsent;

    return {
      found: false,
      evidence:
        `OANDA returned 404 for both /orders/${specifier} and /trades/${specifier} on account ` +
        `${this.opts.client.accountId}; the id is not present as either.`,
    };
  }

  /**
   * Represent a trade as the order that created it.
   *
   * `initialUnits`, not `currentUnits`: the question being answered is "did our
   * order execute", and a position since reduced still executed in full.
   */
  private orderFromTrade(t: OandaTrade, clientOrderId: string): BrokerOrder {
    const { volume, side } = volumeFromUnits(t.initialUnits);
    return {
      venueOrderId: t.id,
      clientOrderId,
      canonical: toCanonical(t.instrument),
      symbol: t.instrument,
      side,
      state: 'FILLED',
      requestedQty: volume,
      filledQty: volume,
      avgFillPrice: D.dec(t.price),
      createdAt: parseOandaTime(t.openTime),
    };
  }

  // --- Stream handling -------------------------------------------------------

  private onTransaction(tx: OandaTransaction): void {
    if (tx.type !== 'ORDER_FILL') return;
    if (tx.units === undefined || tx.price === undefined || tx.orderID === undefined) {
      this.opts.log.warn({ id: tx.id }, 'ORDER_FILL without units, price or orderID; not emitting');
      return;
    }
    const clientId = tx.clientExtensions?.id;
    this.emit({
      type: 'fill',
      at: parseOandaTime(tx.time),
      // The transaction id is unique per fill, which is exactly the dedupe key
      // the order state machine needs to refuse a fill it has already applied.
      fillId: tx.id,
      venueOrderId: tx.orderID,
      qty: D.Decimal.abs(D.dec(tx.units)),
      price: D.dec(tx.price),
      ...(clientId === undefined ? {} : { clientOrderId: clientId }),
    });
  }

  private onPrice(price: OandaClientPrice): void {
    const quote = this.toQuote(price);
    if (quote === undefined) return;
    this.emit({ type: 'quote', at: quote.asOf, quote });
  }
}

// --- Helpers -----------------------------------------------------------------

/**
 * Address a resource by client id.
 *
 * The `@` must stay literal — it is a legal path character and OANDA matches on
 * it directly — while the id itself is encoded in case it ever contains
 * something that would change the path's shape.
 */
/**
 * Decide whether a failed lookup is evidence of absence.
 *
 * Only a 404 is. Every other definite status — a 401 from a rotated token, a
 * 403 from an account that lost permission, a 400 from a malformed specifier —
 * says something about our request, not about whether the order exists. Reading
 * any of them as absence would be catastrophic in exactly the situation the
 * lookup exists for: a revoked token would report every in-flight order as
 * never placed, and the engine would be free to re-send all of them.
 *
 * Returns `true` when the resource is genuinely absent, or the LookupResult to
 * return instead.
 */
function absenceOrReason(
  res: Extract<OandaResult<unknown>, { ok: false }>,
  path: string,
): true | LookupResult {
  if (res.certainty === 'indeterminate') {
    return { found: 'indeterminate', reason: res.reason };
  }
  if (res.status === 404) return true;
  return {
    found: 'indeterminate',
    reason:
      `GET ${path} returned HTTP ${res.status} (${res.errorMessage}). That is not a 404, so it ` +
      'is not evidence that the id is absent.',
  };
}

function clientSpecifier(clientOrderId: string): string {
  return `@${encodeURIComponent(clientOrderId)}`;
}

function oandaOrderType(kind: BrokerOrderRequest['kind']): string {
  switch (kind) {
    case 'market':
      return 'MARKET';
    case 'limit':
      return 'LIMIT';
    default:
      // v20 has no distinct stop-limit; a STOP order with a price bound is the
      // closest equivalent and is what `stop_limit` maps onto.
      return 'STOP';
  }
}

/**
 * Use the venue's timestamp when it gave one we can read, and the local clock
 * only as a last resort — never silently. An unreadable venue time is logged by
 * the mapping layer's error path everywhere it matters; here the fallback keeps
 * a fill from being dropped entirely over a timestamp.
 */
function safeTime(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? fallback : ms;
}

function describeFailure(res: Extract<OandaResult<unknown>, { ok: false }>): string {
  return res.certainty === 'indeterminate'
    ? res.reason
    : `HTTP ${res.status}: ${res.errorMessage}${res.errorCode === undefined ? '' : ` (${res.errorCode})`}`;
}
