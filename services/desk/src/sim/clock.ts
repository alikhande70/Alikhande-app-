/**
 * Time, as a dependency.
 *
 * Every component takes a `Clock` rather than calling `Date.now()`, so the
 * chaos suite can replay a whole trading day — including DST boundaries,
 * rollover windows and multi-hour timeouts — in milliseconds and deterministically.
 */
export interface Clock {
  now(): number;
  /** Resolves after `ms` of clock time. */
  sleep(ms: number): Promise<void>;
  setTimeout(fn: () => void, ms: number): () => void;
  setInterval(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  },
};

interface ScheduledTask {
  readonly at: number;
  readonly seq: number;
  readonly fn: () => void;
  readonly intervalMs?: number;
  cancelled: boolean;
}

/**
 * A clock the test drives by hand. `advance` runs every task due in the
 * interval, in order, including tasks scheduled by earlier tasks — so a chain
 * of retries with backoff plays out exactly as it would in real time.
 */
export class TestClock implements Clock {
  private current: number;
  private seq = 0;
  private tasks: ScheduledTask[] = [];

  constructor(startMs: number) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimeout(() => resolve(), ms);
    });
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const task: ScheduledTask = { at: this.current + Math.max(0, ms), seq: this.seq++, fn, cancelled: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  }

  setInterval(fn: () => void, ms: number): () => void {
    const period = Math.max(1, ms);
    const task: ScheduledTask = {
      at: this.current + period,
      seq: this.seq++,
      fn,
      intervalMs: period,
      cancelled: false,
    };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  }

  /**
   * Move time forward, firing due tasks. Yields to the microtask queue between
   * tasks so promise chains resolve in the order they would in real time.
   */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = this.tasks
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = due[0];
      if (next === undefined) break;
      this.current = Math.max(this.current, next.at);
      this.tasks = this.tasks.filter((t) => t !== next);
      if (next.intervalMs !== undefined && !next.cancelled) {
        this.tasks.push({ ...next, at: this.current + next.intervalMs, seq: this.seq++ });
      }
      if (!next.cancelled) next.fn();
      // Let any promises resolved by `fn` settle before the next task.
      await Promise.resolve();
      await Promise.resolve();
    }
    this.current = target;
    await Promise.resolve();
  }

  /** Number of tasks still scheduled. Useful for leak assertions in tests. */
  get pending(): number {
    return this.tasks.filter((t) => !t.cancelled).length;
  }

  /** The earliest scheduled task time, or undefined when nothing is pending. */
  get nextTaskAt(): number | undefined {
    const live = this.tasks.filter((t) => !t.cancelled);
    if (live.length === 0) return undefined;
    return live.reduce((min, t) => Math.min(min, t.at), Number.POSITIVE_INFINITY);
  }

  /**
   * Await a promise while driving the clock forward.
   *
   * Anything that sleeps on this clock — a broker round trip, a retry backoff —
   * would otherwise deadlock, because the promise cannot settle until time
   * moves and time does not move on its own. Jumping straight to the next
   * scheduled task keeps a multi-minute backoff schedule instant while
   * preserving the exact ordering real time would produce.
   */
  async settle<T>(p: Promise<T>, budgetMs = 3_600_000): Promise<T> {
    let done = false;
    const tracked = p.then(
      (v) => {
        done = true;
        return v;
      },
      (e: unknown) => {
        done = true;
        throw e;
      },
    );
    await Promise.resolve();
    await Promise.resolve();

    const deadline = this.current + budgetMs;
    while (!done) {
      const next = this.nextTaskAt;
      if (next === undefined || next > deadline) break;
      await this.advance(Math.max(1, next - this.current));
    }
    return tracked;
  }
}
