import { describe, expect, it, vi } from 'vitest';
import { DesktopDeskClient } from '../src/client.js';

const signer = {
  sign: vi.fn(async () => 'signature'),
};

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(fetchFn: typeof fetch) {
  return new DesktopDeskClient({
    baseUrl: 'http://127.0.0.1:8787',
    deviceId: 'windows-1',
    signer,
    hashBody: async (body) => `hash:${body}`,
    randomId: () => 'request-nonce',
    now: () => 1_800_000_000_000,
    fetchFn,
  });
}

describe('DesktopDeskClient', () => {
  it('refuses the legacy Mission-less /orders route before any network call', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = makeClient(fetchFn);

    const result = await client.command('/orders', { symbol: 'XAUUSD' });

    expect(result).toMatchObject({
      ok: false,
      code: 'MISSION_REQUIRED',
      outcomeUnknown: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('gets a single-use nonce and signs a Mission order before sending it once', async () => {
    signer.sign.mockClear();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { nonce: 'command-nonce' }))
      .mockResolvedValueOnce(response(200, { accepted: true }));
    const client = makeClient(fetchFn);

    const result = await client.command('/missions/m-1/orders', { intentId: 'i-1' }, 'Long XAUUSD');

    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const commandInit = fetchFn.mock.calls[1]?.[1];
    expect(commandInit?.headers).toMatchObject({
      'x-keel-command-nonce': 'command-nonce',
      'x-keel-device': 'windows-1',
    });
    expect(signer.sign).toHaveBeenLastCalledWith(
      expect.stringContaining('/missions/m-1/orders'),
      'Long XAUUSD',
      true,
    );
  });

  it('classifies a command network failure as UNKNOWN and never retries it', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { nonce: 'command-nonce' }))
      .mockRejectedValueOnce(new Error('socket closed'));
    const client = makeClient(fetchFn);

    const result = await client.command('/missions/m-1/orders', { intentId: 'i-1' });

    expect(result).toMatchObject({
      ok: false,
      code: 'NETWORK',
      outcomeUnknown: true,
      retryable: false,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
