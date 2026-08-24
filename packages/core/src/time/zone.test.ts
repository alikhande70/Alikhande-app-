import { describe, expect, it } from 'vitest';
import {
  assertValidTimeZone,
  fromWallClock,
  lastLocalTimeAtOrBefore,
  nextLocalTimeAfter,
  toWallClock,
  zoneOffsetMs,
  ZoneError,
} from './zone.js';
import {
  activeSessions,
  isForexOpen,
  isTripleSwapRollover,
  londonNewYorkOverlap,
  rolloverWindow,
  sessionContext,
} from './sessions.js';

const iso = (ms: number): string => new Date(ms).toISOString();

describe('zone basics', () => {
  it('reads wall clock in a zone', () => {
    const w = toWallClock(Date.UTC(2026, 0, 15, 12, 0, 0), 'America/New_York');
    expect(w).toMatchObject({ year: 2026, month: 1, day: 15, hour: 7, weekday: 4 });
  });

  it('reports offsets that follow DST', () => {
    // January: EST = UTC-5. July: EDT = UTC-4.
    expect(zoneOffsetMs(Date.UTC(2026, 0, 15, 12), 'America/New_York')).toBe(-5 * 3_600_000);
    expect(zoneOffsetMs(Date.UTC(2026, 6, 15, 12), 'America/New_York')).toBe(-4 * 3_600_000);
  });

  it('rejects an unknown zone at config time', () => {
    expect(() => assertValidTimeZone('Mars/Olympus')).toThrow(ZoneError);
    expect(() => assertValidTimeZone('Europe/London')).not.toThrow();
  });

  it('round-trips wall clock through UTC in both DST states', () => {
    for (const [m, d] of [
      [1, 15],
      [7, 15],
    ] as const) {
      const utc = fromWallClock('Europe/London', 2026, m, d, 8, 0);
      const back = toWallClock(utc, 'Europe/London');
      expect(back).toMatchObject({ year: 2026, month: m, day: d, hour: 8, minute: 0 });
    }
  });
});

describe('DST edge cases', () => {
  // US 2026: spring forward 8 March, fall back 1 November.
  it('resolves a non-existent local time to the instant the clock jumps to', () => {
    // 02:30 on 8 March 2026 does not exist in New York.
    const t = fromWallClock('America/New_York', 2026, 3, 8, 2, 30);
    const w = toWallClock(t, 'America/New_York');
    expect(w.hour).toBeGreaterThanOrEqual(3);
    expect(w.day).toBe(8);
  });

  it('resolves an ambiguous local time to the first occurrence', () => {
    // 01:30 on 1 November 2026 happens twice in New York (EDT then EST).
    const t = fromWallClock('America/New_York', 2026, 11, 1, 1, 30);
    expect(zoneOffsetMs(t, 'America/New_York')).toBe(-4 * 3_600_000); // EDT — the earlier one
    const later = t + 3_600_000;
    expect(toWallClock(later, 'America/New_York').hour).toBe(1); // still 01:30, now EST
    expect(zoneOffsetMs(later, 'America/New_York')).toBe(-5 * 3_600_000);
  });

  it('keeps a daily reset at the same local hour across a DST change', () => {
    // A prop-firm day resetting at 17:00 New York must stay 17:00 local, which
    // means the UTC instant moves by an hour — not the other way round.
    const before = lastLocalTimeAtOrBefore(Date.UTC(2026, 2, 6, 23, 0), 'America/New_York', '17:00');
    const after = lastLocalTimeAtOrBefore(Date.UTC(2026, 2, 10, 23, 0), 'America/New_York', '17:00');
    expect(toWallClock(before, 'America/New_York').hour).toBe(17);
    expect(toWallClock(after, 'America/New_York').hour).toBe(17);
    expect(iso(before)).toBe('2026-03-06T22:00:00.000Z'); // EST
    expect(iso(after)).toBe('2026-03-10T21:00:00.000Z'); // EDT
  });
});

describe('daily boundaries', () => {
  it('finds the previous reset when the time has already passed today', () => {
    const at = Date.UTC(2026, 5, 15, 22, 30); // 18:30 New York
    const t = lastLocalTimeAtOrBefore(at, 'America/New_York', '17:00');
    expect(iso(t)).toBe('2026-06-15T21:00:00.000Z');
  });

  it('rolls back to yesterday when the time has not yet come today', () => {
    const at = Date.UTC(2026, 5, 15, 12, 0); // 08:00 New York
    const t = lastLocalTimeAtOrBefore(at, 'America/New_York', '17:00');
    expect(iso(t)).toBe('2026-06-14T21:00:00.000Z');
  });

  it('next reset is always strictly in the future', () => {
    const at = Date.UTC(2026, 5, 15, 21, 0); // exactly 17:00 New York
    const next = nextLocalTimeAfter(at, 'America/New_York', '17:00');
    expect(next).toBeGreaterThan(at);
    expect(iso(next)).toBe('2026-06-16T21:00:00.000Z');
  });
});

describe('sessions', () => {
  it('knows when the FX market is closed', () => {
    expect(isForexOpen(Date.UTC(2026, 5, 13, 12, 0))).toBe(false); // Saturday
    expect(isForexOpen(Date.UTC(2026, 5, 14, 12, 0))).toBe(false); // Sunday morning
    expect(isForexOpen(Date.UTC(2026, 5, 14, 22, 0))).toBe(true); // Sunday 18:00 NY
    expect(isForexOpen(Date.UTC(2026, 5, 12, 20, 0))).toBe(true); // Friday 16:00 NY, still open
    expect(isForexOpen(Date.UTC(2026, 5, 12, 22, 0))).toBe(false); // Friday 18:00 NY, shut
  });

  it('reports London and New York active during the overlap', () => {
    // 14:00 UTC in June = 15:00 London (BST), 10:00 New York (EDT).
    const at = Date.UTC(2026, 5, 15, 14, 0);
    const ids = activeSessions(at).map((s) => s.id);
    expect(ids).toContain('london');
    expect(ids).toContain('newyork');
    const overlap = londonNewYorkOverlap(at);
    expect(overlap).toBeDefined();
    expect(at).toBeGreaterThanOrEqual((overlap as { startUtc: number }).startUtc);
  });

  it('computes the overlap length from the zones, not a hardcoded table', () => {
    // Mid-March 2026: the US has sprung forward, the UK has not. The overlap
    // is an hour shorter than it is in June.
    const march = londonNewYorkOverlap(Date.UTC(2026, 2, 10, 14, 0));
    const june = londonNewYorkOverlap(Date.UTC(2026, 5, 10, 14, 0));
    expect(march).toBeDefined();
    expect(june).toBeDefined();
    const mLen = (march as { endUtc: number; startUtc: number });
    const jLen = (june as { endUtc: number; startUtc: number });
    expect(mLen.endUtc - mLen.startUtc).not.toBe(jLen.endUtc - jLen.startUtc);
  });

  it('locates the rollover window at broker server midnight', () => {
    // Typical MT5 server time GMT+3 in summer => 21:00 UTC.
    const at = Date.UTC(2026, 5, 15, 21, 0);
    const roll = rolloverWindow(at, 'Europe/Athens');
    expect(roll.isInside).toBe(true);
    expect(rolloverWindow(Date.UTC(2026, 5, 15, 14, 0), 'Europe/Athens').isInside).toBe(false);
  });

  it('identifies the Wednesday triple-swap rollover', () => {
    // Server midnight that begins Thursday 18 June 2026 => 2026-06-17T21:00Z.
    expect(isTripleSwapRollover(Date.UTC(2026, 5, 17, 21, 0), 'Europe/Athens')).toBe(true);
    expect(isTripleSwapRollover(Date.UTC(2026, 5, 16, 21, 0), 'Europe/Athens')).toBe(false);
  });

  it('summarises context in one call', () => {
    const ctx = sessionContext(Date.UTC(2026, 5, 15, 14, 0), 'Europe/Athens');
    expect(ctx.marketOpen).toBe(true);
    expect(ctx.inOverlap).toBe(true);
    expect(ctx.inRollover).toBe(false);
    expect(ctx.active).toEqual(expect.arrayContaining(['london', 'newyork']));
  });

  it('reports no active session on a Saturday, despite the clock window', () => {
    // 13:00 London on a Saturday sits inside London's 08:00-16:30 window by the
    // clock, but no FX session is running. Wall-clock windows are not enough.
    const at = Date.UTC(2026, 5, 13, 12, 0);
    expect(activeSessions(at)).toHaveLength(0);
    const ctx = sessionContext(at, 'Europe/Athens');
    expect(ctx.marketOpen).toBe(false);
    expect(ctx.active).toHaveLength(0);
    expect(ctx.inOverlap).toBe(false);
    expect(ctx.minutesToNextOpen).toBeGreaterThan(0);
  });
});
