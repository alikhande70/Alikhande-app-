/**
 * A keyed mutex.
 *
 * Node's event loop serialises synchronous code, but every `await` is an
 * interleaving point. Two concurrent submissions of the same intent id would
 * otherwise both pass the idempotency check before either wrote its record —
 * and produce two orders from one human decision.
 *
 * Critical sections in the execution path hold this across their awaits.
 */
export class KeyedMutex {
  /** The promise the next caller for this key must wait on. */
  private readonly tails = new Map<string, Promise<void>>();
  /** How many callers are queued per key, so the map can be cleaned up. */
  private readonly waiters = new Map<string, number>();

  /** Run `fn` with exclusive access to `key`. Serialised per key, parallel across keys. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.waiters.set(key, (this.waiters.get(key) ?? 0) + 1);

    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, mine);

    // A predecessor that threw must not wedge the queue behind it.
    await previous.catch(() => undefined);

    try {
      return await fn();
    } finally {
      release();
      const remaining = (this.waiters.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        this.waiters.delete(key);
        // Only drop the tail if it is still ours; a later caller may have
        // replaced it between our release and this line.
        if (this.tails.get(key) === mine) this.tails.delete(key);
      } else {
        this.waiters.set(key, remaining);
      }
    }
  }

  get activeKeys(): number {
    return this.tails.size;
  }
}
