import type { Dec, InstrumentSpec, OrderState } from '@keel/core';
import * as D from '@keel/core';
import type {
  BrokerAccount,
  BrokerCapabilities,
  BrokerEventHandler,
  BrokerLookupContext,
  BrokerOrder,
  BrokerOrderRequest,
  BrokerPort,
  BrokerPosition,
  BrokerQuote,
  BrokerSubmitResult,
  LookupResult,
} from '../port.js';
import { type Mt5HostClient, Mt5HostError } from './host-client.js';
import type {
  Mt5HostAccount,
  Mt5HostInstrument,
  Mt5HostOrder,
  Mt5HostPosition,
  Mt5HostSnapshot,
  Mt5HostSubmitResult,
} from './host-types.js';
import { magicForClientOrderId, magicToWire } from './identity.js';
import { inspectMt5Observation } from './observation.js';

export class Mt5AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mt5AdapterError';
  }
}

export interface Mt5AdapterOptions {
  readonly client: Mt5HostClient;
  /** Installation-specific high bits reserved by ADR-0015. */
  readonly systemPrefix: number;
  /**
   * Demo is the only mode enabled by default. Contest/real must be named
   * explicitly, and real additionally requires allowRealTrading=true.
   */
  readonly allowedTradeModes?: readonly Mt5HostAccount['tradeMode'][];
  readonly allowRealTrading?: boolean;
}

function mapOrderState(state: Mt5HostOrder['state']): OrderState {
  switch (state) {
    case 'PENDING_SUBMIT':
      return 'SUBMITTED';
    case 'WORKING':
      return 'WORKING';
    case 'PARTIAL':
      return 'PARTIALLY_FILLED';
    case 'FILLED':
      return 'FILLED';
    case 'CANCEL_PENDING':
      return 'CANCEL_REQUESTED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'REJECTED':
      return 'REJECTED';
    case 'UNKNOWN':
      return 'UNKNOWN';
  }
}

function mapInstrument(
  raw: Mt5HostInstrument,
  positionModel: 'netting' | 'hedging',
): InstrumentSpec {
  return {
    symbol: raw.symbol,
    canonical: raw.canonical,
    assetClass: raw.assetClass,
    base: raw.base,
    quote: raw.quote,
    digits: raw.digits,
    tickSize: D.dec(raw.tickSize),
    contractSize: D.dec(raw.contractSize),
    minVolume: D.dec(raw.minVolume),
    maxVolume: D.dec(raw.maxVolume),
    volumeStep: D.dec(raw.volumeStep),
    ...(raw.tickValueAccount === undefined
      ? {}
      : { tickValueAccount: D.dec(raw.tickValueAccount) }),
    stopsLevel: D.dec(raw.stopsLevel),
    freezeLevel: D.dec(raw.freezeLevel),
    marginRate: D.dec(raw.marginRate),
    positionModel,
    venueTimeZone: raw.venueTimeZone,
    asOf: raw.asOf,
  };
}

function mapAccount(raw: Mt5HostAccount): BrokerAccount {
  return {
    currency: raw.currency,
    balance: D.dec(raw.balance),
    equity: D.dec(raw.equity),
    marginUsed: D.dec(raw.marginUsed),
    marginFree: D.dec(raw.marginFree),
    asOf: raw.asOf,
  };
}

function mapPosition(raw: Mt5HostPosition): BrokerPosition {
  return {
    positionId: raw.positionId,
    canonical: raw.canonical,
    symbol: raw.symbol,
    side: raw.side,
    volume: D.dec(raw.volume),
    entryPrice: D.dec(raw.entryPrice),
    ...(raw.stopPrice === undefined ? {} : { stopPrice: D.dec(raw.stopPrice) }),
    ...(raw.takeProfitPrice === undefined
      ? {}
      : { takeProfitPrice: D.dec(raw.takeProfitPrice) }),
    ...(raw.unrealisedPnl === undefined
      ? {}
      : { unrealisedPnl: D.dec(raw.unrealisedPnl) }),
    openedAt: raw.openedAt,
  };
}

function mapOrder(raw: Mt5HostOrder, clientOrderId?: string): BrokerOrder {
  return {
    venueOrderId: raw.ticket,
    ...(clientOrderId === undefined ? {} : { clientOrderId }),
    canonical: raw.canonical,
    symbol: raw.symbol,
    side: raw.side,
    state: mapOrderState(raw.state),
    requestedQty: D.dec(raw.requestedQty),
    filledQty: D.dec(raw.filledQty),
    ...(raw.limitPrice === undefined ? {} : { limitPrice: D.dec(raw.limitPrice) }),
    ...(raw.stopPrice === undefined ? {} : { stopPrice: D.dec(raw.stopPrice) }),
    ...(raw.avgFillPrice === undefined
      ? {}
      : { avgFillPrice: D.dec(raw.avgFillPrice) }),
    createdAt: raw.createdAt,
  };
}

function mapQuote(raw: Mt5HostSnapshot['quotes'][number]): BrokerQuote {
  return {
    canonical: raw.canonical,
    bid: D.dec(raw.bid),
    ask: D.dec(raw.ask),
    asOf: raw.asOf,
  };
}

function venueId(
  result: Extract<Mt5HostSubmitResult, { outcome: 'acked' }>,
): string | undefined {
  return result.orderTicket ?? result.dealTicket;
}

function mapSubmit(result: Mt5HostSubmitResult): BrokerSubmitResult {
  switch (result.outcome) {
    case 'rejected':
      return {
        outcome: 'rejected',
        reason: result.reason,
        ...(result.retcode === undefined ? {} : { code: String(result.retcode) }),
        at: result.serverTime,
      };
    case 'ambiguous':
      return { outcome: 'ambiguous', reason: result.reason, at: result.serverTime };
    case 'acked': {
      const id = venueId(result);
      if (id === undefined) {
        return {
          outcome: 'ambiguous',
          reason:
            `MT5 host returned ${result.retcodeName} without an order or deal ticket; ` +
            'venue execution cannot be durably identified',
          at: result.serverTime,
        };
      }
      return {
        outcome: 'acked',
        venueOrderId: id,
        state: mapOrderState(result.state),
        filledQty: D.dec(result.filledQty),
        ...(result.avgFillPrice === undefined
          ? {}
          : { avgFillPrice: D.dec(result.avgFillPrice) }),
        at: result.serverTime,
        venueStatus: result.retcodeName,
      };
    }
  }
}

/**
 * BrokerPort implementation for the Windows MT5 execution host.
 *
 * It is intentionally polling-first. MT5 transaction events are hints; snapshot
 * and history reconciliation remain authoritative per ADR-0015.
 */
export class Mt5BrokerAdapter implements BrokerPort {
  readonly name = 'mt5';
  private readonly client: Mt5HostClient;
  private readonly systemPrefix: number;
  private readonly allowedTradeModes: ReadonlySet<Mt5HostAccount['tradeMode']>;
  private readonly allowRealTrading: boolean;
  private snapshotCache: Mt5HostSnapshot | undefined;
  private connected = false;
  private readonly handlers = new Set<BrokerEventHandler>();

  constructor(options: Mt5AdapterOptions) {
    this.client = options.client;
    this.systemPrefix = options.systemPrefix;
    this.allowedTradeModes = new Set(options.allowedTradeModes ?? ['demo']);
    this.allowRealTrading = options.allowRealTrading ?? false;
    if (this.allowedTradeModes.has('real') && !this.allowRealTrading) {
      throw new Mt5AdapterError(
        'real MT5 mode was listed as allowed without the separate allowRealTrading safety gate',
      );
    }
  }

  get capabilities(): BrokerCapabilities {
    return {
      clientOrderId: 'emulated',
      findByClientOrderId: true,
      streamsFills: false,
      atomicStopLoss: true,
      partialFills: true,
      supportsPartialClose: true,
      serverTimeSource: 'broker',
      positionModel: this.snapshotCache?.account.positionModel ?? 'netting',
      maxOrdersPerSecond: 5,
    };
  }

  async connect(): Promise<void> {
    const snapshot = await this.refresh();
    this.assertModeAllowed(snapshot.account);
    if (!snapshot.terminalConnected) {
      this.connected = false;
      throw new Mt5AdapterError('MT5 execution host is reachable but terminal is disconnected');
    }
    this.connected = true;
    this.emit({ type: 'connected', at: snapshot.observedAt });
    this.emit({
      type: 'account',
      at: snapshot.account.asOf,
      account: mapAccount(snapshot.account),
    });
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      this.emit({ type: 'disconnected', reason: 'adapter disconnected', at: Date.now() });
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getInstruments(): Promise<readonly InstrumentSpec[]> {
    const snapshot = await this.refreshConnected();
    return snapshot.instruments.map((instrument) =>
      mapInstrument(instrument, snapshot.account.positionModel),
    );
  }

  async getAccount(): Promise<BrokerAccount> {
    return mapAccount((await this.refreshConnected()).account);
  }

  async getPositions(): Promise<readonly BrokerPosition[]> {
    return (await this.refreshConnected()).positions.map(mapPosition);
  }

  async getOpenOrders(): Promise<readonly BrokerOrder[]> {
    return (await this.refreshConnected()).orders.map((order) => mapOrder(order));
  }

  async getQuote(canonical: string): Promise<BrokerQuote | undefined> {
    const quote = (await this.refreshConnected()).quotes.find(
      (candidate) => candidate.canonical === canonical,
    );
    return quote === undefined ? undefined : mapQuote(quote);
  }

  async placeOrder(req: BrokerOrderRequest): Promise<BrokerSubmitResult> {
    this.assertCanTrade();
    const magic = magicToWire(magicForClientOrderId(req.clientOrderId, this.systemPrefix));
    try {
      return mapSubmit(
        await this.client.placeOrder({
          clientOrderId: req.clientOrderId,
          magic,
          symbol: req.symbol,
          side: req.side,
          kind: req.kind,
          volume: D.Decimal.toString(req.volume),
          ...(req.limitPrice === undefined
            ? {}
            : { limitPrice: D.Decimal.toString(req.limitPrice) }),
          ...(req.stopTriggerPrice === undefined
            ? {}
            : { stopTriggerPrice: D.Decimal.toString(req.stopTriggerPrice) }),
          ...(req.stopLoss === undefined
            ? {}
            : { stopLoss: D.Decimal.toString(req.stopLoss) }),
          ...(req.takeProfit === undefined
            ? {}
            : { takeProfit: D.Decimal.toString(req.takeProfit) }),
          timeInForce: req.timeInForce,
          ...(req.maxSlippage === undefined
            ? {}
            : { maxSlippage: D.Decimal.toString(req.maxSlippage) }),
        }),
      );
    } catch (error) {
      return this.transportAmbiguous(error);
    }
  }

  async cancelOrder(
    venueOrderId: string,
    clientOrderId: string,
  ): Promise<BrokerSubmitResult> {
    this.assertCanTrade();
    const magic = magicToWire(magicForClientOrderId(clientOrderId, this.systemPrefix));
    try {
      return mapSubmit(
        await this.client.cancelOrder({ orderTicket: venueOrderId, clientOrderId, magic }),
      );
    } catch (error) {
      return this.transportAmbiguous(error);
    }
  }

  async modifyPosition(
    positionId: string,
    stopLoss: Dec | undefined,
    takeProfit: Dec | undefined,
  ): Promise<BrokerSubmitResult> {
    this.assertCanTrade();
    try {
      return mapSubmit(
        await this.client.modifyPosition({
          positionId,
          ...(stopLoss === undefined ? {} : { stopLoss: D.Decimal.toString(stopLoss) }),
          ...(takeProfit === undefined
            ? {}
            : { takeProfit: D.Decimal.toString(takeProfit) }),
        }),
      );
    } catch (error) {
      return this.transportAmbiguous(error);
    }
  }

  async closePosition(
    positionId: string,
    volume: Dec | undefined,
    clientOrderId: string,
  ): Promise<BrokerSubmitResult> {
    this.assertCanTrade();
    const magic = magicToWire(magicForClientOrderId(clientOrderId, this.systemPrefix));
    try {
      return mapSubmit(
        await this.client.closePosition({
          positionId,
          ...(volume === undefined ? {} : { volume: D.Decimal.toString(volume) }),
          clientOrderId,
          magic,
        }),
      );
    } catch (error) {
      return this.transportAmbiguous(error);
    }
  }

  async findByClientOrderId(
    clientOrderId: string,
    context?: BrokerLookupContext,
  ): Promise<LookupResult> {
    if (context === undefined) {
      return {
        found: 'indeterminate',
        reason: 'MT5 recovery requires durable symbol/side/volume/send-window context',
      };
    }
    if (!this.connected) {
      return { found: 'indeterminate', reason: 'MT5 adapter is not connected' };
    }

    const magic = magicToWire(magicForClientOrderId(clientOrderId, this.systemPrefix));
    let response: Awaited<ReturnType<Mt5HostClient['reconcile']>>;
    try {
      response = await this.client.reconcile({
        magic,
        symbol: context.symbol,
        side: context.side,
        volume: D.Decimal.toString(context.volume),
        sentNotBefore: context.sentNotBefore,
        sentNotAfter: context.sentNotAfter,
      });
    } catch (error) {
      return {
        found: 'indeterminate',
        reason: `MT5 reconciliation failed: ${this.errorMessage(error)}`,
      };
    }

    const verdict = inspectMt5Observation(
      magic,
      {
        symbol: context.symbol,
        side: context.side,
        volume: D.Decimal.toString(context.volume),
        sentNotBefore: context.sentNotBefore,
        sentNotAfter: context.sentNotAfter,
      },
      response.observation,
    );

    if (verdict.outcome === 'negative') {
      return { found: false, evidence: verdict.evidence };
    }
    if (verdict.outcome === 'probable') {
      return { found: 'indeterminate', reason: verdict.reason };
    }
    if (verdict.outcome === 'indeterminate') {
      return { found: 'indeterminate', reason: verdict.reason };
    }

    let snapshot: Mt5HostSnapshot;
    try {
      snapshot = await this.refreshConnected();
    } catch (error) {
      return {
        found: 'indeterminate',
        reason: `magic was confirmed but current MT5 snapshot failed: ${this.errorMessage(error)}`,
      };
    }
    const order = snapshot.orders.find((candidate) => candidate.magic === magic);
    if (order !== undefined) {
      return { found: true, order: mapOrder(order, clientOrderId) };
    }

    // A market order may already have disappeared from active orders. If the
    // authoritative reconciliation saw our magic in a deal/position, return a
    // conservative FILLED representation rather than pretending it is absent.
    const candidate = verdict.matches[0];
    if (candidate === undefined) {
      return { found: 'indeterminate', reason: 'confirmed MT5 evidence had no candidate object' };
    }
    return {
      found: true,
      order: {
        venueOrderId: candidate.ticket,
        clientOrderId,
        canonical: context.canonical,
        symbol: context.symbol,
        side: context.side,
        state: 'FILLED',
        requestedQty: context.volume,
        filledQty: D.dec(candidate.volume),
        ...(candidate.price === undefined ? {} : { avgFillPrice: D.dec(candidate.price) }),
        createdAt: candidate.serverTime,
      },
    };
  }

  on(handler: BrokerEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private async refresh(): Promise<Mt5HostSnapshot> {
    try {
      const snapshot = await this.client.snapshot();
      this.snapshotCache = snapshot;
      if (!snapshot.terminalConnected) this.connected = false;
      return snapshot;
    } catch (error) {
      this.connected = false;
      throw error;
    }
  }

  private async refreshConnected(): Promise<Mt5HostSnapshot> {
    const snapshot = await this.refresh();
    this.assertModeAllowed(snapshot.account);
    if (!snapshot.terminalConnected) {
      throw new Mt5AdapterError('MT5 terminal is disconnected');
    }
    this.connected = true;
    return snapshot;
  }

  private assertModeAllowed(account: Mt5HostAccount): void {
    if (!this.allowedTradeModes.has(account.tradeMode)) {
      throw new Mt5AdapterError(`MT5 account mode '${account.tradeMode}' is not enabled by policy`);
    }
    if (account.tradeMode === 'real' && !this.allowRealTrading) {
      throw new Mt5AdapterError('real-money MT5 trading is disabled');
    }
  }

  private assertCanTrade(): void {
    if (!this.connected || this.snapshotCache === undefined) {
      throw new Mt5AdapterError('MT5 adapter is not connected');
    }
    this.assertModeAllowed(this.snapshotCache.account);
    if (!this.snapshotCache.terminalConnected || !this.snapshotCache.tradeAllowed) {
      throw new Mt5AdapterError('MT5 terminal does not currently allow trading');
    }
  }

  private transportAmbiguous(error: unknown): BrokerSubmitResult {
    return {
      outcome: 'ambiguous',
      reason: `MT5 execution host transport outcome is unknown: ${this.errorMessage(error)}`,
      at: Date.now(),
    };
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Mt5HostError || error instanceof Error) return error.message;
    return String(error);
  }

  private emit(event: Parameters<BrokerEventHandler>[0]): void {
    for (const handler of this.handlers) handler(event);
  }
}
