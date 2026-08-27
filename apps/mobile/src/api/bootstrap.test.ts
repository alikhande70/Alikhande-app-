import { beforeEach, describe, expect, it } from 'vitest';
import { useDeskStore } from '../store/desk.js';
import { restoreDeskRuntime, streamUrlFor } from './bootstrap.js';
import { currentDeskClient } from './runtime.js';
import type { SecureSigner, SignerIdentity } from './signer.js';
import type { WebSocketLike } from './socket.js';

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  open(): void {
    this.onopen?.();
  }

  frame(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

class ProvisionedSigner implements SecureSigner {
  readonly identity: SignerIdentity = {
    publicKey: 'pub',
    keyKind: 'ed25519',
    hardwareBacked: false,
  };
  lastCanonical = '';
  lastReason = '';
  lastRequireBiometric = true;

  async sign(
    canonical: string,
    reason: string,
    requireBiometric: boolean,
  ): Promise<string> {
    this.lastCanonical = canonical;
    this.lastReason = reason;
    this.lastRequireBiometric = requireBiometric;
    return 'signature';
  }

  async isProvisioned(): Promise<boolean> {
    return true;
  }

  async provision(): Promise<SignerIdentity> {
    return this.identity;
  }

  async destroy(): Promise<void> {}
}

class MissingSigner extends ProvisionedSigner {
  override async isProvisioned(): Promise<boolean> {
    return false;
  }
}

beforeEach(() => {
  useDeskStore.getState().reset();
});

describe('mobile Desk bootstrap', () => {
  it('derives a stream URL without leaking query material', () => {
    expect(streamUrlFor('https://desk.example.test/api/?token=remove-me#x')).toBe(
      'wss://desk.example.test/api/stream',
    );
    expect(streamUrlFor('http://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787/stream');
  });

  it('refuses to claim a restored pairing when its signing key is gone', async () => {
    await expect(
      restoreDeskRuntime(
        { baseUrl: 'https://desk.example.test', deviceId: 'device-1' },
        {
          signer: new MissingSigner(),
          hashBody: async () => 'hash',
          randomId: () => 'nonce',
        },
      ),
    ).rejects.toThrow('signing key is missing');
    expect(currentDeskClient()).toBeUndefined();
  });

  it('installs the signed client and wires socket truth into the gap-aware store', async () => {
    const ws = new FakeSocket();
    const signer = new ProvisionedSigner();
    let openedUrl = '';
    let now = 1_000;

    const runtime = await restoreDeskRuntime(
      { baseUrl: 'https://desk.example.test', deviceId: 'device-1' },
      {
        signer,
        hashBody: async () => 'hash',
        randomId: () => 'nonce',
        now: () => now,
        socketFactory: (url) => {
          openedUrl = url;
          return ws;
        },
      },
    );

    expect(currentDeskClient()).toBe(runtime.client);
    expect(openedUrl).toBe('wss://desk.example.test/stream');
    expect(useDeskStore.getState().connection).toBe('connecting');

    ws.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(useDeskStore.getState().connection).toBe('connected');
    const hello = JSON.parse(ws.sent[0] ?? '{}') as Record<string, unknown>;
    expect(hello.type).toBe('hello');
    expect(hello.topics).toEqual(
      expect.arrayContaining(['health', 'account', 'positions', 'orders', 'missions']),
    );
    expect(hello.auth).toEqual({
      deviceId: 'device-1',
      timestamp: 1_000,
      nonce: 'nonce',
      signature: 'signature',
    });
    expect(signer.lastCanonical).toBe('keel-v1\nGET\n/stream\n1000\nnonce\nhash\n-');
    expect(signer.lastReason).toBe('Connect to your trading desk');
    expect(signer.lastRequireBiometric).toBe(false);

    ws.frame({
      type: 'snapshot',
      topic: 'missions',
      seq: 7,
      at: 1_100,
      payload: [
        {
          missionId: 'm-1',
          origin: 'scanner',
          canonical: 'XAUUSD',
          timeframe: 'M15',
          trigger: 'scan',
          scanConfigVersion: 'v1',
          stage: 'CANDIDATE',
          observedAt: 900,
          marketState: {},
          intentIds: [],
          positionIds: [],
          actions: [],
          lastEventAt: 900,
        },
      ],
    });

    const state = useDeskStore.getState();
    expect(state.missions).toHaveLength(1);
    expect(state.missions[0]?.missionId).toBe('m-1');
    expect(state.topics.missions).toEqual({ status: 'complete', seq: 7, confirmedAt: 1_100 });

    now = 1_500;
    ws.frame({ type: 'delta', topic: 'missions', seq: 9, upsert: [], remove: [] });
    expect(useDeskStore.getState().topics.missions?.status).toBe('incomplete');
    expect(useDeskStore.getState().gapEvents.at(-1)).toMatchObject({
      topic: 'missions',
      expected: 8,
      got: 9,
    });

    runtime.stop();
    expect(currentDeskClient()).toBeUndefined();
    expect(useDeskStore.getState().connection).toBe('idle');
    // Last-known data survives a transport stop unless the caller is explicitly
    // un-pairing; clearing it by default would hide what was last observed.
    expect(useDeskStore.getState().missions).toHaveLength(1);
  });

  it('can explicitly clear cached truth when un-pairing', async () => {
    const ws = new FakeSocket();
    const runtime = await restoreDeskRuntime(
      { baseUrl: 'http://127.0.0.1:8787', deviceId: 'device-1' },
      {
        signer: new ProvisionedSigner(),
        hashBody: async () => 'hash',
        randomId: () => 'nonce',
        socketFactory: () => ws,
      },
    );

    ws.open();
    await Promise.resolve();
    await Promise.resolve();
    ws.frame({
      type: 'snapshot',
      topic: 'missions',
      seq: 1,
      payload: [
        {
          missionId: 'm-1',
          origin: 'scanner',
          canonical: 'XAUUSD',
          timeframe: 'M15',
          trigger: 'scan',
          scanConfigVersion: 'v1',
          stage: 'OBSERVED',
          observedAt: 1,
          marketState: {},
          intentIds: [],
          positionIds: [],
          actions: [],
          lastEventAt: 1,
        },
      ],
    });
    expect(useDeskStore.getState().missions).toHaveLength(1);

    runtime.stop({ clearState: true });
    expect(useDeskStore.getState().missions).toEqual([]);
    expect(useDeskStore.getState().topics).toEqual({});
  });
});
