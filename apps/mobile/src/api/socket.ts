/**
 * The realtime client.
 *
 * The whole reason this file is not thirty lines of `onmessage` is gap
 * detection. A mobile socket drops constantly — cell to wifi, a tunnel, iOS
 * suspending the app — and a client that simply reconnects and carries on has
 * no way to know whether anything happened while it was away. A missed fill is
 * a wrong position on the screen.
 *
 * So: every topic carries a sequence number, the client asserts contiguity, and
 * any gap forces a resnapshot of that topic. The client never interpolates and
 * never assumes quiet means nothing happened.
 */

export type TopicName = string;

export interface SocketFrame {
  readonly type: string;
  readonly topic?: string;
  readonly seq?: number;
  readonly at?: number;
  readonly payload?: unknown;
  readonly upsert?: unknown;
  readonly remove?: readonly string[];
  readonly reason?: string;
  readonly detail?: string;
  readonly serverTime?: number;
  readonly clientTime?: number;
  readonly heartbeatIntervalMs?: number;
}

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  /** Socket is up but at least one topic is mid-resync; state is incomplete. */
  | 'resyncing'
  | 'disconnected';

export interface SocketEvents {
  /** A full replacement for a topic. Always safe to apply over anything. */
  onSnapshot: (topic: string, seq: number, payload: unknown, at: number) => void;
  /** An incremental update, already proven contiguous. */
  onDelta: (topic: string, seq: number, upsert: unknown, remove: readonly string[], at: number) => void;
  onState: (state: ConnectionState, detail?: string) => void;
  /**
   * A gap was detected locally. Distinct from a server-sent resync, because it
   * means the *client* noticed something the server thought it had delivered —
   * worth surfacing, since it usually indicates a transport problem.
   */
  onGap: (topic: string, expected: number, got: number) => void;
  /** Round-trip time and clock offset against the desk. */
  onLatency: (rttMs: number, clockOffsetMs: number) => void;
}

export interface SocketOptions {
  readonly url: string;
  readonly topics: readonly string[];
  readonly events: SocketEvents;
  /** Injected so tests can drive a fake socket. */
  readonly factory?: (url: string) => WebSocketLike;
  readonly now?: () => number;
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  readonly maxReconnectDelayMs?: number;
}

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/**
 * Contiguity check, shared in shape with the desk's.
 *
 * A duplicate and a gap are different problems: a duplicate is harmless and
 * ignorable, a gap means data was lost. Collapsing them into "unexpected" would
 * either spam resyncs or hide real loss.
 */
export function checkContiguity(
  lastSeq: number | undefined,
  incoming: number,
): { ok: true } | { ok: false; reason: 'gap' | 'duplicate' | 'regression'; expected: number } {
  if (lastSeq === undefined) return { ok: true };
  const expected = lastSeq + 1;
  if (incoming === expected) return { ok: true };
  if (incoming === lastSeq) return { ok: false, reason: 'duplicate', expected };
  if (incoming < lastSeq) return { ok: false, reason: 'regression', expected };
  return { ok: false, reason: 'gap', expected };
}

export class DeskSocket {
  private ws: WebSocketLike | undefined;
  private state: ConnectionState = 'idle';
  private readonly lastSeq = new Map<string, number>();
  private readonly resyncing = new Set<string>();
  private attempt = 0;
  private closing = false;
  private heartbeat: unknown;
  private reconnectHandle: unknown;
  private lastPingAt = 0;

  private readonly now: () => number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (h: unknown) => void;

  constructor(private readonly opts: SocketOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.setT = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  /** Sequence numbers held per topic — the client's proof of completeness. */
  get sequences(): ReadonlyMap<string, number> {
    return this.lastSeq;
  }

  connect(): void {
    this.closing = false;
    this.open();
  }

  close(): void {
    this.closing = true;
    this.clearT(this.heartbeat);
    this.clearT(this.reconnectHandle);
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = undefined;
    this.setState('idle');
  }

  private setState(s: ConnectionState, detail?: string): void {
    if (this.state === s) return;
    this.state = s;
    this.opts.events.onState(s, detail);
  }

  private open(): void {
    this.setState('connecting');
    const factory = this.opts.factory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    let ws: WebSocketLike;
    try {
      ws = factory(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.setState('connected');
      // Present what we hold, so the desk can replay only what we missed. This
      // is what makes a backgrounded phone cheap to bring back.
      const resume: Record<string, number> = {};
      for (const [topic, seq] of this.lastSeq) resume[topic] = seq;
      this.send({
        type: 'hello',
        protocolVersion: 1,
        clientVersion: '0.1.0',
        topics: this.opts.topics,
        resume,
      });
      this.startHeartbeat();
    };

    ws.onmessage = (ev) => {
      let frame: SocketFrame;
      try {
        frame = JSON.parse(String(ev.data)) as SocketFrame;
      } catch {
        return;
      }
      this.handle(frame);
    };

    ws.onclose = () => {
      this.clearT(this.heartbeat);
      if (this.closing) return;
      this.setState('disconnected', 'socket closed');
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // `onclose` follows, and that is where reconnection is handled. Doing it
      // in both would double the backoff schedule.
    };
  }

  private handle(frame: SocketFrame): void {
    switch (frame.type) {
      case 'welcome':
        if (typeof frame.heartbeatIntervalMs === 'number') {
          this.startHeartbeat(frame.heartbeatIntervalMs);
        }
        break;

      case 'snapshot': {
        const topic = frame.topic;
        if (topic === undefined || typeof frame.seq !== 'number') return;
        this.lastSeq.set(topic, frame.seq);
        this.resyncing.delete(topic);
        if (this.resyncing.size === 0 && this.state === 'resyncing') this.setState('connected');
        this.opts.events.onSnapshot(topic, frame.seq, frame.payload, frame.at ?? this.now());
        break;
      }

      case 'delta': {
        const topic = frame.topic;
        if (topic === undefined || typeof frame.seq !== 'number') return;
        const check = checkContiguity(this.lastSeq.get(topic), frame.seq);
        if (!check.ok) {
          if (check.reason === 'duplicate') return; // harmless
          // A gap or a regression means our view is not provably complete. Say
          // so and ask for a fresh snapshot rather than applying the delta.
          this.opts.events.onGap(topic, check.expected, frame.seq);
          this.requestResync(topic);
          return;
        }
        this.lastSeq.set(topic, frame.seq);
        this.opts.events.onDelta(
          topic,
          frame.seq,
          frame.upsert,
          frame.remove ?? [],
          frame.at ?? this.now(),
        );
        break;
      }

      case 'resync': {
        const topic = frame.topic;
        if (topic === undefined) return;
        // The server is about to send a snapshot. Mark the topic incomplete so
        // the UI can say so rather than showing possibly-stale rows as current.
        this.resyncing.add(topic);
        this.lastSeq.delete(topic);
        this.setState('resyncing', frame.detail ?? frame.reason);
        break;
      }

      case 'pong': {
        const rtt = this.now() - this.lastPingAt;
        const serverTime = frame.serverTime ?? 0;
        // Assume symmetric latency: the desk's clock at the midpoint of the
        // round trip is the best estimate we have without a real time protocol.
        const offset = serverTime - (this.lastPingAt + rtt / 2);
        this.opts.events.onLatency(rtt, Math.round(offset));
        break;
      }

      default:
        break;
    }
  }

  /** Drop our sequence for a topic and ask for a fresh snapshot. */
  private requestResync(topic: string): void {
    this.resyncing.add(topic);
    this.lastSeq.delete(topic);
    this.setState('resyncing', `gap on ${topic}`);
    this.send({ type: 'subscribe', topics: [topic] });
  }

  private startHeartbeat(intervalMs = 15_000): void {
    this.clearT(this.heartbeat);
    const beat = (): void => {
      if (this.closing) return;
      this.lastPingAt = this.now();
      this.send({ type: 'ping', clientTime: this.lastPingAt });
      this.heartbeat = this.setT(beat, intervalMs);
    };
    this.heartbeat = this.setT(beat, intervalMs);
  }

  /**
   * Reconnect with exponential backoff and jitter, capped.
   *
   * The cap matters on mobile: a phone that has been in a tunnel for an hour
   * should come back within seconds of regaining signal, not wait out a backoff
   * that grew while nobody was watching.
   */
  private scheduleReconnect(): void {
    if (this.closing) return;
    const attempt = Math.min(this.attempt++, 6);
    const base = Math.min(this.opts.maxReconnectDelayMs ?? 15_000, 500 * 2 ** attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    this.reconnectHandle = this.setT(() => this.open(), delay);
  }

  private send(payload: unknown): void {
    try {
      this.ws?.send(JSON.stringify(payload));
    } catch {
      /* the close handler will reconnect */
    }
  }

  /** Called when the app returns to the foreground. */
  resume(): void {
    if (this.closing) return;
    if (this.state === 'connected' || this.state === 'resyncing') {
      // The socket may look alive but be a zombie after a suspension. A ping
      // that goes unanswered will trip the close handler.
      this.lastPingAt = this.now();
      this.send({ type: 'ping', clientTime: this.lastPingAt });
      return;
    }
    this.attempt = 0;
    this.open();
  }
}
