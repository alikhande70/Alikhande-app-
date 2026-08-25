import { describe, expect, it, vi } from 'vitest';
import { DeskSocket, checkContiguity } from './socket.js';
import type { ConnectionState, SocketEvents, WebSocketLike } from './socket.js';

/**
 * The client's gap detection.
 *
 * These tests exist because the failure they guard is invisible: a client that
 * silently accepts a delta after a gap shows a position list that is missing a
 * fill, and nothing on screen says so. Every assertion here is about the app
 * refusing to render state it cannot prove is complete.
 */

class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
  }

  /** Drive the socket from a test. */
  open(): void {
    this.onopen?.();
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  drop(): void {
    this.onclose?.();
  }
}

interface Harness {
  socket: DeskSocket;
  fake: FakeSocket;
  snapshots: Array<{ topic: string; seq: number; payload: unknown }>;
  deltas: Array<{ topic: string; seq: number; upsert: unknown }>;
  gaps: Array<{ topic: string; expected: number; got: number }>;
  states: Array<{ state: ConnectionState; detail?: string }>;
  latencies: Array<{ rtt: number; offset: number }>;
}

function harness(): Harness {
  const fake = new FakeSocket();
  const snapshots: Harness['snapshots'] = [];
  const deltas: Harness['deltas'] = [];
  const gaps: Harness['gaps'] = [];
  const states: Harness['states'] = [];
  const latencies: Harness['latencies'] = [];

  const events: SocketEvents = {
    onSnapshot: (topic, seq, payload) => snapshots.push({ topic, seq, payload }),
    onDelta: (topic, seq, upsert) => deltas.push({ topic, seq, upsert }),
    onGap: (topic, expected, got) => gaps.push({ topic, expected, got }),
    onState: (state, detail) => states.push({ state, ...(detail !== undefined ? { detail } : {}) }),
    onLatency: (rtt, offset) => latencies.push({ rtt, offset }),
  };

  const socket = new DeskSocket({
    url: 'ws://desk/stream',
    topics: ['positions', 'orders'],
    events,
    factory: () => fake,
    now: () => 1_000_000,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => undefined,
  });

  return { socket, fake, snapshots, deltas, gaps, states, latencies };
}

describe('contiguity', () => {
  it('accepts the first frame at any sequence', () => {
    expect(checkContiguity(undefined, 500)).toEqual({ ok: true });
  });

  it('accepts exactly the next sequence', () => {
    expect(checkContiguity(41, 42)).toEqual({ ok: true });
  });

  it('separates a gap from a duplicate from a regression', () => {
    expect(checkContiguity(41, 44)).toEqual({ ok: false, reason: 'gap', expected: 42 });
    expect(checkContiguity(41, 41)).toEqual({ ok: false, reason: 'duplicate', expected: 42 });
    expect(checkContiguity(41, 3)).toEqual({ ok: false, reason: 'regression', expected: 42 });
  });
});

describe('handshake', () => {
  it('presents the sequences it holds so the desk can replay only the gap', () => {
    const h = harness();
    h.socket.connect();
    h.fake.open();
    h.fake.deliver({ type: 'snapshot', topic: 'positions', seq: 10, payload: [] });
    h.fake.deliver({ type: 'delta', topic: 'positions', seq: 11, upsert: [] });

    h.fake.drop();
    h.socket.connect();
    h.fake.open();

    const hellos = h.fake.sent.filter((m) => (m as { type: string }).type === 'hello');
    const last = hellos[hellos.length - 1] as { resume: Record<string, number> };
    expect(last.resume.positions).toBe(11);
  });
});

describe('applying updates', () => {
  it('applies a snapshot and then contiguous deltas', () => {
    const h = harness();
    h.socket.connect();
    h.fake.open();
    h.fake.deliver({ type: 'snapshot', topic: 'positions', seq: 1, payload: ['a'] });
    h.fake.deliver({ type: 'delta', topic: 'positions', seq: 2, upsert: ['b'] });
    h.fake.deliver({ type: 'delta', topic: 'positions', seq: 3, upsert: ['c'] });

    expect(h.snapshots).toHaveLength(1);
    expect(h.deltas.map((d) => d.seq)).toEqual([2, 3]);
    expect(h.socket.sequences.get('positions')).toBe(3);
    expect(h.gaps).toHaveLength(0);
  });

  it('refuses to apply a delta after a gap, and asks for a fresh snapshot', () => {
    const h = harness();
    h.socket.connect();
    h.fake.open();
    h.fake.deliver({ type: 'snapshot', topic: 'positions', seq: 1, payload: [] });
    h.fake.deliver({ type: 'delta', topic: 'positions', seq: 5, upsert: ['missed'] });

    // The delta was NOT applied — that is the whole point.
    expect(h.deltas).toHaveLength(0);
    expect(h.gaps).toEqual([{ topic: 'positions', expected: 2, got: 5 }]);
    // And the client asked for the topic again.
    const subs = h.fake.sent.filter((m) => (m as { type: string }).type === 'subscribe');
    expect(subs).toHaveLength(1);
  });

  it('reports itself as resyncing while a topic is incomplete', () => {
    const h = harness();
    h.socket.connect();
    h.fake.open();
    h.fake.deliver({ type: 'snapshot', topic: 'positions', seq: 1, payload: [] });
    h.fake.deliver({ type: 'delta', topic: 'positions', seq: 9, upsert: [] });

    expect(h.socket.connectionState).toBe('resyncing');
    // ...and returns to connected only once the snapshot lands.
    h.fake.deliver({ type: 'snapshot', topic: 'positions', seq: 9, payload: [] });
    expect(h.socket.connectionState).toBe('connected');
  });

  it('ignores a duplicate delta without resyncing', () => {
    const h = harness();
    h.socket.connect();
    h.fake.open();
    h.fake.deliver({ type: 'snapshot', topic: 'positions', seq: 1, payload: [] });
    h.fake.deliver({ type: 'delta', topic: 'positions', seq: 2, upsert: ['x'] });
    h.fake.deliver({ type: 'delta', topic: 'positions', seq: 2, upsert: ['x'] });

    expect(h.deltas).toHaveLength(1);
    expect(h.gaps).toHaveLength(0);
    expect(h.socket.connectionState).toBe('connected');
  });

  it('treats a sequence regression as a gap — the desk restarted', () => {
    const h = harness();
    h.socket.connect();
    h.fake.open();
    h.fake.deliver({ type: 'snapshot', topic: 'orders', seq: 50, payload: [] });
    h.fake.deliver({ type: 'delta', topic: 'orders', seq: 2, upsert: [] });

    expect(h.deltas).toHaveLength(0);
    expect(h.gaps[0]?.topic).toBe('orders');
  });

  it('keeps topics independent — a gap on one does not disturb the other', () => {
    const h = harness();
    h.socket.connect();
    h.fake.open();
    h.fake.deliver({ type: 'snapshot', topic: 'positions', seq: 1, payload: [] });
    h.fake.deliver({ type: 'snapshot', topic: 'orders', seq: 1, payload: [] });
    h.fake.deliver({ type: 'delta', topic: 'positions', seq: 7, upsert: [] });
    h.fake.deliver({ type: 'delta', topic: 'orders', seq: 2, upsert: ['ok'] });

    expect(h.gaps.map((g) => g.topic)).toEqual(['positions']);
    expect(h.deltas.map((d) => d.topic)).toEqual(['orders']);
    expect(h.socket.sequences.get('orders')).toBe(2);
    expect(h.socket.sequences.has('positions')).toBe(false);
  });
});

describe('server-initiated resync', () => {
  it('marks the topic incomplete and forgets its sequence', () => {
    const h = harness();
    h.socket.connect();
    h.fake.open();
    h.fake.deliver({ type: 'snapshot', topic: 'positions', seq: 4, payload: [] });
    h.fake.deliver({
      type: 'resync',
      topic: 'positions',
      reason: 'buffer-expired',
      detail: 'resume point too old',
    });

    expect(h.socket.sequences.has('positions')).toBe(false);
    expect(h.socket.connectionState).toBe('resyncing');
    expect(h.states.some((s) => s.detail === 'resume point too old')).toBe(true);
  });
});

describe('liveness', () => {
  it('measures round trip and clock offset from a pong', () => {
    let now = 1_000_000;
    let fired = false;
    const fake = new FakeSocket();
    const latencies: Array<{ rtt: number; offset: number }> = [];
    const socket = new DeskSocket({
      url: 'ws://desk/stream',
      topics: ['health'],
      events: {
        onSnapshot: () => undefined,
        onDelta: () => undefined,
        onGap: () => undefined,
        onState: () => undefined,
        onLatency: (rtt, offset) => latencies.push({ rtt, offset }),
      },
      factory: () => fake,
      now: () => now,
      setTimeoutFn: (fn) => {
        // Fire only the first scheduled heartbeat, so the test observes one
        // ping. Letting every reschedule fire synchronously would recurse.
        if (!fired) {
          fired = true;
          fn();
        }
        return 0;
      },
      clearTimeoutFn: () => undefined,
    });
    socket.connect();
    fake.open();

    const ping = fake.sent.find((m) => (m as { type: string }).type === 'ping') as {
      clientTime: number;
    };
    expect(ping).toBeDefined();

    now = 1_000_100; // 100ms round trip
    fake.deliver({ type: 'pong', serverTime: 1_000_050, clientTime: ping.clientTime });

    expect(latencies[0]?.rtt).toBe(100);
    // The desk's clock at the midpoint matches ours, so the offset is zero.
    expect(latencies[0]?.offset).toBe(0);
  });

  it('reconnects after a drop and does not when closed deliberately', () => {
    const h = harness();
    const reconnects = vi.fn();
    h.socket.connect();
    h.fake.open();
    h.fake.drop();
    expect(h.states.some((s) => s.state === 'disconnected')).toBe(true);

    h.socket.close();
    const before = h.states.length;
    h.fake.drop();
    // A close handler after a deliberate close must not restart anything.
    expect(h.states.length).toBe(before);
    expect(reconnects).not.toHaveBeenCalled();
  });
});
