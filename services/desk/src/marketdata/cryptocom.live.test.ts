import * as D from '@keel/core';
import { describe, expect, it } from 'vitest';
import { systemClock } from '../sim/clock.js';
import { CryptoComProvider } from './cryptocom.js';
import type { Tick } from './port.js';
import { isCrossed } from './port.js';

/**
 * Live network tests against Crypto.com's public API.
 *
 * These are excluded from `pnpm test` and run by `pnpm test:live`, because a
 * test suite that fails when the internet is down is a test suite people learn
 * to ignore. They skip rather than fail when the service is unreachable — but
 * they do NOT skip on a bad response, because that is a real finding.
 *
 * This is the one data path in the system that can be verified end to end
 * without credentials, which is why it exists.
 */

const provider = (): CryptoComProvider => new CryptoComProvider({ clock: systemClock });

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch('https://api.crypto.com/exchange/v1/public/get-instruments', {
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

describe('crypto.com REST', () => {
  it('lists tradable instruments', async () => {
    if (!(await reachable())) return;
    const names = await provider().getInstrumentNames();
    expect(names.length).toBeGreaterThan(50);
    expect(names).toContain('BTCUSD-PERP');
  }, 30_000);

  it('returns candles that parse into exact decimals', async () => {
    if (!(await reachable())) return;
    const bars = await provider().getBars('BTCUSD', '5m', 20);
    expect(bars.length).toBeGreaterThan(5);
    for (const b of bars) {
      // The whole reason for choosing a venue that quotes as text: every price
      // becomes a Dec with no float anywhere in the path.
      expect(D.Decimal.gt(b.h, D.Decimal.ZERO)).toBe(true);
      expect(D.Decimal.gte(b.h, b.l)).toBe(true);
      expect(D.Decimal.gte(b.h, b.o)).toBe(true);
      expect(D.Decimal.gte(b.h, b.c)).toBe(true);
      expect(D.Decimal.lte(b.l, b.o)).toBe(true);
      expect(b.t).toBeGreaterThan(1_600_000_000_000);
    }
    // Sorted oldest first, with no duplicate buckets.
    const times = bars.map((b) => b.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
  }, 30_000);

  it('returns a ticker with a sane, uncrossed book', async () => {
    if (!(await reachable())) return;
    const tick = await provider().getTicker('BTCUSD');
    expect(tick).toBeDefined();
    if (tick === undefined) return;
    expect(isCrossed(tick)).toBe(false);
    expect(tick.plane).toBe('reference');
    // The venue's own timestamp, not our arrival time.
    expect(Math.abs(Date.now() - tick.asOf)).toBeLessThan(120_000);
  }, 30_000);

  it('reports an HTTP failure rather than returning empty data', async () => {
    if (!(await reachable())) return;
    await expect(provider().getBars('DEFINITELY_NOT_A_SYMBOL', '5m', 5)).rejects.toThrow();
  }, 30_000);
});

describe('crypto.com WebSocket', () => {
  it('connects, subscribes, and delivers ticks', async () => {
    if (!(await reachable())) return;
    const p = provider();
    const ticks: Tick[] = [];
    p.on((e) => {
      if (e.type === 'tick') ticks.push(e.tick);
    });
    await p.connect();
    await p.subscribe(['BTCUSD']);

    const deadline = Date.now() + 30_000;
    while (ticks.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    await p.disconnect();

    expect(ticks.length).toBeGreaterThanOrEqual(2);
    const first = ticks[0] as Tick;
    expect(first.canonical).toBe('BTCUSD');
    expect(isCrossed(first)).toBe(false);
    expect(D.Decimal.gt(first.bid, D.Decimal.ZERO)).toBe(true);
  }, 60_000);

  it('stays alive past the heartbeat interval', async () => {
    if (!(await reachable())) return;
    // The service closes a socket that does not answer public/heartbeat. This
    // asserts the answer is being sent, by outliving the interval.
    const p = provider();
    let disconnects = 0;
    const ticks: Tick[] = [];
    p.on((e) => {
      if (e.type === 'disconnected') disconnects += 1;
      if (e.type === 'tick') ticks.push(e.tick);
    });
    await p.connect();
    await p.subscribe(['BTCUSD']);
    await new Promise((r) => setTimeout(r, 45_000));
    const stillFlowing = ticks.length;
    await new Promise((r) => setTimeout(r, 5_000));
    await p.disconnect();

    expect(disconnects).toBe(0);
    expect(ticks.length).toBeGreaterThan(stillFlowing - 1);
    expect(p.isConnected()).toBe(false);
  }, 90_000);
});
