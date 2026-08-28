import { describe, expect, it, vi } from 'vitest';
import { WindowsMissionAppShell } from '../../../desktop/src/app-shell.js';
import type { DesktopWebSocketLike } from '../../../desktop/src/realtime.js';
import type {
  WindowsNativeEd25519Bridge,
  WindowsSignerMetadataStore,
} from '../../../desktop/src/windows-signer.js';

const PUBLIC_KEY = 'QUJDREVGR0hJSktMTU5PUA==';
const SIGNATURE = 'c2lnbmF0dXJlLWJ5dGVzLTAx';

type TestFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function metadataStore(): WindowsSignerMetadataStore {
  return {
    load: vi.fn(async () => ({
      version: 1,
      keyName: 'keel-desktop-device-v1',
      publicKey: PUBLIC_KEY,
      protection: 'os-user-protected',
      createdAt: 1_800_000_000_000,
    })),
    save: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
}

function bridge(): WindowsNativeEd25519Bridge {
  return {
    hasKey: vi.fn(async () => true),
    generateKey: vi.fn(async () => ({
      publicKey: PUBLIC_KEY,
      protection: 'os-user-protected' as const,
    })),
    sign: vi.fn(async () => SIGNATURE),
    removeKey: vi.fn(async () => undefined),
  };
}

function fakeSocket() {
  const socket: DesktopWebSocketLike = {
    send: vi.fn(),
    close: vi.fn(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return socket;
}

const order = {
  missionId: 'mission-1',
  intentId: 'intent-1',
  canonical: 'XAUUSD',
  side: 'buy' as const,
  stopPrice: '2440.00',
  note: 'desktop shell gate',
};

describe('Windows Mission app shell', () => {
  it('renders only runtime Mission truth and blocks actions until a fresh snapshot proves currency', async () => {
    const socket = fakeSocket();
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
    const shell = await WindowsMissionAppShell.restorePaired({
      baseUrl: 'http://127.0.0.1:8787',
      deviceId: 'windows-device-1',
      bridge: bridge(),
      signerStore: metadataStore(),
      hashBody: async (body) => `hash:${body}`,
      randomId: () => 'request-nonce',
      fetchFn: fetchFn as typeof fetch,
      websocketFactory: () => socket,
    });

    expect(shell.view()).toEqual({
      connection: 'stopped',
      missionTruth: 'empty',
      actionable: false,
      missions: [],
    });

    shell.start();
    expect(shell.view()).toMatchObject({ connection: 'syncing', actionable: false });
    expect((await shell.submitMarketOrder(order)).kind).toBe('blocked');
    expect(fetchFn).not.toHaveBeenCalled();

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'snapshot',
        topic: 'missions',
        seq: 8,
        payload: [
          {
            missionId: 'mission-1',
            canonical: 'XAUUSD',
            stage: 'ARMED',
            lastEventAt: 1_800_000_000_000,
          },
        ],
      }),
    });

    expect(shell.view()).toMatchObject({
      connection: 'ready',
      missionTruth: 'current',
      actionable: true,
    });
    expect(shell.view().missions).toHaveLength(1);
    expect((await shell.submitMarketOrder(order)).kind).toBe('sent');
    expect(fetchFn).toHaveBeenCalledTimes(2);

    shell.stop();
    expect(shell.view()).toMatchObject({
      connection: 'stopped',
      missionTruth: 'disconnected',
      actionable: false,
    });
    expect(shell.view().missions).toHaveLength(1);
    expect((await shell.submitMarketOrder(order)).kind).toBe('blocked');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
