import { describe, expect, it, vi } from 'vitest';
import { DesktopDeskClient } from '../../../desktop/src/client.js';
import { DesktopMissionOperator } from '../../../desktop/src/mission-operator.js';

const signer = { sign: vi.fn(async () => 'signature') };

type TestFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(fetchFn: TestFetch) {
  return new DesktopDeskClient({
    baseUrl: 'http://127.0.0.1:8787',
    deviceId: 'windows-1',
    signer,
    hashBody: async (body) => `hash:${body}`,
    randomId: () => 'request-nonce',
    now: () => 1_800_000_000_000,
    // React Native and Node expose slightly different overload sets for fetch.
    // The test double implements the common runtime contract used here.
    fetchFn: fetchFn as typeof fetch,
  });
}

const order = {
  missionId: 'mission-1',
  intentId: 'intent-1',
  canonical: 'XAUUSD',
  side: 'buy' as const,
  stopPrice: '2440.00',
  takeProfitPrice: '2480.00',
  note: 'Breakout confirmation',
};

describe('Windows/Desktop Mission client', () => {
  it('refuses legacy Mission-less /orders before any network call', async () => {
    const fetchFn = vi.fn<TestFetch>();
    const client = makeClient(fetchFn);

    const result = await client.command('/orders', { symbol: 'XAUUSD' });

    expect(result).toMatchObject({ ok: false, code: 'MISSION_REQUIRED', outcomeUnknown: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('gets a command nonce and sends a Mission order exactly once', async () => {
    signer.sign.mockClear();
    const fetchFn = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(response(200, { nonce: 'command-nonce' }))
      .mockResolvedValueOnce(
        response(200, {
          missionId: 'mission-1',
          intentId: 'intent-1',
          accepted: true,
          deduplicated: false,
        }),
      );
    const client = makeClient(fetchFn);
    const operator = new DesktopMissionOperator(client);

    const result = await operator.submitMarketOrder(order);

    expect(result.kind).toBe('sent');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const commandInit = fetchFn.mock.calls[1]?.[1];
    expect(commandInit?.headers).toMatchObject({
      'x-keel-command-nonce': 'command-nonce',
      'x-keel-device': 'windows-1',
    });
    expect(commandInit?.body).toContain('"origin":"operator:windows"');
    expect(signer.sign).toHaveBeenLastCalledWith(
      expect.stringContaining('/missions/mission-1/orders'),
      'Long XAUUSD',
      true,
    );
  });

  it('classifies a command network failure as UNKNOWN and never retries it', async () => {
    const fetchFn = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(response(200, { nonce: 'command-nonce' }))
      .mockRejectedValueOnce(new Error('socket closed'));
    const operator = new DesktopMissionOperator(makeClient(fetchFn));

    const result = await operator.submitMarketOrder(order);

    expect(result.kind).toBe('unknown');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
