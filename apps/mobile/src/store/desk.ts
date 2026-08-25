import { create } from 'zustand';
import type { ConnectionState } from '../api/socket.js';

/**
 * The client's view of the desk.
 *
 * One rule governs everything here: **the store never invents a value, and
 * never lets a value outlive its evidence.** Every collection carries the
 * sequence it was built from and the moment it was last confirmed. A screen can
 * therefore always answer "how do I know this?" — and when the answer is "I
 * don't, any more", it says so instead of showing the last thing it saw.
 */

export interface Provenance {
  readonly source: 'broker' | 'reference' | 'desk' | 'cache';
  readonly asOf: number;
}

export interface Quote {
  readonly canonical: string;
  readonly bid: string;
  readonly ask: string;
  readonly spread: string;
  readonly provenance: Provenance;
  readonly stale: boolean;
}

export interface Position {
  readonly positionId: string;
  readonly canonical: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly volume: string;
  readonly entryPrice: string;
  readonly stopPrice?: string;
  readonly takeProfitPrice?: string;
  readonly openedAt: number;
  readonly intentId?: string;
  readonly foreign: boolean;
  readonly provenance: Provenance;
}

export interface Order {
  readonly intentId: string;
  readonly venueOrderId?: string;
  readonly canonical: string;
  readonly side: 'buy' | 'sell';
  readonly kind: string;
  readonly requestedQty: string;
  readonly filledQty: string;
  readonly state: string;
  readonly certainty: 'confirmed' | 'in-flight' | 'unknown' | 'local';
  readonly certaintyText: string;
  readonly knowledgeStaleSince?: number | null;
  readonly reason?: string | null;
  readonly resolutionAttempts: number;
  readonly createdAt: number;
  readonly lastEventAt: number;
}

export interface AccountView {
  readonly currency: string;
  readonly balance: string;
  readonly equity: string;
  readonly marginUsed: string;
  readonly marginFree: string;
  readonly provenance: Provenance;
}

export interface DrawdownView {
  readonly status: 'ok' | 'warning' | 'breached' | 'not-applicable';
  readonly buffer: string;
  readonly bufferFraction: string;
  readonly floor: string;
  readonly highWater: string;
  readonly explain: string;
}

export interface Divergence {
  readonly kind: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly action: string;
  readonly canonical?: string;
  readonly detail: string;
  readonly local: string;
  readonly venue: string;
}

export interface Alert {
  readonly alertId: string;
  readonly kind: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly title: string;
  readonly body: string;
  readonly createdAt: number;
  readonly acknowledgedAt?: number;
}

export interface DeskHealth {
  readonly brokerConnected: boolean;
  readonly brokerName: string;
  readonly referenceFeedConnected: boolean;
  readonly openDivergences: number;
  readonly criticalDivergences: number;
  readonly unresolvedOrders: number;
  readonly undeliveredCriticalAlerts: number;
  readonly lockout?: { until: number; reason: string } | null;
  readonly credentialsLocked: boolean;
  readonly deskStartedAt: number;
  readonly version: string;
}

/**
 * A topic's completeness.
 *
 * `incomplete` is the state the whole sequence-number design exists to make
 * visible: the socket is up, but this topic is mid-resync and what is on screen
 * may be missing something. Screens grey out actions when a topic they depend
 * on is incomplete.
 */
export type TopicStatus = 'never-loaded' | 'complete' | 'incomplete';

export interface TopicMeta {
  readonly status: TopicStatus;
  readonly seq?: number;
  /** When this topic was last confirmed complete. */
  readonly confirmedAt?: number;
}

export interface DeskStoreState {
  connection: ConnectionState;
  connectionDetail?: string;
  /** Round-trip time to the desk, and our clock's offset from its clock. */
  rttMs?: number;
  clockOffsetMs: number;

  health?: DeskHealth;
  account?: AccountView;
  positions: readonly Position[];
  orders: readonly Order[];
  divergences: readonly Divergence[];
  drawdown?: DrawdownView;
  alerts: readonly Alert[];
  quotes: Record<string, Quote>;

  topics: Record<string, TopicMeta>;
  /** Gaps the client detected itself, shown in the diagnostics screen. */
  gapEvents: readonly { topic: string; expected: number; got: number; at: number }[];

  applySnapshot: (topic: string, seq: number, payload: unknown, at: number) => void;
  applyDelta: (topic: string, seq: number, upsert: unknown, remove: readonly string[], at: number) => void;
  setConnection: (state: ConnectionState, detail?: string) => void;
  setLatency: (rttMs: number, clockOffsetMs: number) => void;
  noteGap: (topic: string, expected: number, got: number, at: number) => void;
  markTopicIncomplete: (topic: string) => void;
  reset: () => void;
}

const EMPTY_TOPICS: Record<string, TopicMeta> = {};

export const useDeskStore = create<DeskStoreState>((set, get) => ({
  connection: 'idle',
  clockOffsetMs: 0,
  positions: [],
  orders: [],
  divergences: [],
  alerts: [],
  quotes: {},
  topics: EMPTY_TOPICS,
  gapEvents: [],

  setConnection: (state, detail) => {
    set((s) => ({
      connection: state,
      ...(detail !== undefined ? { connectionDetail: detail } : {}),
      // Losing the socket does not erase what we know — it changes what we can
      // claim about it. Every topic drops to incomplete so the UI can mark the
      // data as last-known rather than current.
      topics:
        state === 'disconnected' || state === 'connecting'
          ? Object.fromEntries(
              Object.entries(s.topics).map(([k, v]) => [
                k,
                { ...v, status: v.status === 'never-loaded' ? 'never-loaded' : 'incomplete' },
              ]),
            )
          : s.topics,
    }));
  },

  setLatency: (rttMs, clockOffsetMs) => set({ rttMs, clockOffsetMs }),

  noteGap: (topic, expected, got, at) =>
    set((s) => ({
      gapEvents: [...s.gapEvents.slice(-49), { topic, expected, got, at }],
      topics: { ...s.topics, [topic]: { ...(s.topics[topic] ?? { status: 'never-loaded' }), status: 'incomplete' } },
    })),

  markTopicIncomplete: (topic) =>
    set((s) => ({
      topics: {
        ...s.topics,
        [topic]: { ...(s.topics[topic] ?? { status: 'never-loaded' }), status: 'incomplete' },
      },
    })),

  applySnapshot: (topic, seq, payload, at) => {
    set((s) => ({
      ...applyPayload(s, topic, payload, []),
      topics: { ...s.topics, [topic]: { status: 'complete', seq, confirmedAt: at } },
    }));
  },

  applyDelta: (topic, seq, upsert, remove, at) => {
    const current = get().topics[topic];
    // A delta on a topic we never snapshotted cannot be applied safely: we have
    // no base to apply it to. The socket layer should have prevented this, but
    // the store refuses independently rather than trusting it.
    if (current === undefined || current.status === 'never-loaded') {
      get().markTopicIncomplete(topic);
      return;
    }
    set((s) => ({
      ...applyPayload(s, topic, upsert, remove),
      topics: { ...s.topics, [topic]: { status: 'complete', seq, confirmedAt: at } },
    }));
  },

  reset: () =>
    set({
      connection: 'idle',
      positions: [],
      orders: [],
      divergences: [],
      alerts: [],
      quotes: {},
      topics: EMPTY_TOPICS,
      gapEvents: [],
    }),
}));

/** Merge a topic payload into state. Pure, so it can be tested directly. */
export function applyPayload(
  state: DeskStoreState,
  topic: string,
  payload: unknown,
  remove: readonly string[],
): Partial<DeskStoreState> {
  if (payload === undefined || payload === null) return {};

  if (topic === 'health') return { health: payload as DeskHealth };
  if (topic === 'account') return { account: payload as AccountView };
  if (topic === 'drawdown') return { drawdown: payload as DrawdownView };
  if (topic === 'divergences') return { divergences: payload as Divergence[] };

  if (topic === 'positions') {
    return { positions: mergeById(state.positions, payload as Position[], 'positionId', remove) };
  }
  if (topic === 'orders') {
    return { orders: mergeById(state.orders, payload as Order[], 'intentId', remove) };
  }
  if (topic === 'alerts') {
    return { alerts: mergeById(state.alerts, payload as Alert[], 'alertId', remove).slice(0, 100) };
  }
  if (topic.startsWith('quotes')) {
    const next = { ...state.quotes };
    for (const q of payload as Quote[]) next[q.canonical] = q;
    return { quotes: next };
  }
  return {};
}

function mergeById<T>(
  existing: readonly T[],
  incoming: readonly T[],
  key: keyof T & string,
  remove: readonly string[],
): readonly T[] {
  const byId = new Map<string, T>();
  for (const item of existing) byId.set(String(item[key]), item);
  for (const item of incoming) byId.set(String(item[key]), item);
  for (const id of remove) byId.delete(id);
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Derived views. Kept as pure selectors so screens stay declarative and the
// rules that decide what is safe to act on live in one place.
// ---------------------------------------------------------------------------

/**
 * Whether the app may offer to place an order right now.
 *
 * Deliberately conservative and deliberately explanatory: the operator should
 * never be left wondering why the button is grey.
 */
export function canTrade(s: DeskStoreState): { ok: boolean; reason?: string } {
  if (s.connection !== 'connected') {
    return { ok: false, reason: 'Not connected to your desk.' };
  }
  if (s.health === undefined) {
    return { ok: false, reason: 'No desk health yet.' };
  }
  if (!s.health.brokerConnected) {
    return { ok: false, reason: `${s.health.brokerName} is disconnected.` };
  }
  if (s.health.lockout != null) {
    return { ok: false, reason: `Locked out: ${s.health.lockout.reason}` };
  }
  if (s.health.credentialsLocked) {
    return { ok: false, reason: 'The desk is running but broker credentials are locked.' };
  }
  if (s.drawdown?.status === 'breached') {
    return { ok: false, reason: 'Drawdown breached.' };
  }
  const incomplete = Object.entries(s.topics)
    .filter(([, v]) => v.status === 'incomplete')
    .map(([k]) => k);
  if (incomplete.length > 0) {
    return { ok: false, reason: `Still resyncing ${incomplete.join(', ')}.` };
  }
  if (s.health.unresolvedOrders > 0) {
    return {
      ok: false,
      reason: `${s.health.unresolvedOrders} order(s) with an unknown outcome. Resolve before trading.`,
    };
  }
  return { ok: true };
}

/** Orders the operator must look at, in the order they should look at them. */
export function needsAttention(s: DeskStoreState): readonly Order[] {
  const rank: Record<string, number> = { unknown: 0, 'in-flight': 1, local: 2, confirmed: 3 };
  return s.orders
    .filter((o) => o.certainty !== 'confirmed' || o.state === 'PARTIALLY_FILLED')
    .sort((a, b) => (rank[a.certainty] ?? 9) - (rank[b.certainty] ?? 9));
}

/** Positions with no stop. The single most important list in the app. */
export function unprotectedPositions(s: DeskStoreState): readonly Position[] {
  return s.positions.filter((p) => p.stopPrice === undefined || p.stopPrice === null);
}

/**
 * The age of the most recently confirmed data, using the desk's clock rather
 * than the phone's. A phone whose clock is wrong would otherwise show every
 * value as stale, or — much worse — as fresher than it is.
 */
export function dataAgeMs(s: DeskStoreState, topic: string, nowOnPhone: number): number | undefined {
  const meta = s.topics[topic];
  if (meta?.confirmedAt === undefined) return undefined;
  const deskNow = nowOnPhone + s.clockOffsetMs;
  return Math.max(0, deskNow - meta.confirmedAt);
}
