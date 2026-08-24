import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeyedMutex } from './lock.js';
import { clientOrderIdFor } from './supervisor.js';

/**
 * The venue-visible idempotency key.
 *
 * A collision here is silent and expensive: the venue treats a genuinely
 * different second trade as a duplicate of the first and never places it, while
 * returning an acknowledgement. The operator believes they are in a position
 * they do not hold. An earlier implementation truncated the intent id to 24
 * characters and did exactly that; these tests exist so it cannot come back.
 */
describe('client order id derivation', () => {
  it('is deterministic — a retry of the same decision carries the same key', () => {
    const id = randomUUID();
    expect(clientOrderIdFor(id)).toBe(clientOrderIdFor(id));
  });

  it('distinguishes ids that differ only in their last character', () => {
    const a = '018f3b8c-1a2b-7c3d-8e4f-000000000001';
    const b = '018f3b8c-1a2b-7c3d-8e4f-000000000003';
    expect(clientOrderIdFor(a)).not.toBe(clientOrderIdFor(b));
  });

  it('distinguishes ids that differ only in their first character', () => {
    const a = '018f3b8c-1a2b-7c3d-8e4f-000000000001';
    const b = '118f3b8c-1a2b-7c3d-8e4f-000000000001';
    expect(clientOrderIdFor(a)).not.toBe(clientOrderIdFor(b));
  });

  it('produces no collisions across a large batch of real uuids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50_000; i++) seen.add(clientOrderIdFor(randomUUID()));
    expect(seen.size).toBe(50_000);
  });

  it('fits inside an MT5 order comment (31 characters)', () => {
    const key = clientOrderIdFor(randomUUID());
    expect(key.length).toBeLessThanOrEqual(31);
    // And is safe in a URL, a comment field and a log line.
    expect(key).toMatch(/^k-[0-9a-z]+$/);
  });
});

describe('keyed mutex', () => {
  it('serialises work on the same key', async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const slow = m.run('a', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a-end');
    });
    const fast = m.run('a', async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('runs different keys in parallel', async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    await Promise.all([
      m.run('a', async () => {
        order.push('a-start');
        await new Promise((r) => setTimeout(r, 20));
        order.push('a-end');
      }),
      m.run('b', async () => {
        order.push('b-start');
        order.push('b-end');
      }),
    ]);
    expect(order).toEqual(['a-start', 'b-start', 'b-end', 'a-end']);
  });

  it('releases the lock when the critical section throws', async () => {
    const m = new KeyedMutex();
    await expect(
      m.run('a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // The next caller must not be blocked by the failure.
    await expect(m.run('a', async () => 'ok')).resolves.toBe('ok');
  });

  it('does not leak keys once work completes', async () => {
    const m = new KeyedMutex();
    for (let i = 0; i < 100; i++) await m.run(`k${i}`, async () => i);
    await new Promise((r) => setTimeout(r, 10));
    expect(m.activeKeys).toBe(0);
  });
});
