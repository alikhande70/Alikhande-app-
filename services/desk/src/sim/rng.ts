/**
 * Deterministic pseudo-random source.
 *
 * Every simulated behaviour — latency, slippage, partial fills, injected faults
 * — draws from here, so a chaos run is fully reproducible from its seed. A
 * failure that cannot be replayed cannot be fixed with confidence.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Avoid the zero fixed point of xorshift.
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** xorshift32. Fast, adequate for simulation, and identical across runtimes. */
  private next(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x;
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.next() / 0x1_0000_0000;
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.float() * (max - min + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.float() < p;
  }

  /** Box-Muller normal deviate. */
  normal(mean = 0, sd = 1): number {
    const u1 = Math.max(this.float(), Number.EPSILON);
    const u2 = this.float();
    return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** Log-normal latency: mostly fast, occasionally very slow. Realistic. */
  latencyMs(medianMs: number, sigma = 0.6): number {
    return Math.max(0, Math.round(medianMs * Math.exp(this.normal(0, sigma))));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty array');
    return items[this.int(0, items.length - 1)] as T;
  }
}
