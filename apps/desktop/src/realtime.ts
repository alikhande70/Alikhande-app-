import type { DesktopDeskClient } from './client.js';
import type { DesktopMissionTruth } from './mission-truth.js';

export interface DesktopWebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface DesktopMissionRealtimeOptions {
  readonly url: string;
  readonly client: DesktopDeskClient;
  readonly truth: DesktopMissionTruth;
  readonly factory?: (url: string) => DesktopWebSocketLike;
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  readonly maxReconnectDelayMs?: number;
}

interface Frame {
  readonly type?: string;
  readonly topic?: string;
  readonly seq?: number;
  readonly payload?: unknown;
  readonly upsert?: unknown;
  readonly remove?: readonly string[];
}

/**
 * Authenticated realtime bridge for the Windows/Desktop Mission read model.
 *
 * It intentionally subscribes only to `missions` for now. The runtime never
 * invents continuity: disconnect, malformed data, server resync, regression or
 * sequence gaps all make Mission truth unusable for orders until a fresh
 * snapshot proves completeness again.
 */
export class DesktopMissionRealtime {
  private socket: DesktopWebSocketLike | undefined;
  private closing = false;
  private attempt = 0;
  private reconnectHandle: unknown;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (handle: unknown) => void;

  constructor(private readonly options: DesktopMissionRealtimeOptions) {
    this.setT = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT =
      options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  connect(): void {
    this.closing = false;
    this.open();
  }

  close(): void {
    this.closing = true;
    this.clearT(this.reconnectHandle);
    try {
      this.socket?.close();
    } catch {
      // Already gone.
    }
    this.socket = undefined;
    this.options.truth.markDisconnected();
  }

  private open(): void {
    const factory =
      this.options.factory ??
      ((url: string) => new WebSocket(url) as unknown as DesktopWebSocketLike);
    let socket: DesktopWebSocketLike;
    try {
      socket = factory(this.options.url);
    } catch {
      this.options.truth.markDisconnected();
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      void this.authenticate(socket);
    };
    socket.onmessage = (event) => this.handle(event.data);
    socket.onerror = () => {
      // Close is authoritative for reconnect scheduling.
    };
    socket.onclose = () => {
      if (this.closing) return;
      this.options.truth.markDisconnected();
      this.scheduleReconnect();
    };
  }

  private async authenticate(socket: DesktopWebSocketLike): Promise<void> {
    try {
      const auth = await this.options.client.streamAuthentication();
      if (this.closing || this.socket !== socket) return;
      this.attempt = 0;
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: 1,
          clientVersion: '0.1.0',
          topics: ['missions'],
          resume:
            this.options.truth.sequence === undefined
              ? {}
              : { missions: this.options.truth.sequence },
          auth,
        }),
      );
    } catch {
      if (this.closing || this.socket !== socket) return;
      this.options.truth.markDisconnected();
      try {
        socket.close();
      } catch {
        // Already gone.
      }
    }
  }

  private handle(raw: unknown): void {
    let frame: Frame;
    try {
      frame = JSON.parse(String(raw)) as Frame;
    } catch {
      this.options.truth.markIncomplete();
      return;
    }
    if (frame.topic !== undefined && frame.topic !== 'missions') return;

    switch (frame.type) {
      case 'snapshot':
        if (
          typeof frame.seq !== 'number' ||
          !this.options.truth.replaceSnapshot(frame.seq, frame.payload)
        ) {
          this.options.truth.markIncomplete();
        }
        return;
      case 'delta':
        if (typeof frame.seq !== 'number') {
          this.options.truth.markIncomplete();
          return;
        }
        if (!this.options.truth.applyDelta(frame.seq, frame.upsert, frame.remove ?? [])) {
          this.requestSnapshot();
        }
        return;
      case 'resync':
        this.options.truth.markIncomplete();
        return;
      default:
        return;
    }
  }

  private requestSnapshot(): void {
    try {
      this.socket?.send(JSON.stringify({ type: 'subscribe', topics: ['missions'] }));
    } catch {
      this.options.truth.markDisconnected();
    }
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    const attempt = Math.min(this.attempt++, 6);
    const base = Math.min(this.options.maxReconnectDelayMs ?? 15_000, 500 * 2 ** attempt);
    // Desktop jitter is deterministic enough for tests while still preventing
    // reconnect storms across multiple local clients.
    const delay = Math.max(250, Math.round(base * 0.75));
    this.reconnectHandle = this.setT(() => this.open(), delay);
  }
}
