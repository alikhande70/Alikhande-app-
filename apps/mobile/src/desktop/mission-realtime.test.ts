import { describe, expect, it, vi } from 'vitest';
import { DesktopDeskClient } from '../../../desktop/src/client.js';
import { DesktopMissionTruth } from '../../../desktop/src/mission-truth.js';
import {
  DesktopMissionRealtime,
  type DesktopWebSocketLike,
} from '../../../desktop/src/realtime.js';

class FakeSocket implements DesktopWebSocketLike {
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.();
  }

  open(): void {
    this.onopen?.();
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function makeClient(randomId = vi.fn(() => 'nonce-1')) {
  return new DesktopDeskClient({
    baseUrl: 'http://127.0.0.1:8787',
    deviceId: 'windows-1',
    signer: { sign: vi.fn(async () => 'signature') },
    hashBody: async (body) => `hash:${body}`,
    randomId,
    now: () => 1_800_000_000_000,
    clockOffsetMs: () => 250,
    fetchFn: vi.fn() as unknown as typeof fetch,
  });
}

const mission = {
  missionId: 'mission-1',
  canonical: 'XAUUSD',
  stage: 'ARMED',
  lastEventAt: 1_800_000_000_000,
};

describe('Windows/Desktop Mission realtime', () => {
  it('authenticates with the same signed identity and subscribes only to missions', async () => {
    const socket = new FakeSocket();
    const randomId = vi.fn(() => 'stream-nonce');
    const client = makeClient(randomId);
    const truth = new DesktopMissionTruth();
    const runtime = new DesktopMissionRealtime({
      url: 'ws://127.0.0.1:8787/stream',
      client,
      truth,
      factory: () => socket,
    });

    runtime.connect();
    socket.open();
    await Promise.resolve();
    await Promise.resolve();

    expect(randomId).toHaveBeenCalledTimes(1);
    const hello = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
    expect(hello).toMatchObject({
      type: 'hello',
      topics: ['missions'],
      resume: {},
      auth: {
        deviceId: 'windows-1',
        timestamp: 1_800_000_000_250,
        nonce: 'stream-nonce',
        signature: 'signature',
      },
    });
  });

  it('turns a server snapshot into current Mission truth', async () => {
    const socket = new FakeSocket();
    const truth = new DesktopMissionTruth();
    const runtime = new DesktopMissionRealtime({
      url: 'ws://127.0.0.1:8787/stream',
      client: makeClient(),
      truth,
      factory: () => socket,
    });

    runtime.connect();
    socket.open();
    await Promise.resolve();
    await Promise.resolve();
    socket.receive({ type: 'snapshot', topic: 'missions', seq: 7, payload: [mission] });

    expect(truth.status).toBe('current');
    expect(truth.sequence).toBe(7);
    expect(truth.canSubmit('mission-1', 'XAUUSD').ok).toBe(true);
  });

  it('marks truth incomplete and requests a snapshot on a sequence gap', async () => {
    const socket = new FakeSocket();
    const truth = new DesktopMissionTruth();
    const runtime = new DesktopMissionRealtime({
      url: 'ws://127.0.0.1:8787/stream',
      client: makeClient(),
      truth,
      factory: () => socket,
    });

    runtime.connect();
    socket.open();
    await Promise.resolve();
    await Promise.resolve();
    socket.receive({ type: 'snapshot', topic: 'missions', seq: 4, payload: [mission] });
    socket.receive({
      type: 'delta',
      topic: 'missions',
      seq: 6,
      upsert: [{ ...mission, stage: 'EXECUTING' }],
      remove: [],
    });

    expect(truth.status).toBe('incomplete');
    expect(truth.list()[0]?.stage).toBe('ARMED');
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: 'subscribe',
      topics: ['missions'],
    });
  });

  it('keeps last-known rows but blocks consequential use after disconnect', async () => {
    const socket = new FakeSocket();
    const truth = new DesktopMissionTruth();
    const runtime = new DesktopMissionRealtime({
      url: 'ws://127.0.0.1:8787/stream',
      client: makeClient(),
      truth,
      factory: () => socket,
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => undefined,
    });

    runtime.connect();
    socket.open();
    await Promise.resolve();
    await Promise.resolve();
    socket.receive({ type: 'snapshot', topic: 'missions', seq: 1, payload: [mission] });
    socket.onclose?.();

    expect(truth.status).toBe('disconnected');
    expect(truth.list()).toEqual([mission]);
    expect(truth.canSubmit('mission-1', 'XAUUSD')).toMatchObject({ ok: false });
  });

  it('never lets a late authentication proof from an old socket authenticate a replacement', async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    let resolveFirst: ((value: string) => void) | undefined;
    const signer = {
      sign: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValueOnce('new-signature'),
    };
    const client = new DesktopDeskClient({
      baseUrl: 'http://127.0.0.1:8787',
      deviceId: 'windows-1',
      signer,
      hashBody: async (body) => `hash:${body}`,
      randomId: vi.fn().mockReturnValueOnce('old-nonce').mockReturnValueOnce('new-nonce'),
      now: () => 1_800_000_000_000,
      fetchFn: vi.fn() as unknown as typeof fetch,
    });
    const truth = new DesktopMissionTruth();
    const reconnects: Array<() => void> = [];
    const runtime = new DesktopMissionRealtime({
      url: 'ws://127.0.0.1:8787/stream',
      client,
      truth,
      factory: () => sockets.shift() as FakeSocket,
      setTimeoutFn: (fn) => {
        reconnects.push(fn);
        return reconnects.length;
      },
      clearTimeoutFn: () => undefined,
    });

    runtime.connect();
    first.open();
    first.onclose?.();
    reconnects[0]?.();
    second.open();
    await Promise.resolve();
    await Promise.resolve();
    resolveFirst?.('old-signature');
    await Promise.resolve();
    await Promise.resolve();

    expect(first.sent).toEqual([]);
    const hello = JSON.parse(second.sent[0] ?? '{}') as Record<string, unknown>;
    expect(hello).toMatchObject({ auth: { nonce: 'new-nonce', signature: 'new-signature' } });
  });
});
