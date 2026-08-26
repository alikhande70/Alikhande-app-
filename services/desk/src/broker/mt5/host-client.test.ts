import { describe, expect, it, vi } from 'vitest';
import { Mt5HostClient, Mt5HostError, type Mt5HostRequest } from './host-client.js';

const TOKEN = 'test-token-0123456789';

function clientWith(request: Mt5HostRequest): Mt5HostClient {
  return new Mt5HostClient({ baseUrl: 'http://127.0.0.1:8790', token: TOKEN, request });
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
    expect(
      () => new Mt5HostClient({ baseUrl: 'http://127.0.0.1:8790', token: 'short' }),
    ).toThrow(Mt5HostError);
  });

  it('refuses non-http host URLs', () => {
    expect(
      () => new Mt5HostClient({ baseUrl: 'file:///tmp/mt5', token: TOKEN }),
    ).toThrow('must use http or https');
  });
});
