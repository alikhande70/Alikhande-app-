import * as D from '@keel/core';
import type { Clock } from '../sim/clock.js';
import type { Bar, MarketDataEvent, MarketDataProvider, Plane, Tick, Timeframe } from './port.js';

/**
 * Deterministic replay of recorded market data.
 *
 * The substrate for regression tests: a defect found on a particular sequence of
 * prices can be pinned to that exact sequence, so a fix can be proved rather
 * than believed. Prices are stored as decimal strings, which keeps a recording
 * exact across a JSON round trip.
 *
 * Replay runs on the injected `Clock`, so a full trading day plays out in
 * milliseconds under a `TestClock` and in real time under the system clock.
 */

export interface RecordedTick {
  readonly canonical: string;
  readonly bid: string;
  readonly ask: string;
  readonly last?: string;
  /** Milliseconds from the start of the recording. */
  readonly offsetMs: number;
}

export interface Recording {
  readonly name: string;
  /** Wall-clock time the recording started, for reproducing session context. */
  readonly startedAt: number;
  readonly ticks: readonly RecordedTick[];
  readonly bars?: Readonly<
    Record<string, readonly { t: number; o: string; h: string; l: string; c: string; v: string }[]>
  >;
}

export interface ReplayOptions {
  readonly clock: Clock;
  readonly recording: Recording;
  readonly plane?: Plane;
  /** 1 = real time, 60 = a minute per second. Applies to the injected clock. */
  readonly speed?: number;
  readonly loop?: boolean;
}

export class ReplayProvider implements MarketDataProvider {
  readonly name: string;
  readonly plane: Plane;

  private readonly handlers = new Set<(e: MarketDataEvent) => void>();
  private readonly subscribed = new Set<string>();
  private connected = false;
  private cancel: (() => void) | undefined;
  private index = 0;
  private originAt = 0;

  constructor(private readonly opts: ReplayOptions) {
    this.name = `replay:${opts.recording.name}`;
    this.plane = opts.plane ?? 'reference';
  }

  isConnected(): boolean {
    return this.connected;
  }

  on(handler: (e: MarketDataEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(e: MarketDataEvent): void {
    for (const h of this.handlers) h(e);
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.index = 0;
    this.originAt = this.opts.clock.now();
    this.emit({ type: 'connected', at: this.originAt });
    this.scheduleNext();
  }

  async disconnect(): Promise<void> {
    this.cancel?.();
    this.cancel = undefined;
    this.connected = false;
    this.emit({ type: 'disconnected', at: this.opts.clock.now(), reason: 'replay stopped' });
  }

  async subscribe(canonicals: readonly string[]): Promise<void> {
    for (const c of canonicals) this.subscribed.add(c);
  }

  async unsubscribe(canonicals: readonly string[]): Promise<void> {
    for (const c of canonicals) this.subscribed.delete(c);
  }

  async getBars(canonical: string, timeframe: Timeframe, limit: number): Promise<readonly Bar[]> {
    const key = `${canonical}:${timeframe}`;
    const rows = this.opts.recording.bars?.[key] ?? [];
    return rows.slice(-limit).map((r) => ({
      t: r.t,
      o: D.dec(r.o),
      h: D.dec(r.h),
      l: D.dec(r.l),
      c: D.dec(r.c),
      v: D.dec(r.v),
    }));
  }

  /** How far through the recording we are, 0 to 1. */
  get progress(): number {
    const total = this.opts.recording.ticks.length;
    return total === 0 ? 1 : this.index / total;
  }

  private scheduleNext(): void {
    if (!this.connected) return;
    const ticks = this.opts.recording.ticks;
    const next = ticks[this.index];
    if (next === undefined) {
      if (this.opts.loop === true && ticks.length > 0) {
        this.index = 0;
        this.originAt = this.opts.clock.now();
        this.scheduleNext();
      }
      return;
    }
    const speed = this.opts.speed ?? 1;
    const dueAt = this.originAt + next.offsetMs / speed;
    const delay = Math.max(0, dueAt - this.opts.clock.now());
    this.cancel = this.opts.clock.setTimeout(() => {
      this.deliver(next);
      this.index += 1;
      this.scheduleNext();
    }, delay);
  }

  private deliver(rec: RecordedTick): void {
    if (!this.subscribed.has(rec.canonical)) return;
    const tick: Tick = {
      canonical: rec.canonical,
      bid: D.dec(rec.bid),
      ask: D.dec(rec.ask),
      // The recording's own timeline is preserved, so session and staleness
      // reasoning replays identically to the day it was captured.
      asOf: this.opts.recording.startedAt + rec.offsetMs,
      plane: this.plane,
      origin: this.name,
      ...(rec.last !== undefined ? { last: D.dec(rec.last) } : {}),
    };
    this.emit({ type: 'tick', tick });
  }
}

/** Capture a live provider's ticks into a recording, for later replay. */
export class Recorder {
  private readonly ticks: RecordedTick[] = [];
  private readonly startedAt: number;

  constructor(
    private readonly name: string,
    // Read once to anchor the recording's origin, never retained: a Recorder
    // that held a clock field nobody reads would be public surface for nothing.
    clock: Clock,
    private readonly maxTicks = 200_000,
  ) {
    this.startedAt = clock.now();
  }

  capture(tick: Tick): void {
    if (this.ticks.length >= this.maxTicks) return;
    this.ticks.push({
      canonical: tick.canonical,
      bid: D.Decimal.toString(tick.bid),
      ask: D.Decimal.toString(tick.ask),
      offsetMs: Math.max(0, tick.asOf - this.startedAt),
      ...(tick.last !== undefined ? { last: D.Decimal.toString(tick.last) } : {}),
    });
  }

  toRecording(): Recording {
    return { name: this.name, startedAt: this.startedAt, ticks: [...this.ticks] };
  }

  get size(): number {
    return this.ticks.length;
  }
}
