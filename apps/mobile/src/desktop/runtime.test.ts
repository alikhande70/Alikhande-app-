import { describe, expect, it, vi } from 'vitest';
import type { DesktopWebSocketLike } from '../../../desktop/src/realtime.js';
import { DesktopMissionRuntime } from '../../../desktop/src/runtime.js';
import type {
  WindowsNativeEd25519Bridge,
  WindowsSignerMetadataStore,
} from '../../../desktop/src/windows-signer.js';

const PUBLIC_KEY = 'QUJDREVGR0hJSktMTU5PUA==';
const SIGNATURE = 'c2lnbmF0dXJlLWJ5dGVzLTAx';

type TestFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function metadataStore(raw: unknown): WindowsSignerMetadataStore {
  return {
    load: vi.fn(async () => raw),
    save: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
}

function bridge(hasKey = true): WindowsNativeEd25519Bridge {
  return {
    hasKey: vi.fn(async () => hasKey),
    generateKey: vi.fn(async () => ({
      publicKey: PUBLIC_KEY,
      protection: 'os-user-protected' as const,
    })),
    sign: vi.fn(async () => SIGNATURE),
    removeKey: vi.fn(async () => undefined),
  };
}

function pairedMetadata() {
  return {
    version: 1,
    keyName: 'keel-desktop-device-v1',
    publicKey: PUBLIC_KEY,
    protection: 'os-user-protected',
    createdAt: 1_800_000_000_000,
  } as const;
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeSocket() {
  const sent: string[] = [];
  const socket: DesktopWebSocketLike = {
    send: vi.fn((data: string) => sent.push(data)),
    close: vi.fn(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return { socket, sent };
}

describe('paired Windows Mission runtime', () => {
  it('restores the existing device key and authenticates the Mission stream', async () => {
    const native = bridge();
    const { socket, sent } = fakeSocket();
    const factory = vi.fn(() => socket);
    const runtime = await DesktopMissionRuntime.restorePaired({
      baseUrl: 'http://127.0.0.1:8787',
      deviceId: 'windows-device-1',
      bridge: native,
      signerStore: metadataStore(pairedMetadata()),
      hashBody: async (body) => `hash:${body}`,
      randomId: () => 'stream-nonce',
      now: () => 1_800_000_000_500,
      websocketFactory: factory,
    });

    expect(runtime.status()).toEqual({ started: false, missionTruth: 'empty', actionable: false });
    runtime.start();
    expect(factory).toHaveBeenCalledWith('ws://127.0.0.1:8787/stream');

    socket.onopen?.();
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(JSON.parse(sent[0] ?? '{}')).toMatchObject({
      type: 'hello',
      topics: ['missions'],
      resume: {},
      auth: {
        deviceId: 'windows-device-1',
        timestamp: 1_800_000_000_500,
        nonce: 'stream-nonce',
      },
    });
    expect(native.generateKey).not.toHaveBeenCalled();
  });

  it('fails closed when a paired device has no signer metadata and never provisions silently', async () => {
    const native = bridge(false);

    await expect(
      DesktopMissionRuntime.restorePaired({
        baseUrl: 'http://127.0.0.1:8787',
        deviceId: 'windows-device-1',
        bridge: native,
        signerStore: metadataStore(undefined),
        hashBody: async (body) => `hash:${body}`,
        randomId: () => 'nonce',
      }),
    ).rejects.toThrow('explicit pairing is required');

    expect(native.generateKey).not.toHaveBeenCalled();
  });

  it('rejects credential-bearing or nested Desk URLs before touching device identity', async () => {
    const native = bridge();
    const store = metadataStore(pairedMetadata());

    await expect(
      DesktopMissionRuntime.restorePaired({
        baseUrl: 'http://user:secret@127.0.0.1:8787',
        deviceId: 'windows-device-1',
        bridge: native,
        signerStore: store,
        hashBody: async () => 'hash',
        randomId: () => 'nonce',
      }),
    ).rejects.toThrow('must not contain credentials');
    await expect(
      DesktopMissionRuntime.restorePaired({
        baseUrl: 'http://127.0.0.1:8787/admin',
        deviceId: 'windows-device-1',
        bridge: native,
        signerStore: store,
        hashBody: async () => 'hash',
        randomId: () => 'nonce',
      }),
    ).rejects.toThrow('Desk origin');

    expect(store.load).not.toHaveBeenCalled();
  });

  it('does not allow a Mission order until realtime supplies a current snapshot', async () => {
    const { socket } = fakeSocket();
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
    const runtime = await DesktopMissionRuntime.restorePaired({
      baseUrl: 'http://127.0.0.1:8787',
      deviceId: 'windows-device-1',
      bridge: bridge(),
      signerStore: metadataStore(pairedMetadata()),
      hashBody: async (body) => `hash:${body}`,
      randomId: () => 'request-nonce',
      fetchFn: fetchFn as typeof fetch,
      websocketFactory: () => socket,
    });
    runtime.start();

    const before = await runtime.operator.submitMarketOrder({
      missionId: 'mission-1',
      intentId: 'intent-1',
      canonical: 'XAUUSD',
      side: 'buy',
      stopPrice: '2440.00',
      note: 'runtime gate',
    });
    expect(before.kind).toBe('blocked');
    expect(fetchFn).not.toHaveBeenCalled();

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'snapshot',
        topic: 'missions',
        seq: 7,
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
    expect(runtime.status()).toEqual({ started: true, missionTruth: 'current', actionable: true });
    expect(runtime.missions()).toHaveLength(1);

    const after = await runtime.operator.submitMarketOrder({
      missionId: 'mission-1',
      intentId: 'intent-1',
      canonical: 'XAUUSD',
      side: 'buy',
      stopPrice: '2440.00',
      note: 'runtime gate',
    });
    expect(after.kind).toBe('sent');
    expect(fetchFn).toHaveBeenCalledTimes(2);

    runtime.stop();
    expect(runtime.status()).toMatchObject({
      started: false,
      missionTruth: 'disconnected',
      actionable: false,
    });
  });
});
