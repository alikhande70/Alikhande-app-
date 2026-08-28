import { DesktopDeskClient } from './client.js';
import { DesktopMissionOperator } from './mission-operator.js';
import { DesktopMissionRealtime, type DesktopWebSocketLike } from './realtime.js';
import {
  DesktopMissionTruth,
  type DesktopMissionView,
  type MissionTruthState,
} from './mission-truth.js';
import {
  WindowsProtectedSigner,
  type WindowsNativeEd25519Bridge,
  type WindowsSignerMetadataStore,
} from './windows-signer.js';

export interface PairedWindowsMissionRuntimeOptions {
  readonly baseUrl: string;
  readonly deviceId: string;
  readonly bridge: WindowsNativeEd25519Bridge;
  readonly signerStore: WindowsSignerMetadataStore;
  readonly hashBody: (body: string) => Promise<string>;
  readonly randomId: () => string;
  readonly fetchFn?: typeof fetch;
  readonly websocketFactory?: (url: string) => DesktopWebSocketLike;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly clockOffsetMs?: () => number;
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  readonly maxReconnectDelayMs?: number;
}

export interface DesktopMissionRuntimeStatus {
  readonly started: boolean;
  readonly missionTruth: MissionTruthState;
  readonly actionable: boolean;
}

function normalizedDeskUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Desk URL is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Desk URL must use http or https');
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error('Desk URL must not contain credentials');
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error('Desk URL must not contain query or fragment data');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('Desk URL must point to the Desk origin, not a nested path');
  }
  parsed.pathname = '';
  return parsed;
}

function streamUrl(base: URL): string {
  const next = new URL(base.toString());
  next.protocol = next.protocol === 'https:' ? 'wss:' : 'ws:';
  next.pathname = '/stream';
  return next.toString();
}

/**
 * One composition root for the paired Windows Mission client.
 *
 * This is intentionally restore-only. Once a Desk device id exists, runtime
 * bootstrap may never create a replacement key behind the operator's back.
 * Missing/corrupt signer identity aborts startup and requires explicit pairing.
 * Mission truth mutators remain private so UI code cannot manufacture a current
 * projection and bypass realtime completeness checks.
 */
export class DesktopMissionRuntime {
  readonly operator: DesktopMissionOperator;
  private readonly truth: DesktopMissionTruth;
  private readonly realtime: DesktopMissionRealtime;
  private started = false;

  private constructor(options: {
    readonly truth: DesktopMissionTruth;
    readonly operator: DesktopMissionOperator;
    readonly realtime: DesktopMissionRealtime;
  }) {
    this.truth = options.truth;
    this.operator = options.operator;
    this.realtime = options.realtime;
  }

  static async restorePaired(
    options: PairedWindowsMissionRuntimeOptions,
  ): Promise<DesktopMissionRuntime> {
    const base = normalizedDeskUrl(options.baseUrl);
    if (options.deviceId.trim().length < 3) {
      throw new Error('Desk device id is missing or malformed');
    }

    const signer = await WindowsProtectedSigner.restore({
      bridge: options.bridge,
      store: options.signerStore,
    });
    const truth = new DesktopMissionTruth();
    const client = new DesktopDeskClient({
      baseUrl: base.toString().replace(/\/$/, ''),
      deviceId: options.deviceId,
      signer,
      hashBody: options.hashBody,
      randomId: options.randomId,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.clockOffsetMs === undefined ? {} : { clockOffsetMs: options.clockOffsetMs }),
    });
    const realtime = new DesktopMissionRealtime({
      url: streamUrl(base),
      client,
      truth,
      ...(options.websocketFactory === undefined ? {} : { factory: options.websocketFactory }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.setTimeoutFn === undefined ? {} : { setTimeoutFn: options.setTimeoutFn }),
      ...(options.clearTimeoutFn === undefined ? {} : { clearTimeoutFn: options.clearTimeoutFn }),
      ...(options.maxReconnectDelayMs === undefined
        ? {}
        : { maxReconnectDelayMs: options.maxReconnectDelayMs }),
    });
    const operator = new DesktopMissionOperator(client, truth);
    return new DesktopMissionRuntime({ truth, operator, realtime });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.realtime.connect();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.realtime.close();
  }

  missions(): readonly DesktopMissionView[] {
    return this.truth.list();
  }

  status(): DesktopMissionRuntimeStatus {
    return {
      started: this.started,
      missionTruth: this.truth.status,
      actionable: this.started && this.truth.status === 'current',
    };
  }
}
