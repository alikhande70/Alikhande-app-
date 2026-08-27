import { useDeskStore } from '../store/desk.js';
import { type ClientOptions, DeskClient } from './client.js';
import { clearDeskClient, installDeskClient } from './runtime.js';
import type { SecureSigner } from './signer.js';
import { DeskSocket, type WebSocketLike } from './socket.js';

/** Topics that make up the operator's authoritative mobile read model. */
export const DESK_TOPICS = [
  'health',
  'account',
  'positions',
  'orders',
  'missions',
  'divergences',
  'drawdown',
  'alerts',
  'quotes',
] as const;

export interface RestoredPairing {
  /** Base URL of the already-paired Desk, without a trailing slash. */
  readonly baseUrl: string;
  /** Device id returned by `/enrol`. */
  readonly deviceId: string;
  /** Optional explicit stream URL. Derived from baseUrl when omitted. */
  readonly streamUrl?: string;
}

export interface BootstrapOptions {
  readonly signer: SecureSigner;
  readonly hashBody: ClientOptions['hashBody'];
  readonly randomId: ClientOptions['randomId'];
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly socketFactory?: (url: string) => WebSocketLike;
  readonly now?: () => number;
}

export interface RunningDeskRuntime {
  readonly client: DeskClient;
  readonly socket: DeskSocket;
  /** Stops transport and removes the signed client binding from UI code. */
  stop(options?: { readonly clearState?: boolean }): void;
}

/**
 * Restore transport for a device that has already completed enrolment.
 *
 * This deliberately does not provision keys or mint enrolment codes. Pairing is
 * a separate security ceremony; bootstrap only restores an identity whose key
 * already exists and whose device id was issued by the Desk.
 */
export async function restoreDeskRuntime(
  pairing: RestoredPairing,
  options: BootstrapOptions,
): Promise<RunningDeskRuntime> {
  assertPairing(pairing);
  if (!(await options.signer.isProvisioned())) {
    throw new Error('paired Desk metadata exists but the device signing key is missing');
  }

  const client = new DeskClient({
    baseUrl: stripTrailingSlash(pairing.baseUrl),
    signer: options.signer,
    deviceId: pairing.deviceId,
    hashBody: options.hashBody,
    randomId: options.randomId,
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    // Read the live offset on every request. A snapshot captured at bootstrap
    // would immediately become stale after the first socket ping.
    clockOffsetMs: () => useDeskStore.getState().clockOffsetMs,
  });

  const socket = new DeskSocket({
    url: pairing.streamUrl ?? streamUrlFor(pairing.baseUrl),
    topics: DESK_TOPICS,
    ...(options.socketFactory === undefined ? {} : { factory: options.socketFactory }),
    ...(options.now === undefined ? {} : { now: options.now }),
    events: {
      onSnapshot: (topic, seq, payload, at) =>
        useDeskStore.getState().applySnapshot(topic, seq, payload, at),
      onDelta: (topic, seq, upsert, remove, at) =>
        useDeskStore.getState().applyDelta(topic, seq, upsert, remove, at),
      onState: (state, detail) => useDeskStore.getState().setConnection(state, detail),
      onGap: (topic, expected, got) =>
        useDeskStore.getState().noteGap(topic, expected, got, options.now?.() ?? Date.now()),
      onLatency: (rttMs, offsetMs) => useDeskStore.getState().setLatency(rttMs, offsetMs),
    },
  });

  installDeskClient(client);
  socket.connect();

  let stopped = false;
  return {
    client,
    socket,
    stop({ clearState = false } = {}) {
      if (stopped) return;
      stopped = true;
      socket.close();
      clearDeskClient();
      if (clearState) useDeskStore.getState().reset();
    },
  };
}

function assertPairing(pairing: RestoredPairing): void {
  if (pairing.deviceId.trim().length === 0) throw new Error('paired device id is empty');
  const url = new URL(pairing.baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported Desk URL protocol: ${url.protocol}`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('Desk URL must not embed credentials');
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function streamUrlFor(baseUrl: string): string {
  const url = new URL(stripTrailingSlash(baseUrl));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/stream`;
  url.search = '';
  url.hash = '';
  return url.toString();
}
