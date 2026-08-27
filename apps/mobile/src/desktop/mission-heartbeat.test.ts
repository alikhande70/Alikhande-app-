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
    randomId: () => 'stream-nonce',
    now: () => 1_800_000_000_000,
    fetchFn: vi.fn() as unknown as typeof fetch,
  });
}

describe('Windows/Desktop Mission heartbeat', () => {
  it('honours the Desk heartbeat interval so an authenticated stream is not reaped', async () => {
    const socket = new FakeSocket();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const runtime = new DesktopMissionRealtime({
      url: 'ws://127.0.0.1:8787/stream',
      client: client(),
      truth: new DesktopMissionTruth(),
      factory: () => socket,
      now: () => 1_800_000_000_500,
      setTimeoutFn: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimeoutFn: () => undefined,
    });

    runtime.connect();
    socket.open();
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));

    socket.receive({ type: 'welcome', heartbeatIntervalMs: 20_000 });
    expect(timers.at(-1)?.ms).toBe(20_000);

    timers.at(-1)?.fn();
    expect(socket.sent.map((text) => JSON.parse(text))).toContainEqual({
      type: 'ping',
      clientTime: 1_800_000_000_500,
    });
    expect(timers.at(-1)?.ms).toBe(20_000);
  });
});
