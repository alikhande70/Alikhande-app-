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

function client(): DesktopDeskClient {
  return new DesktopDeskClient({
    baseUrl: 'http://127.0.0.1:8787',
    deviceId: 'windows-1',
    signer: { sign: vi.fn(async () => 'signature') },
    hashBody: async (body) => `hash:${body}`,
    randomId: vi.fn().mockReturnValueOnce('nonce-1').mockReturnValueOnce('nonce-2'),
    now: () => 1_800_000_000_000,
    fetchFn: vi.fn() as unknown as typeof fetch,
  });
}

const mission = {
  missionId: 'mission-1',
  canonical: 'XAUUSD',
  stage: 'ARMED',
  lastEventAt: 1_800_000_000_000,
};

describe('Windows/Desktop Mission reconnect proof', () => {
  it('does not trust a pre-disconnect sequence when reconnecting with no server changes', async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const reconnects: Array<() => void> = [];
    const truth = new DesktopMissionTruth();
    const runtime = new DesktopMissionRealtime({
      url: 'ws://127.0.0.1:8787/stream',
      client: client(),
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
    await vi.waitFor(() => expect(first.sent.length).toBeGreaterThan(0));
    first.receive({ type: 'snapshot', topic: 'missions', seq: 7, payload: [mission] });
    expect(truth.status).toBe('current');
    expect(truth.sequence).toBe(7);

    first.onclose?.();
    expect(truth.status).toBe('disconnected');

    reconnects[0]?.();
    second.open();
    await vi.waitFor(() => expect(second.sent.length).toBeGreaterThan(0));

    const hello = JSON.parse(second.sent[0] ?? '{}') as Record<string, unknown>;
    expect(hello).toMatchObject({ type: 'hello', topics: ['missions'], resume: {} });
    expect(truth.canSubmit('mission-1', 'XAUUSD').ok).toBe(false);

    // Even when the Desk sequence did not advance while offline, only a fresh
    // snapshot restores consequential use.
    second.receive({ type: 'snapshot', topic: 'missions', seq: 7, payload: [mission] });
    expect(truth.status).toBe('current');
    expect(truth.canSubmit('mission-1', 'XAUUSD').ok).toBe(true);
  });
});
