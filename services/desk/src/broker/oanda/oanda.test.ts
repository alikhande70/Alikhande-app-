import * as D from '@keel/core';
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '../../sim/clock.js';
import type { BrokerOrderRequest } from '../port.js';
import { supportsSafeRetry } from '../port.js';
import { OandaBroker } from './adapter.js';
import type { OandaHttpRequest, OandaHttpResponse } from './client.js';
import { OandaClient } from './client.js';

const d = D.dec;
const NOW = Date.UTC(2026, 5, 15, 14, 0, 0);
const log = pino({ level: 'silent' });

/**
 * A clock whose sleeps never resolve.
 *
 * Every reconnect loop in the adapter parks on `sleep`, so this keeps a
 * background retry from spinning the event loop during a test without needing
 * to drive time by hand.
 */
const clock: Clock = {
  now: () => NOW,
  sleep: () => new Promise<void>(() => {}),
  setTimeout: () => () => {},
  setInterval: () => () => {},
};

/** A stream that never yields and never ends, so streams stay out of the way. */
const idleStream = (() => new Promise(() => {})) as never;

interface Handler {
  readonly method: string;
  readonly path: string;
  readonly reply: (req: OandaHttpRequest) => OandaHttpResponse | Promise<OandaHttpResponse>;
}

/** A scripted v20 that records what it was asked for. */
class StubVenue {
  readonly requests: OandaHttpRequest[] = [];
  private readonly handlers: Handler[] = [];

  on(method: string, path: string, reply: Handler['reply']): this {
    this.handlers.push({ method, path, reply });
    return this;
  }

  json(method: string, path: string, status: number, body: unknown): this {
    return this.on(method, path, () => ({ status, body: JSON.stringify(body) }));
  }

  get transport() {
    return async (req: OandaHttpRequest): Promise<OandaHttpResponse> => {
      this.requests.push(req);
      const url = new URL(req.url);
      const match = this.handlers.find(
        (h) => h.method === req.method && url.pathname.includes(h.path),
      );
      if (match === undefined) {
        throw new Error(`no stub for ${req.method} ${url.pathname}`);
      }
      return match.reply(req);
    };
  }

  lastBody(): Record<string, unknown> {
    const last = this.requests[this.requests.length - 1];
    return JSON.parse(last?.body ?? '{}') as Record<string, unknown>;
  }
}

const ACCOUNT = {
  id: '101-004-1234567-001',
  currency: 'USD',
  balance: '10000.0000',
  NAV: '10120.5000',
  marginUsed: '333.3300',
  marginAvailable: '9787.1700',
  hedgingEnabled: false,
  lastTransactionID: '77',
};

const INSTRUMENTS = {
  instruments: [
    {
      name: 'EUR_USD',
      type: 'CURRENCY',
      displayPrecision: 5,
      tradeUnitsPrecision: 0,
      minimumTradeSize: '1',
      maximumOrderUnits: '100000000',
      marginRate: '0.0333',
    },
    {
      name: 'XAU_USD',
      type: 'METAL',
      displayPrecision: 3,
      tradeUnitsPrecision: 2,
      minimumTradeSize: '0.01',
      maximumOrderUnits: '5000',
      marginRate: '0.05',
    },
  ],
};

function venueWithAccount(): StubVenue {
  return new StubVenue()
    .json('GET', '/summary', 200, { account: ACCOUNT })
    .json('GET', '/instruments', 200, INSTRUMENTS);
}

function brokerFor(venue: StubVenue): OandaBroker {
  const client = new OandaClient({
    token: 'test-token',
    accountId: ACCOUNT.id,
    environment: 'practice',
    transport: venue.transport,
  });
  return new OandaBroker({ client, clock, log, instruments: ['EURUSD'], streamSource: idleStream });
}

function marketBuy(overrides: Partial<BrokerOrderRequest> = {}): BrokerOrderRequest {
  return {
    clientOrderId: 'k-ABC123XYZ',
    canonical: 'EURUSD',
    symbol: 'EUR_USD',
    side: 'buy',
    kind: 'market',
    volume: d('1000'),
    timeInForce: 'FOK',
    ...overrides,
  };
}

const FILL_TX = {
  id: '78',
  time: '2026-06-15T14:00:00.123456789Z',
  type: 'ORDER_FILL',
  orderID: '77',
  instrument: 'EUR_USD',
  units: '1000',
  price: '1.13750',
};

describe('connect', () => {
  it('reads the position model from the account rather than assuming it', async () => {
    const venue = new StubVenue()
      .json('GET', '/summary', 200, { account: { ...ACCOUNT, hedgingEnabled: true } })
      .json('GET', '/instruments', 200, INSTRUMENTS);
    const broker = brokerFor(venue);
    await broker.connect();
    expect(broker.capabilities.positionModel).toBe('hedging');
  });

  it('defaults to netting when hedging is off', async () => {
    const broker = brokerFor(venueWithAccount());
    await broker.connect();
    expect(broker.capabilities.positionModel).toBe('netting');
  });

  it('fails loudly rather than starting against an unreadable account', async () => {
    const venue = new StubVenue().json('GET', '/summary', 401, {
      errorMessage: 'Insufficient authorization',
    });
    await expect(brokerFor(venue).connect()).rejects.toThrow(/Insufficient authorization/);
  });

  it('declares itself safe to retry, because v20 has native addressable ids', async () => {
    const broker = brokerFor(venueWithAccount());
    await broker.connect();
    expect(supportsSafeRetry(broker.capabilities)).toBe(true);
  });
});

describe('placeOrder — the three outcomes', () => {
  let venue: StubVenue;
  beforeEach(() => {
    venue = venueWithAccount();
  });

  it('acks an immediate fill with the venue price and time', async () => {
    venue.json('POST', '/orders', 201, {
      orderCreateTransaction: { id: '77', time: '2026-06-15T14:00:00.000000000Z', units: '1000' },
      orderFillTransaction: FILL_TX,
    });
    const broker = brokerFor(venue);
    await broker.connect();

    const res = await broker.placeOrder(marketBuy());
    expect(res.outcome).toBe('acked');
    if (res.outcome !== 'acked') return;
    expect(res.state).toBe('FILLED');
    expect(D.Decimal.toString(res.filledQty)).toBe('1000');
    expect(D.Decimal.toString(res.avgFillPrice as D.Dec)).toBe('1.13750');
    // The venue's own stamp, to the millisecond, not our arrival time.
    expect(res.at).toBe(Date.UTC(2026, 5, 15, 14, 0, 0, 123));
  });

  it('acks a resting order as WORKING', async () => {
    venue.json('POST', '/orders', 201, {
      orderCreateTransaction: { id: '90', time: '2026-06-15T14:00:00Z', units: '1000' },
    });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.placeOrder(marketBuy({ kind: 'limit', limitPrice: d('1.10000') }));
    expect(res.outcome).toBe('acked');
    if (res.outcome !== 'acked') return;
    expect(res.state).toBe('WORKING');
    expect(res.venueOrderId).toBe('90');
  });

  it('reports a rejection when OANDA declines the order', async () => {
    venue.json('POST', '/orders', 400, {
      orderRejectTransaction: {
        id: '78',
        time: '2026-06-15T14:00:00Z',
        rejectReason: 'INSUFFICIENT_MARGIN',
      },
      errorMessage: 'Insufficient margin',
      errorCode: 'INSUFFICIENT_MARGIN',
    });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.placeOrder(marketBuy());
    expect(res.outcome).toBe('rejected');
    if (res.outcome !== 'rejected') return;
    expect(res.code).toBe('INSUFFICIENT_MARGIN');
  });

  it('reports an immediate cancellation as a rejection', async () => {
    // A FOK market order that cannot be filled in full comes back 201 with a
    // cancel transaction. The venue considered it and declined: definite.
    venue.json('POST', '/orders', 201, {
      orderCreateTransaction: { id: '91', time: '2026-06-15T14:00:00Z', units: '1000' },
      orderCancelTransaction: {
        id: '92',
        time: '2026-06-15T14:00:00Z',
        reason: 'INSUFFICIENT_LIQUIDITY',
      },
    });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.placeOrder(marketBuy());
    expect(res.outcome).toBe('rejected');
    if (res.outcome !== 'rejected') return;
    expect(res.code).toBe('INSUFFICIENT_LIQUIDITY');
  });

  it('reads a partial fill as a fill, not as the cancellation beside it', async () => {
    // The safety property this whole ordering exists for: an IOC order that
    // takes 400 of 1000 returns BOTH a fill and a cancel. Reading the cancel
    // first would report a live 400-unit position as a rejection, and the
    // operator would re-enter on top of it.
    venue.json('POST', '/orders', 201, {
      orderCreateTransaction: { id: '93', time: '2026-06-15T14:00:00Z', units: '1000' },
      orderFillTransaction: { ...FILL_TX, id: '94', units: '400' },
      orderCancelTransaction: {
        id: '95',
        time: '2026-06-15T14:00:00Z',
        reason: 'TIME_IN_FORCE_EXPIRED',
      },
    });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.placeOrder(marketBuy({ timeInForce: 'IOC' }));
    expect(res.outcome).toBe('acked');
    if (res.outcome !== 'acked') return;
    expect(res.state).toBe('PARTIALLY_FILLED');
    expect(D.Decimal.toString(res.filledQty)).toBe('400');
    expect(res.venueStatus).toBe('TIME_IN_FORCE_EXPIRED');
  });

  it('is ambiguous when the transport dies, never rejected', async () => {
    venue.on('POST', '/orders', () => {
      throw new Error('socket hang up');
    });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.placeOrder(marketBuy());
    expect(res.outcome).toBe('ambiguous');
  });

  it.each([500, 502, 503, 429, 408])('is ambiguous on HTTP %i', async (status) => {
    venue.json('POST', '/orders', status, { errorMessage: 'upstream trouble' });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.placeOrder(marketBuy());
    expect(res.outcome).toBe('ambiguous');
  });

  it('is ambiguous when a 2xx body cannot be parsed', async () => {
    // The order may well have filled; the response simply cannot tell us.
    venue.on('POST', '/orders', () => ({ status: 201, body: '<html>gateway</html>' }));
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.placeOrder(marketBuy());
    expect(res.outcome).toBe('ambiguous');
  });

  it('is ambiguous when a 2xx carries no transaction at all', async () => {
    venue.json('POST', '/orders', 201, { lastTransactionID: '99' });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.placeOrder(marketBuy());
    expect(res.outcome).toBe('ambiguous');
  });

  it('rejects an untradeable instrument locally, without a network call', async () => {
    const broker = brokerFor(venue);
    await broker.connect();
    const before = venue.requests.length;
    const res = await broker.placeOrder(marketBuy({ canonical: 'GBPJPY' }));
    expect(res.outcome).toBe('rejected');
    expect(venue.requests.length).toBe(before);
  });
});

describe('placeOrder — what goes on the wire', () => {
  it('sets the client id on both the order and the trade it will open', async () => {
    // On fill the id migrates from order to trade. Setting only one leaves the
    // ambiguous-send lookup blind exactly when it is needed.
    const venue = venueWithAccount().json('POST', '/orders', 201, {
      orderCreateTransaction: { id: '77', time: '2026-06-15T14:00:00Z', units: '1000' },
      orderFillTransaction: FILL_TX,
    });
    const broker = brokerFor(venue);
    await broker.connect();
    await broker.placeOrder(marketBuy());

    const order = venue.lastBody().order as Record<string, Record<string, string>>;
    expect(order.clientExtensions?.id).toBe('k-ABC123XYZ');
    expect(order.tradeClientExtensions?.id).toBe('k-ABC123XYZ');
  });

  it('attaches the stop to the fill so the position is never naked', async () => {
    const venue = venueWithAccount().json('POST', '/orders', 201, {
      orderCreateTransaction: { id: '77', time: '2026-06-15T14:00:00Z', units: '1000' },
      orderFillTransaction: FILL_TX,
    });
    const broker = brokerFor(venue);
    await broker.connect();
    await broker.placeOrder(marketBuy({ stopLoss: d('1.13000'), takeProfit: d('1.14500') }));

    const order = venue.lastBody().order as Record<string, Record<string, string>>;
    expect(order.stopLossOnFill?.price).toBe('1.13000');
    expect(order.takeProfitOnFill?.price).toBe('1.14500');
    expect(broker.capabilities.atomicStopLoss).toBe(true);
  });

  it('sends a sell as negative units', async () => {
    const venue = venueWithAccount().json('POST', '/orders', 201, {
      orderCreateTransaction: { id: '77', time: '2026-06-15T14:00:00Z', units: '-1000' },
      orderFillTransaction: { ...FILL_TX, units: '-1000' },
    });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.placeOrder(marketBuy({ side: 'sell' }));

    const order = venue.lastBody().order as Record<string, string>;
    expect(order.units).toBe('-1000');
    // Filled quantity is reported as a magnitude regardless of direction.
    expect(res.outcome === 'acked' && D.Decimal.toString(res.filledQty)).toBe('1000');
  });
});

describe('findByClientOrderId', () => {
  const ORDER = {
    id: '77',
    createTime: '2026-06-15T14:00:00Z',
    state: 'PENDING',
    type: 'LIMIT',
    instrument: 'EUR_USD',
    units: '1000',
    price: '1.10000',
    clientExtensions: { id: 'k-ABC123XYZ' },
  };

  const TRADE = {
    id: '55',
    instrument: 'EUR_USD',
    price: '1.13750',
    openTime: '2026-06-15T14:00:00Z',
    initialUnits: '1000',
    currentUnits: '600',
    clientExtensions: { id: 'k-ABC123XYZ' },
  };

  it('finds a resting order by client id', async () => {
    const venue = venueWithAccount().json('GET', '/orders/@', 200, { order: ORDER });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.findByClientOrderId('k-ABC123XYZ');
    expect(res.found).toBe(true);
    if (res.found !== true) return;
    expect(res.order.venueOrderId).toBe('77');
  });

  it('finds a filled order as the trade the id migrated to', async () => {
    // This is the case that makes or breaks recovery: the order lookup 404s
    // because the id now belongs to the trade.
    const venue = venueWithAccount()
      .json('GET', '/orders/@', 404, { errorMessage: 'The Order specified does not exist' })
      .json('GET', '/trades/@', 200, { trade: TRADE });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.findByClientOrderId('k-ABC123XYZ');
    expect(res.found).toBe(true);
    if (res.found !== true) return;
    expect(res.order.state).toBe('FILLED');
    // initialUnits, not currentUnits: the order filled in full even though the
    // position has since been partly closed.
    expect(D.Decimal.toString(res.order.filledQty)).toBe('1000');
  });

  it('concludes absence only when both lookups return a clean 404', async () => {
    const venue = venueWithAccount()
      .json('GET', '/orders/@', 404, { errorMessage: 'no such order' })
      .json('GET', '/trades/@', 404, { errorMessage: 'no such trade' });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.findByClientOrderId('k-ABC123XYZ');
    expect(res.found).toBe(false);
    if (res.found !== false) return;
    expect(res.evidence).toContain('404');
  });

  it('returns indeterminate when the order lookup cannot be trusted', async () => {
    const venue = venueWithAccount().json('GET', '/orders/@', 503, { errorMessage: 'unavailable' });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.findByClientOrderId('k-ABC123XYZ');
    expect(res.found).toBe('indeterminate');
  });

  it('returns indeterminate when the trade lookup fails after a clean order 404', async () => {
    // Absence of the order plus an unknown for the trade is not absence.
    const venue = venueWithAccount()
      .json('GET', '/orders/@', 404, { errorMessage: 'no such order' })
      .json('GET', '/trades/@', 500, { errorMessage: 'boom' });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.findByClientOrderId('k-ABC123XYZ');
    expect(res.found).toBe('indeterminate');
  });

  it('never reads a non-404 failure as evidence of absence', async () => {
    // Found in self-review. A rotated token makes every lookup fail with 401,
    // which is a definite HTTP status — and the first version fell through to
    // the trade lookup and then reported "positive evidence of absence". That
    // would tell the resolver every in-flight order was never placed, and the
    // engine would be free to re-send all of them.
    for (const status of [400, 401, 403, 405, 422]) {
      const venue = venueWithAccount()
        .json('GET', '/orders/@', status, { errorMessage: 'nope' })
        .json('GET', '/trades/@', status, { errorMessage: 'nope' });
      const broker = brokerFor(venue);
      await broker.connect();
      const res = await broker.findByClientOrderId('k-ABC123XYZ');
      expect(res.found, `HTTP ${status} must not be read as absence`).toBe('indeterminate');
    }
  });

  it('is indeterminate when a 401 hits only the trade lookup', async () => {
    const venue = venueWithAccount()
      .json('GET', '/orders/@', 404, { errorMessage: 'no such order' })
      .json('GET', '/trades/@', 401, { errorMessage: 'token rotated' });
    const broker = brokerFor(venue);
    await broker.connect();
    expect((await broker.findByClientOrderId('k-ABC123XYZ')).found).toBe('indeterminate');
  });

  it('is indeterminate when the venue returns an order it cannot map', async () => {
    // Also from self-review: the venue plainly HAS the order. Failing to map it
    // is our defect, and must never be reported as the order not existing.
    const venue = venueWithAccount()
      .json('GET', '/orders/@', 200, {
        order: { id: '77', createTime: '2026-06-15T14:00:00Z', state: 'PENDING', type: 'LIMIT' },
      })
      .json('GET', '/trades/@', 404, { errorMessage: 'no such trade' });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.findByClientOrderId('k-ABC123XYZ');
    expect(res.found).toBe('indeterminate');
    if (res.found !== 'indeterminate') return;
    expect(res.reason).toContain('exists');
  });

  it('addresses the venue with a literal @ and an encoded id', async () => {
    const venue = venueWithAccount()
      .json('GET', '/orders/@', 404, { errorMessage: 'no' })
      .json('GET', '/trades/@', 404, { errorMessage: 'no' });
    const broker = brokerFor(venue);
    await broker.connect();
    await broker.findByClientOrderId('k-ABC123XYZ');
    const paths = venue.requests.map((r) => new URL(r.url).pathname);
    expect(paths.some((p) => p.endsWith('/orders/@k-ABC123XYZ'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/trades/@k-ABC123XYZ'))).toBe(true);
  });
});

describe('positions and orders', () => {
  it('maps open trades to positions with their protection', async () => {
    const venue = venueWithAccount().json('GET', '/openTrades', 200, {
      trades: [
        {
          id: '55',
          instrument: 'EUR_USD',
          price: '1.13750',
          openTime: '2026-06-15T14:00:00Z',
          initialUnits: '-1000',
          currentUnits: '-1000',
          unrealizedPL: '-12.5000',
          stopLossOrder: { price: '1.14500' },
          takeProfitOrder: { price: '1.12000' },
          clientExtensions: { id: 'k-ABC' },
        },
      ],
    });
    const broker = brokerFor(venue);
    await broker.connect();
    const [pos] = await broker.getPositions();
    expect(pos?.side).toBe('sell');
    expect(D.Decimal.toString(pos?.volume as D.Dec)).toBe('1000');
    expect(D.Decimal.toString(pos?.stopPrice as D.Dec)).toBe('1.14500');
    expect(D.Decimal.toString(pos?.unrealisedPnl as D.Dec)).toBe('-12.5000');
    expect(pos?.clientOrderId).toBe('k-ABC');
  });

  it('excludes protective orders from the open order book', async () => {
    // They are already visible as the stop on the position they protect;
    // listing them again would double-count and confuse reconciliation.
    const venue = venueWithAccount().json('GET', '/pendingOrders', 200, {
      orders: [
        {
          id: '77',
          createTime: '2026-06-15T14:00:00Z',
          state: 'PENDING',
          type: 'LIMIT',
          instrument: 'EUR_USD',
          units: '1000',
          price: '1.10000',
        },
        {
          id: '78',
          createTime: '2026-06-15T14:00:00Z',
          state: 'PENDING',
          type: 'STOP_LOSS',
          tradeID: '55',
        },
        {
          id: '79',
          createTime: '2026-06-15T14:00:00Z',
          state: 'PENDING',
          type: 'TAKE_PROFIT',
          tradeID: '55',
        },
      ],
    });
    const broker = brokerFor(venue);
    await broker.connect();
    const orders = await broker.getOpenOrders();
    expect(orders.map((o) => o.venueOrderId)).toEqual(['77']);
    expect(D.Decimal.toString(orders[0]?.limitPrice as D.Dec)).toBe('1.10000');
  });

  it('reads the account with NAV as equity', async () => {
    const broker = brokerFor(venueWithAccount());
    await broker.connect();
    const account = await broker.getAccount();
    expect(D.Decimal.toString(account.balance)).toBe('10000.0000');
    expect(D.Decimal.toString(account.equity)).toBe('10120.5000');
    expect(D.Decimal.toString(account.marginFree)).toBe('9787.1700');
  });

  it('returns a quote at the venue timestamp', async () => {
    const venue = venueWithAccount().json('GET', '/pricing', 200, {
      prices: [
        {
          instrument: 'EUR_USD',
          time: '2026-06-15T14:00:00.500000000Z',
          bids: [{ price: '1.13740' }],
          asks: [{ price: '1.13760' }],
        },
      ],
    });
    const broker = brokerFor(venue);
    await broker.connect();
    const quote = await broker.getQuote('EURUSD');
    expect(D.Decimal.toString(quote?.bid as D.Dec)).toBe('1.13740');
    expect(quote?.asOf).toBe(Date.UTC(2026, 5, 15, 14, 0, 0, 500));
  });

  it('returns no quote when a book side is empty rather than inventing one', async () => {
    const venue = venueWithAccount().json('GET', '/pricing', 200, {
      prices: [
        { instrument: 'EUR_USD', time: '2026-06-15T14:00:00Z', bids: [], asks: [{ price: '1.1' }] },
      ],
    });
    const broker = brokerFor(venue);
    await broker.connect();
    expect(await broker.getQuote('EURUSD')).toBeUndefined();
  });
});

describe('cancel, modify and close', () => {
  it('acks a cancel', async () => {
    const venue = venueWithAccount().json('PUT', '/cancel', 200, {
      orderCancelTransaction: { id: '80', time: '2026-06-15T14:00:00Z', orderID: '77' },
    });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.cancelOrder('77', 'k-ABC');
    expect(res.outcome).toBe('acked');
    if (res.outcome !== 'acked') return;
    expect(res.state).toBe('CANCELLED');
  });

  it('is ambiguous when a cancel times out', async () => {
    const venue = venueWithAccount().on('PUT', '/cancel', () => {
      throw new Error('ETIMEDOUT');
    });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.cancelOrder('77', 'k-ABC');
    expect(res.outcome).toBe('ambiguous');
  });

  it('addresses a cancel by client id when no venue id is known', async () => {
    const venue = venueWithAccount().json('PUT', '/cancel', 200, {
      orderCancelTransaction: { id: '80', time: '2026-06-15T14:00:00Z', orderID: '77' },
    });
    const broker = brokerFor(venue);
    await broker.connect();
    await broker.cancelOrder('', 'k-ABC');
    const last = venue.requests[venue.requests.length - 1];
    expect(new URL(last?.url ?? '').pathname).toContain('/orders/@k-ABC/cancel');
  });

  it('refuses a modify that would change nothing', async () => {
    const broker = brokerFor(venueWithAccount());
    await broker.connect();
    const res = await broker.modifyPosition('55', undefined, undefined);
    expect(res.outcome).toBe('rejected');
    if (res.outcome !== 'rejected') return;
    expect(res.code).toBe('NO_CHANGE');
  });

  it('sends only the protection that was supplied', async () => {
    const venue = venueWithAccount().json('PUT', '/orders', 200, {});
    const broker = brokerFor(venue);
    await broker.connect();
    await broker.modifyPosition('55', d('1.13000'), undefined);
    const body = venue.lastBody();
    expect((body.stopLoss as Record<string, string>).price).toBe('1.13000');
    // Absent, not null: null would remove the take profit rather than leave it.
    expect(body.takeProfit).toBeUndefined();
  });

  it('closes a whole position with ALL rather than a computed size', async () => {
    const venue = venueWithAccount().json('PUT', '/close', 200, {
      orderFillTransaction: { ...FILL_TX, id: '96', units: '-1000' },
    });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.closePosition('55', undefined, 'k-CLOSE');
    expect(venue.lastBody().units).toBe('ALL');
    expect(res.outcome).toBe('acked');
  });

  it('closes part of a position by magnitude', async () => {
    const venue = venueWithAccount().json('PUT', '/close', 200, {
      orderFillTransaction: { ...FILL_TX, id: '97', units: '-400' },
    });
    const broker = brokerFor(venue);
    await broker.connect();
    await broker.closePosition('55', d('400'), 'k-CLOSE');
    expect(venue.lastBody().units).toBe('400');
  });

  it('is ambiguous when a close cannot be confirmed', async () => {
    const venue = venueWithAccount().json('PUT', '/close', 502, { errorMessage: 'bad gateway' });
    const broker = brokerFor(venue);
    await broker.connect();
    const res = await broker.closePosition('55', undefined, 'k-CLOSE');
    expect(res.outcome).toBe('ambiguous');
  });
});
