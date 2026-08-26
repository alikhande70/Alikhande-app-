import * as D from '@keel/core';
import { describe, expect, it, vi } from 'vitest';
import { Mt5AdapterError, Mt5BrokerAdapter } from './adapter.js';
import { Mt5HostClient, type Mt5HostRequest } from './host-client.js';
import type { Mt5HostSnapshot } from './host-types.js';
import { magicForClientOrderId, magicToWire } from './identity.js';
import { Mt5InstrumentBinding } from './instrument-binding.js';
import { Mt5SymbolMap } from './symbol-map.js';

const TOKEN = 'test-token-0123456789';
const PREFIX = 0x4b45;
const BINDING = new Mt5InstrumentBinding(new Mt5SymbolMap(), {
  XAUUSD: { assetClass: 'metal', base: 'XAU', quote: 'USD', venueTimeZone: 'Etc/UTC' },
});

function snapshot(overrides: Partial<Mt5HostSnapshot> = {}): Mt5HostSnapshot {
  return {
    protocolVersion: 1,
    hostId: 'host-test',
    terminalConnected: true,
    tradeAllowed: true,
    account: {
      login: '123',
      server: 'LiteFinance-Demo',
      company: 'LiteFinance',
      currency: 'USD',
      tradeMode: 'demo',
      positionModel: 'hedging',
      balance: '10000.00',
      equity: '10050.00',
      marginUsed: '50.00',
      marginFree: '10000.00',
      asOf: 1_700_000_000_000,
    },
    instrumentFacts: [
      {
        symbol: 'XAUUSD',
        digits: 2,
        point: '0.01',
        tickSize: '0.01',
        contractSize: '100',
        minVolume: '0.01',
        maxVolume: '50.00',
        volumeStep: '0.01',
        tickValueAccount: '1.00',
        stopsLevel: '0',
        freezeLevel: '0',
        tradeMode: 4,
        asOf: 1_700_000_000_000,
      },
    ],
    positions: [],
    orders: [],
    quotes: [{ canonical: 'XAUUSD', bid: '2500.10', ask: '2500.30', asOf: 1_700_000_000_000 }],
    observedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function clientWith(request: Mt5HostRequest): Mt5HostClient {
  return new Mt5HostClient({ baseUrl: 'http://127.0.0.1:8790', token: TOKEN, request });
}

function adapterWith(
  request: Mt5HostRequest,
  instrumentBinding: Mt5InstrumentBinding = BINDING,
): Mt5BrokerAdapter {
  return new Mt5BrokerAdapter({
    client: clientWith(request),
    systemPrefix: PREFIX,
    instrumentBinding,
  });
}

describe('Mt5BrokerAdapter', () => {
  it('connects to demo and maps authoritative account/instrument decimals', async () => {
    const request = vi.fn<Mt5HostRequest>().mockResolvedValue({ status: 200, body: snapshot() });
    const adapter = adapterWith(request);

    await adapter.connect();
    expect(adapter.isConnected()).toBe(true);
    expect(adapter.capabilities.positionModel).toBe('hedging');

    const account = await adapter.getAccount();
    expect(D.Decimal.toString(account.equity)).toBe('10050.00');
    const [spec] = await adapter.getInstruments();
    expect(spec?.canonical).toBe('XAUUSD');
    expect(D.Decimal.toString(spec?.contractSize ?? D.dec('0'))).toBe('100');
  });

  it('applies one explicit symbol binding across instruments, positions, orders and quotes', async () => {
    const binding = new Mt5InstrumentBinding(new Mt5SymbolMap({ 'XAUUSD.x': 'XAUUSD' }), {
      XAUUSD: { assetClass: 'metal', base: 'XAU', quote: 'USD', venueTimeZone: 'Etc/UTC' },
    });
    const baseFacts = snapshot().instrumentFacts[0];
    if (baseFacts === undefined) throw new Error('test fixture must contain XAUUSD instrument');
    const aliased = snapshot({
      instrumentFacts: [{ ...baseFacts, symbol: 'XAUUSD.x' }],
      positions: [
        {
          ticket: '10',
          positionId: '11',
          magic: '0',
          symbol: 'XAUUSD.x',
          canonical: 'XAUUSD.x',
          side: 'buy',
          volume: '0.01',
          entryPrice: '2500.00',
          openedAt: 1_700_000_000_000,
        },
      ],
      orders: [
        {
          ticket: '12',
          magic: '0',
          symbol: 'XAUUSD.x',
          canonical: 'XAUUSD.x',
          side: 'buy',
          state: 'WORKING',
          requestedQty: '0.01',
          filledQty: '0.00',
          createdAt: 1_700_000_000_000,
        },
      ],
      quotes: [{ canonical: 'XAUUSD.x', bid: '2500.10', ask: '2500.30', asOf: 1_700_000_000_000 }],
    });
    const adapter = adapterWith(async () => ({ status: 200, body: aliased }), binding);
    await adapter.connect();

    expect((await adapter.getInstruments())[0]?.canonical).toBe('XAUUSD');
    expect((await adapter.getPositions())[0]?.canonical).toBe('XAUUSD');
    expect((await adapter.getOpenOrders())[0]?.canonical).toBe('XAUUSD');
    expect((await adapter.getQuote('XAUUSD'))?.canonical).toBe('XAUUSD');
  });

  it('refuses a real account by default before enabling the adapter', async () => {
    const real = snapshot({ account: { ...snapshot().account, tradeMode: 'real' } });
    const adapter = adapterWith(async () => ({ status: 200, body: real }));

    await expect(adapter.connect()).rejects.toThrow("account mode 'real' is not enabled");
    expect(adapter.isConnected()).toBe(false);
  });

  it('requires a second explicit safety gate even when real is listed as allowed', () => {
    expect(
      () =>
        new Mt5BrokerAdapter({
          client: clientWith(async () => ({ status: 200, body: snapshot() })),
          systemPrefix: PREFIX,
          instrumentBinding: BINDING,
          allowedTradeModes: ['demo', 'real'],
        }),
    ).toThrow(Mt5AdapterError);
  });

  it('derives deterministic magic and preserves exact decimal strings on submission', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const request: Mt5HostRequest = async (url, init) => {
      calls.push({ url, ...(init.body === undefined ? {} : { body: init.body }) });
      if (url.endsWith('/v1/snapshot')) return { status: 200, body: snapshot() };
      return {
        status: 200,
        body: {
          outcome: 'acked',
          retcode: 10009,
          retcodeName: 'TRADE_RETCODE_DONE',
          orderTicket: '9007199254740993123',
          state: 'FILLED',
          filledQty: '0.01',
          avgFillPrice: '2500.30',
          serverTime: 1_700_000_000_100,
        },
      };
    };
    const adapter = adapterWith(request);
    await adapter.connect();

    const result = await adapter.placeOrder({
      clientOrderId: 'keel-intent-1',
      canonical: 'XAUUSD',
      symbol: 'XAUUSD',
      side: 'buy',
      kind: 'market',
      volume: D.dec('0.01'),
      stopLoss: D.dec('2490.10'),
      takeProfit: D.dec('2520.70'),
      timeInForce: 'GTC',
    });

    expect(result).toMatchObject({
      outcome: 'acked',
      venueOrderId: '9007199254740993123',
      state: 'FILLED',
    });
    const place = calls.find((call) => call.url.endsWith('/v1/orders/place'));
    const body = JSON.parse(place?.body ?? '{}');
    expect(body.volume).toBe('0.01');
    expect(body.stopLoss).toBe('2490.10');
    expect(body.magic).toBe(magicToWire(magicForClientOrderId('keel-intent-1', PREFIX)));
  });

  it('turns host transport loss during send into ambiguous, never rejected', async () => {
    const request: Mt5HostRequest = async (url) => {
      if (url.endsWith('/v1/snapshot')) return { status: 200, body: snapshot() };
      throw new Error('connection reset after write');
    };
    const adapter = adapterWith(request);
    await adapter.connect();

    const result = await adapter.placeOrder({
      clientOrderId: 'ambiguous-1',
      canonical: 'XAUUSD',
      symbol: 'XAUUSD',
      side: 'buy',
      kind: 'market',
      volume: D.dec('0.01'),
      timeInForce: 'GTC',
    });
    expect(result.outcome).toBe('ambiguous');
  });

  it('returns one trustworthy full-state miss as a negative lookup for the resolver to repeat', async () => {
    const request: Mt5HostRequest = async (url) => {
      if (url.endsWith('/v1/snapshot')) return { status: 200, body: snapshot() };
      if (url.endsWith('/v1/reconcile')) {
        return {
          status: 200,
          body: {
            observation: {
              observedAt: 1_700_000_010_000,
              connected: true,
              positionsScanned: true,
              ordersScanned: true,
              historySelected: true,
              historyFrom: 1_699_999_990_000,
              historyTo: 1_700_000_020_000,
              candidates: [],
            },
          },
        };
      }
      throw new Error(`unexpected ${url}`);
    };
    const adapter = adapterWith(request);
    await adapter.connect();

    const result = await adapter.findByClientOrderId('missing-1', {
      canonical: 'XAUUSD',
      symbol: 'XAUUSD',
      side: 'buy',
      volume: D.dec('0.01'),
      sentNotBefore: 1_700_000_000_000,
      sentNotAfter: 1_700_000_001_000,
    });
    expect(result.found).toBe(false);
  });

  it('does not attribute a fingerprint-only match to the brain/order id', async () => {
    const expectedMagic = magicToWire(magicForClientOrderId('lost-magic', PREFIX));
    const request: Mt5HostRequest = async (url) => {
      if (url.endsWith('/v1/snapshot')) return { status: 200, body: snapshot() };
      if (url.endsWith('/v1/reconcile')) {
        return {
          status: 200,
          body: {
            observation: {
              observedAt: 1_700_000_002_000,
              connected: true,
              positionsScanned: true,
              ordersScanned: true,
              historySelected: true,
              historyFrom: 1_699_999_990_000,
              historyTo: 1_700_000_020_000,
              candidates: [
                {
                  kind: 'position',
                  ticket: '777',
                  positionId: '888',
                  magic: expectedMagic === '0' ? '1' : '0',
                  symbol: 'XAUUSD',
                  side: 'buy',
                  volume: '0.01',
                  price: '2500.30',
                  serverTime: 1_700_000_000_500,
                },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected ${url}`);
    };
    const adapter = adapterWith(request);
    await adapter.connect();

    const result = await adapter.findByClientOrderId('lost-magic', {
      canonical: 'XAUUSD',
      symbol: 'XAUUSD',
      side: 'buy',
      volume: D.dec('0.01'),
      sentNotBefore: 1_700_000_000_000,
      sentNotAfter: 1_700_000_001_000,
    });
    expect(result).toMatchObject({ found: 'indeterminate' });
  });

  it.each(['REJECTED', 'CANCELLED', 'EXPIRED'] as const)(
    'propagates trustworthy %s historical order state without claiming a fill',
    async (state) => {
      const clientOrderId = `terminal-history-${state.toLowerCase()}`;
      const expectedMagic = magicToWire(magicForClientOrderId(clientOrderId, PREFIX));
      const request: Mt5HostRequest = async (url) => {
        if (url.endsWith('/v1/snapshot')) return { status: 200, body: snapshot() };
        if (url.endsWith('/v1/reconcile')) {
          return {
            status: 200,
            body: {
              observation: {
                observedAt: 1_700_000_002_000,
                connected: true,
                positionsScanned: true,
                ordersScanned: true,
                historySelected: true,
                historyFrom: 1_699_999_990_000,
                historyTo: 1_700_000_020_000,
                candidates: [
                  {
                    kind: 'order',
                    ticket: '8001',
                    magic: expectedMagic,
                    symbol: 'XAUUSD',
                    side: 'buy',
                    volume: '0.01',
                    price: '2500.30',
                    serverTime: 1_700_000_000_500,
                    orderState: state,
                  },
                ],
              },
            },
          };
        }
        throw new Error(`unexpected ${url}`);
      };
      const adapter = adapterWith(request);
      await adapter.connect();

      const result = await adapter.findByClientOrderId(clientOrderId, {
        canonical: 'XAUUSD',
        symbol: 'XAUUSD',
        side: 'buy',
        volume: D.dec('0.01'),
        sentNotBefore: 1_700_000_000_000,
        sentNotAfter: 1_700_000_001_000,
      });
      expect(result.found).toBe(true);
      if (result.found === true) {
        expect(result.order.state).toBe(state);
        expect(D.Decimal.toString(result.order.filledQty)).toBe('0.00');
      }
    },
  );

  it('fails closed when reconcile order evidence omits orderState', async () => {
    const clientOrderId = 'malformed-history';
    const expectedMagic = magicToWire(magicForClientOrderId(clientOrderId, PREFIX));
    const request: Mt5HostRequest = async (url) => {
      if (url.endsWith('/v1/snapshot')) return { status: 200, body: snapshot() };
      if (url.endsWith('/v1/reconcile')) {
        return {
          status: 200,
          body: {
            observation: {
              observedAt: 1_700_000_002_000,
              connected: true,
              positionsScanned: true,
              ordersScanned: true,
              historySelected: true,
              historyFrom: 1_699_999_990_000,
              historyTo: 1_700_000_020_000,
              candidates: [
                {
                  kind: 'order',
                  ticket: '8001',
                  magic: expectedMagic,
                  symbol: 'XAUUSD',
                  side: 'buy',
                  volume: '0.01',
                  serverTime: 1_700_000_000_500,
                },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected ${url}`);
    };
    const adapter = adapterWith(request);
    await adapter.connect();

    const result = await adapter.findByClientOrderId(clientOrderId, {
      canonical: 'XAUUSD',
      symbol: 'XAUUSD',
      side: 'buy',
      volume: D.dec('0.01'),
      sentNotBefore: 1_700_000_000_000,
      sentNotAfter: 1_700_000_001_000,
    });
    expect(result).toMatchObject({ found: 'indeterminate' });
  });

  it('sums partial fills instead of reporting only the first deal', async () => {
    // A position filled by two deals yields two candidates carrying the same
    // magic. Taking matches[0] reported 0.01 of a 0.03 position -- a third of
    // the risk actually held.
    const expectedMagic = magicToWire(magicForClientOrderId('partial-1', PREFIX));
    const request: Mt5HostRequest = async (url) => {
      if (url.endsWith('/v1/snapshot')) return { status: 200, body: snapshot() };
      if (url.endsWith('/v1/reconcile')) {
        return {
          status: 200,
          body: {
            observation: {
              observedAt: 1_700_000_002_000,
              connected: true,
              positionsScanned: true,
              ordersScanned: true,
              historySelected: true,
              historyFrom: 1_699_999_990_000,
              historyTo: 1_700_000_020_000,
              candidates: [
                {
                  kind: 'deal',
                  ticket: '11',
                  positionId: '900',
                  magic: expectedMagic,
                  symbol: 'XAUUSD',
                  side: 'buy',
                  volume: '0.01',
                  price: '2500.00',
                  serverTime: 1_700_000_000_400,
                },
                {
                  kind: 'deal',
                  ticket: '12',
                  positionId: '900',
                  magic: expectedMagic,
                  symbol: 'XAUUSD',
                  side: 'buy',
                  volume: '0.02',
                  price: '2501.00',
                  serverTime: 1_700_000_000_600,
                },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected ${url}`);
    };
    const adapter = adapterWith(request);
    await adapter.connect();

    const result = await adapter.findByClientOrderId('partial-1', {
      canonical: 'XAUUSD',
      symbol: 'XAUUSD',
      side: 'buy',
      volume: D.dec('0.03'),
      sentNotBefore: 1_700_000_000_000,
      sentNotAfter: 1_700_000_001_000,
    });

    expect(result.found).toBe(true);
    if (result.found !== true) return;
    expect(D.Decimal.toString(result.order.filledQty)).toBe('0.03');
    const avg = result.order.avgFillPrice;
    expect(avg).toBeDefined();
    if (avg === undefined) return;
    // Volume-weighted (2500*0.01 + 2501*0.02)/0.03, not the first deal's price.
    expect(D.Decimal.toString(avg).startsWith('2500.66')).toBe(true);
  });

  it('refuses to attribute a duplicate execution as one clean fill', async () => {
    const expectedMagic = magicToWire(magicForClientOrderId('dup-1', PREFIX));
    const request: Mt5HostRequest = async (url) => {
      if (url.endsWith('/v1/snapshot')) return { status: 200, body: snapshot() };
      if (url.endsWith('/v1/reconcile')) {
        return {
          status: 200,
          body: {
            observation: {
              observedAt: 1_700_000_002_000,
              connected: true,
              positionsScanned: true,
              ordersScanned: true,
              historySelected: true,
              historyFrom: 1_699_999_990_000,
              historyTo: 1_700_000_020_000,
              candidates: [
                {
                  kind: 'position',
                  ticket: '900',
                  positionId: '900',
                  magic: expectedMagic,
                  symbol: 'XAUUSD',
                  side: 'buy',
                  volume: '0.01',
                  price: '2500.00',
                  serverTime: 1_700_000_000_400,
                },
                {
                  kind: 'position',
                  ticket: '901',
                  positionId: '901',
                  magic: expectedMagic,
                  symbol: 'XAUUSD',
                  side: 'buy',
                  volume: '0.01',
                  price: '2500.10',
                  serverTime: 1_700_000_000_600,
                },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected ${url}`);
    };
    const adapter = adapterWith(request);
    await adapter.connect();

    const result = await adapter.findByClientOrderId('dup-1', {
      canonical: 'XAUUSD',
      symbol: 'XAUUSD',
      side: 'buy',
      volume: D.dec('0.01'),
      sentNotBefore: 1_700_000_000_000,
      sentNotAfter: 1_700_000_001_000,
    });
    expect(result.found).toBe('indeterminate');
    if (result.found !== 'indeterminate') return;
    expect(result.reason).toContain('more than once');
  });
});
