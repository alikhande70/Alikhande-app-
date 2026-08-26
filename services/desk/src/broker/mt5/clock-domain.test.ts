import { describe, expect, it } from 'vitest';
import { assertUtcClockDomain, MAX_UTC_SKEW_MS, Mt5ClockDomainError } from './clock-domain.js';

const DESK_NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
const HOUR = 3_600_000;

describe('MT5 clock domain', () => {
  it('accepts a UTC reading from a broker three hours ahead', () => {
    // The realistic LiteFinance case: server runs GMT+3, but the agent sends
    // UTC, so the desk comparison is valid and the offset is reported for
    // session reasoning.
    const verdict = assertUtcClockDomain(
      {
        utcMillis: DESK_NOW + 120,
        serverMillis: DESK_NOW + 120 + 3 * HOUR,
        serverUtcOffsetSec: 3 * 3600,
      },
      DESK_NOW,
    );
    expect(verdict.offsetSec).toBe(10_800);
    expect(verdict.warnings).toEqual([]);
  });

  it('rejects broker-local time masquerading as UTC', () => {
    // The original defect. A GMT+3 server sending TimeTradeServer() looks like
    // a clock three hours in the future; unnoticed, it makes every ambiguous
    // send permanently unresolvable.
    expect(() => assertUtcClockDomain({ utcMillis: DESK_NOW + 3 * HOUR }, DESK_NOW)).toThrow(
      Mt5ClockDomainError,
    );
  });

  it('rejects a server behind UTC too, which is the dangerous direction', () => {
    // A server behind UTC makes history coverage pass trivially, so the system
    // could conclude absence for an order that exists.
    expect(() => assertUtcClockDomain({ utcMillis: DESK_NOW - 5 * HOUR }, DESK_NOW)).toThrow(
      /broker-local time/,
    );
  });

  it('tolerates ordinary latency and clock drift', () => {
    expect(() =>
      assertUtcClockDomain({ utcMillis: DESK_NOW + MAX_UTC_SKEW_MS - 1 }, DESK_NOW),
    ).not.toThrow();
  });

  it('refuses an offset that is not a real timezone', () => {
    expect(() =>
      assertUtcClockDomain({ utcMillis: DESK_NOW, serverUtcOffsetSec: 20 * 3600 }, DESK_NOW),
    ).toThrow(/not a real timezone/);
  });

  it('warns when the reported offset disagrees with the stamps it describes', () => {
    const verdict = assertUtcClockDomain(
      { utcMillis: DESK_NOW, serverMillis: DESK_NOW + 2 * HOUR, serverUtcOffsetSec: 3 * 3600 },
      DESK_NOW,
    );
    expect(verdict.warnings[0]).toContain('disagrees');
  });

  it('rejects a missing or nonsensical UTC stamp rather than defaulting', () => {
    expect(() => assertUtcClockDomain({ utcMillis: 0 }, DESK_NOW)).toThrow(Mt5ClockDomainError);
    expect(() => assertUtcClockDomain({ utcMillis: Number.NaN }, DESK_NOW)).toThrow(
      Mt5ClockDomainError,
    );
  });
});
