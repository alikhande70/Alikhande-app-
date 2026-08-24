import { z } from 'zod';
import {
  Alert,
  AccountSnapshot,
  DeskHealth,
  Divergence,
  DrawdownStatus,
  Order,
  Position,
  Quote,
} from './domain.js';
import { Timestamp } from './primitives.js';

/**
 * The realtime protocol (ADR-0008).
 *
 * Every topic carries a monotonic sequence number. The client asserts
 * contiguity and forces a resnapshot on any gap; it never interpolates. Without
 * this a quiet market and a dead socket look identical, which is how a client
 * ends up showing a position that closed ten minutes ago.
 */

export const Topic = z.union([
  z.literal('health'),
  z.literal('account'),
  z.literal('positions'),
  z.literal('orders'),
  z.literal('divergences'),
  z.literal('drawdown'),
  z.literal('alerts'),
  /** `quotes:XAUUSD` */
  z.string().regex(/^quotes:[A-Z0-9_-]{1,20}$/),
]);
export type Topic = z.infer<typeof Topic>;

// --- Client -> server ------------------------------------------------------

export const ClientHello = z.object({
  type: z.literal('hello'),
  protocolVersion: z.literal(1),
  clientVersion: z.string(),
  /** Topics to subscribe to immediately. */
  topics: z.array(Topic),
  /**
   * Per-topic last sequence the client holds. The server replays from there if
   * it still can, and otherwise sends a fresh snapshot — either way the client
   * ends up provably complete.
   */
  resume: z.record(z.string(), z.number().int().nonnegative()).default({}),
});
export type ClientHello = z.infer<typeof ClientHello>;

export const ClientSubscribe = z.object({
  type: z.literal('subscribe'),
  topics: z.array(Topic),
});

export const ClientUnsubscribe = z.object({
  type: z.literal('unsubscribe'),
  topics: z.array(Topic),
});

/** Application-level heartbeat. Carries the client's clock for drift detection. */
export const ClientPing = z.object({
  type: z.literal('ping'),
  clientTime: Timestamp,
});

export const ClientMessage = z.discriminatedUnion('type', [
  ClientHello,
  ClientSubscribe,
  ClientUnsubscribe,
  ClientPing,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// --- Server -> client ------------------------------------------------------

export const ServerWelcome = z.object({
  type: z.literal('welcome'),
  serverTime: Timestamp,
  deskVersion: z.string(),
  /** How long the server buffers deltas; beyond this a resume forces a snapshot. */
  deltaBufferMs: z.number().int(),
  /** Client must ping at least this often or be disconnected. */
  heartbeatIntervalMs: z.number().int(),
});

const payloadFor = z.discriminatedUnion('topicKind', [
  z.object({ topicKind: z.literal('health'), value: DeskHealth }),
  z.object({ topicKind: z.literal('account'), value: AccountSnapshot }),
  z.object({ topicKind: z.literal('positions'), value: z.array(Position) }),
  z.object({ topicKind: z.literal('orders'), value: z.array(Order) }),
  z.object({ topicKind: z.literal('divergences'), value: z.array(Divergence) }),
  z.object({ topicKind: z.literal('drawdown'), value: DrawdownStatus }),
  z.object({ topicKind: z.literal('alerts'), value: z.array(Alert) }),
  z.object({ topicKind: z.literal('quotes'), value: z.array(Quote) }),
]);

/** Full current state of a topic. Always safe to apply over anything. */
export const ServerSnapshot = z.object({
  type: z.literal('snapshot'),
  topic: Topic,
  seq: z.number().int().nonnegative(),
  at: Timestamp,
  payload: payloadFor,
});
export type ServerSnapshot = z.infer<typeof ServerSnapshot>;

/**
 * An incremental update. `seq` must be exactly the client's last + 1 for this
 * topic; anything else means a gap and requires a resnapshot.
 */
export const ServerDelta = z.object({
  type: z.literal('delta'),
  topic: Topic,
  seq: z.number().int().nonnegative(),
  at: Timestamp,
  /** Entities added or changed. */
  upsert: payloadFor.optional(),
  /** Ids removed, for collection topics. */
  remove: z.array(z.string()).default([]),
});
export type ServerDelta = z.infer<typeof ServerDelta>;

/**
 * The server could not honour a resume. Not an error — it is the mechanism that
 * keeps the client honest, and it always arrives with a snapshot behind it.
 */
export const ServerResync = z.object({
  type: z.literal('resync'),
  topic: Topic,
  reason: z.enum(['gap', 'buffer-expired', 'server-restart', 'subscription-new']),
  detail: z.string(),
});
export type ServerResync = z.infer<typeof ServerResync>;

export const ServerPong = z.object({
  type: z.literal('pong'),
  serverTime: Timestamp,
  /** Echo of the client clock, so the client can measure round trip and drift. */
  clientTime: Timestamp,
});

export const ServerError = z.object({
  type: z.literal('error'),
  code: z.string(),
  detail: z.string(),
  /** Whether the socket will now close. */
  fatal: z.boolean(),
});

export const ServerMessage = z.discriminatedUnion('type', [
  ServerWelcome,
  ServerSnapshot,
  ServerDelta,
  ServerResync,
  ServerPong,
  ServerError,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/**
 * Applies a delta to a client-held sequence number.
 *
 * Exported so the client and the server test the *same* contiguity rule. The
 * whole value of sequence numbers evaporates if the two sides disagree about
 * what a gap is.
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
