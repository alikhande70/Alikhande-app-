import { describe, expect, it, vi } from 'vitest';
import { Mt5HostClient, Mt5HostError, type Mt5HostRequest } from './host-client.js';

const TOKEN = 'test-token-0123456789';

function clientWith(request: Mt5HostRequest): Mt5HostClient {
  return new Mt5HostClient({ baseUrl: 'http://127.0.0.1:8790', token: TOKEN, request });
}

function validSnapshot(): Record<string, unknown> {
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
    instrumentFacts: [],
    positions: [],
    orders: [],
    quotes: [],
    observedAt: 1_700_000_000_000,
  };
}

describe('Mt5HostClient', () => {
  it('adds bearer auth and preserves decimal-string identifiers', async () => {
    const request = vi.fn<Mt5HostRequest>().mockResolvedValue({
      status: 200,
      body: {
        outcome: 'acked',
        retcode: 10009,
        retcodeName: 'TRADE_RETCODE_DONE',
        orderTicket: '1844674407370955',
        state: 'FILLED',
        filledQty: '0.01',
        serverTime: 1_700_000_000_000,
      },
    });
    const client = clientWith(request);

    const result = await client.placeOrder({
      clientOrderId: 'k-order',
      magic: '9223372036854775000',
      symbol: 'XAUUSD',
      side: 'buy',
      kind: 'market',
      volume: '0.01',
      timeInForce: 'GTC',
    });

    expect(result.outcome).toBe('acked');
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:8790/v1/orders/place');
    expect(init?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init?.body ?? '{}')).toMatchObject({
      magic: '9223372036854775000',
      volume: '0.01',
    });
  });

  it('revalidates snapshot truth at the HTTP boundary', async () => {
    const client = clientWith(async () => ({ status: 200, body: validSnapshot() }));
    await expect(client.snapshot()).resolves.toMatchObject({
      hostId: 'host-test',
      terminalConnected: true,
    });
  });

  it('fails closed when the HTTP host returns an incomplete snapshot', async () => {
    const malformed = validSnapshot();
    delete malformed.orders;
    const client = clientWith(async () => ({ status: 200, body: malformed }));

    await expect(client.snapshot()).rejects.toMatchObject({
      name: 'Mt5HostError',
      status: 200,
      responseBody: malformed,
    });
    await expect(client.snapshot()).rejects.toThrow('invalid snapshot truth');
  });

  it('does not turn an HTTP failure into a trade rejection', async () => {
    const client = clientWith(async () => ({ status: 503, body: { detail: 'host restarting' } }));
    await expect(
      client.placeOrder({
        clientOrderId: 'k-order',
        magic: '42',
        symbol: 'EURUSD',
        side: 'sell',
        kind: 'market',
        volume: '0.10',
        timeInForce: 'GTC',
      }),
    ).rejects.toMatchObject({ name: 'Mt5HostError', status: 503 });
  });

  it('wraps transport loss distinctly from a definite venue answer', async () => {
    const client = clientWith(async () => {
      throw new Error('socket reset');
    });
    await expect(client.snapshot()).rejects.toThrow('socket reset');
  });

  it('refuses short host secrets', () => {
    expect(() => new Mt5HostClient({ baseUrl: 'http://127.0.0.1:8790', token: 'short' })).toThrow(
      Mt5HostError,
    );
  });

  it('refuses non-http host URLs', () => {
    expect(() => new Mt5HostClient({ baseUrl: 'file:///tmp/mt5', token: TOKEN })).toThrow(
      'must use http or https',
    );
  });
});
