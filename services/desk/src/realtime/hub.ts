import type { Logger } from 'pino';
import type { Clock } from '../sim/clock.js';

/**
 * The realtime hub (ADR-0008).
 *
 * Every topic carries a monotonic sequence number and a bounded ring of recent
 * deltas. A client that reconnects presents its last sequence; if the ring still
 * covers it, the gap is replayed, and if it does not, the client is told to
 * resync and handed a fresh snapshot.
 *
 * Either way the client ends up provably complete. That is the entire point:
 * without sequence numbers a client cannot distinguish a quiet market from a
 * dead socket, and those two states look identical right up until the moment
 * one of them costs money.
 */

export interface Frame {
  readonly seq: number;
  readonly at: number;
  readonly payload: unknown;
  readonly removed: readonly string[];
}

export interface HubOptions {
  readonly clock: Clock;
  readonly log: Logger;
  /** Deltas retained per topic. Beyond this a resume forces a snapshot. */
  readonly bufferSize?: number;
  /** How long a delta stays replayable. */
  readonly bufferMs?: number;
  /** Client must ping within this or be dropped. */
  readonly heartbeatIntervalMs?: number;
  /** Max frames buffered for a slow client before it is disconnected. */
  readonly maxClientBacklog?: number;
}

export interface Subscriber {
  readonly id: string;
  send(text: string): void;
  close(code: number, reason: string): void;
}

interface TopicState {
  seq: number;
  frames: Frame[];
  snapshot: () => unknown;
}

interface ClientState {
  readonly subscriber: Subscriber;
  readonly topics: Map<string, number>;
  lastSeenAt: number;
  backlog: number;
  closed: boolean;
}

export class RealtimeHub {
  private readonly topics = new Map<string, TopicState>();
  private readonly clients = new Map<string, ClientState>();
  private cancelReaper: (() => void) | undefined;

  constructor(private readonly opts: HubOptions) {}

  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Register a topic and how to produce its full state.
   *
   * The snapshot function is called lazily, only when a client actually needs
   * one — a desk with no client connected should not be serialising positions
   * every second.
   */
  registerTopic(topic: string, snapshot: () => unknown): void {
    if (this.topics.has(topic)) {
      const existing = this.topics.get(topic) as TopicState;
      this.topics.set(topic, { ...existing, snapshot });
      return;
    }
    this.topics.set(topic, { seq: 0, frames: [], snapshot });
  }

  hasTopic(topic: string): boolean {
    return this.topics.has(topic);
  }

  currentSeq(topic: string): number {
    return this.topics.get(topic)?.seq ?? 0;
  }

  start(): void {
    this.cancelReaper = this.opts.clock.setInterval(() => this.reap(), 10_000);
  }

  stop(): void {
    this.cancelReaper?.();
    this.cancelReaper = undefined;
    for (const id of [...this.clients.keys()]) this.disconnect(id, 1001, 'desk stopping');
  }

  // --- Clients --------------------------------------------------------------

  connect(subscriber: Subscriber): void {
    this.clients.set(subscriber.id, {
      subscriber,
      topics: new Map(),
      lastSeenAt: this.opts.clock.now(),
      backlog: 0,
      closed: false,
    });
    this.send(subscriber.id, {
      type: 'welcome',
      serverTime: this.opts.clock.now(),
      deskVersion: process.env.KEEL_VERSION ?? '0.1.0',
      deltaBufferMs: this.opts.bufferMs ?? 120_000,
      heartbeatIntervalMs: this.opts.heartbeatIntervalMs ?? 20_000,
    });
  }

  disconnect(clientId: string, code = 1000, reason = 'closed'): void {
    const client = this.clients.get(clientId);
    if (client === undefined) return;
    client.closed = true;
    this.clients.delete(clientId);
    try {
      client.subscriber.close(code, reason);
    } catch {
      /* already gone */
    }
  }

  touch(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client !== undefined) client.lastSeenAt = this.opts.clock.now();
  }

  /**
   * Subscribe a client, honouring a resume point where possible.
   *
   * `resumeFrom` is the last sequence the client believes it holds. When the
   * ring still covers `resumeFrom + 1`, the missing frames are replayed and the
   * client keeps its state. Otherwise it gets a `resync` followed by a full
   * snapshot — never a silent jump, because a silent jump is indistinguishable
   * from no data having been missed.
   */
  subscribe(clientId: string, topic: string, resumeFrom?: number): void {
    const client = this.clients.get(clientId);
    const state = this.topics.get(topic);
    if (client === undefined) return;
    if (state === undefined) {
      this.send(clientId, {
        type: 'error',
        code: 'UNKNOWN_TOPIC',
        detail: `no such topic: ${topic}`,
        fatal: false,
      });
      return;
    }

    if (resumeFrom !== undefined && resumeFrom > 0) {
      const oldest = state.frames[0]?.seq;
      if (resumeFrom > state.seq) {
        // The client claims a sequence ahead of ours: we restarted and its
        // history belongs to a previous incarnation. It must start over.
        this.resync(
          clientId,
          topic,
          'server-restart',
          `client held seq ${resumeFrom}, desk is at ${state.seq}`,
        );
        this.sendSnapshot(clientId, topic, state);
        client.topics.set(topic, state.seq);
        return;
      }
      if (oldest !== undefined && resumeFrom + 1 >= oldest) {
        const missed = state.frames.filter((f) => f.seq > resumeFrom);
        for (const f of missed) this.sendDelta(clientId, topic, f);
        client.topics.set(topic, state.seq);
        return;
      }
      this.resync(
        clientId,
        topic,
        'buffer-expired',
        `resume point ${resumeFrom} is older than the retained buffer`,
      );
    } else if (resumeFrom === undefined) {
      this.resync(clientId, topic, 'subscription-new', 'first subscription to this topic');
    }

    this.sendSnapshot(clientId, topic, state);
    client.topics.set(topic, state.seq);
  }

  unsubscribe(clientId: string, topic: string): void {
    this.clients.get(clientId)?.topics.delete(topic);
  }

  // --- Publishing -----------------------------------------------------------

  /**
   * Publish an incremental update.
   *
   * Deltas for orders, positions and fills are strictly gap-free. Quote topics
   * are conflated for rendering, but conflation is applied by the *caller* for
   * quotes only — never here, and never to anything that affects position state.
   */
  publish(topic: string, payload: unknown, removed: readonly string[] = []): void {
    const state = this.topics.get(topic);
    if (state === undefined) {
      this.opts.log.warn({ topic }, 'publish to an unregistered topic');
      return;
    }
    state.seq += 1;
    const frame: Frame = { seq: state.seq, at: this.opts.clock.now(), payload, removed };
    state.frames.push(frame);

    const maxFrames = this.opts.bufferSize ?? 512;
    const maxAge = this.opts.bufferMs ?? 120_000;
    const cutoff = frame.at - maxAge;
    while (
      state.frames.length > maxFrames ||
      (state.frames[0] !== undefined && state.frames[0].at < cutoff)
    ) {
      state.frames.shift();
    }

    for (const [clientId, client] of this.clients) {
      if (!client.topics.has(topic)) continue;
      this.sendDelta(clientId, topic, frame);
      client.topics.set(topic, frame.seq);
    }
  }

  /** Force every subscriber of a topic to take a fresh snapshot. */
  republish(topic: string, reason: string): void {
    const state = this.topics.get(topic);
    if (state === undefined) return;
    for (const [clientId, client] of this.clients) {
      if (!client.topics.has(topic)) continue;
      this.resync(clientId, topic, 'gap', reason);
      this.sendSnapshot(clientId, topic, state);
      client.topics.set(topic, state.seq);
    }
  }

  // --- Wire ----------------------------------------------------------------

  private sendSnapshot(clientId: string, topic: string, state: TopicState): void {
    this.send(clientId, {
      type: 'snapshot',
      topic,
      seq: state.seq,
      at: this.opts.clock.now(),
      payload: state.snapshot(),
    });
  }

  private sendDelta(clientId: string, topic: string, frame: Frame): void {
    this.send(clientId, {
      type: 'delta',
      topic,
      seq: frame.seq,
      at: frame.at,
      upsert: frame.payload,
      remove: frame.removed,
    });
  }

  private resync(clientId: string, topic: string, reason: string, detail: string): void {
    this.send(clientId, { type: 'resync', topic, reason, detail });
  }

  private send(clientId: string, message: unknown): void {
    const client = this.clients.get(clientId);
    if (client === undefined || client.closed) return;

    // A client that cannot keep up is disconnected rather than buffered without
    // limit. Unbounded buffering turns one slow phone into a desk that runs out
    // of memory — and the client's own resume logic makes reconnecting safe.
    const maxBacklog = this.opts.maxClientBacklog ?? 2_000;
    if (client.backlog > maxBacklog) {
      this.opts.log.warn({ clientId, backlog: client.backlog }, 'client too slow; disconnecting');
      this.disconnect(clientId, 1013, 'client too slow');
      return;
    }

    try {
      client.backlog += 1;
      client.subscriber.send(JSON.stringify(message));
      client.backlog -= 1;
    } catch (err) {
      this.opts.log.warn(
        { clientId, err: err instanceof Error ? err.message : String(err) },
        'send failed; dropping client',
      );
      this.disconnect(clientId, 1011, 'send failed');
    }
  }

  /** Drop clients that have stopped heartbeating. */
  private reap(): void {
    const timeout = (this.opts.heartbeatIntervalMs ?? 20_000) * 3;
    const now = this.opts.clock.now();
    for (const [id, client] of this.clients) {
      if (now - client.lastSeenAt > timeout) {
        this.opts.log.info({ clientId: id }, 'client heartbeat timed out');
        this.disconnect(id, 1001, 'heartbeat timeout');
      }
    }
  }
}
