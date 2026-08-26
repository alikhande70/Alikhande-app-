import * as D from '@keel/core';
import { describe, expect, it } from 'vitest';
import { assertUtcClockDomain } from './clock-domain.js';
import type { Mt5EvidenceCandidate, Mt5ReconcileObservation } from './evidence.js';
import { marginForGovernor, parseMt5MarginResponse } from './margin.js';
import { classifyMt5Evidence } from './observation.js';

/**
 * Adversarial timelines for the execution-truth foundation.
 *
 * Each one is a situation that has actually broken retail trading systems, run
 * against the real classifiers rather than a mock. They exist to try to make the
 * system claim a trade that does not exist, miss one that does, or size against
 * a number it does not have.
 */

const MAGIC = '281474976710777';
const FOREIGN = '281474976710999';
const SEND_FROM = 1_700_000_000_000;
const SEND_TO = 1_700_000_001_000;

const fingerprint = {
  symbol: 'XAUUSD',
  side: 'buy' as const,
  volume: '0.10',
  sentNotBefore: SEND_FROM,
  sentNotAfter: SEND_TO,
};

function candidate(over: Partial<Mt5EvidenceCandidate>): Mt5EvidenceCandidate {
  return {
    kind: 'deal',
    ticket: '1',
    magic: MAGIC,
    symbol: 'XAUUSD',
    side: 'buy',
    volume: '0.10',
    serverTime: SEND_FROM + 500,
    ...over,
  };
}

function scan(over: Partial<Mt5ReconcileObservation> = {}): Mt5ReconcileObservation {
  return {
    observedAt: SEND_TO + 1_000,
    connected: true,
    positionsScanned: true,
    ordersScanned: true,
    historySelected: true,
    historyFrom: SEND_FROM - 60_000,
    historyTo: SEND_TO + 60_000,
    candidates: [],
    ...over,
  };
}

describe('adversarial: false absence', () => {
  it('an empty scan on a disconnected terminal is not absence', () => {
    const verdict = classifyMt5Evidence(MAGIC, fingerprint, scan({ connected: false }));
    expect(verdict.outcome).toBe('indeterminate');
  });

  it.each([
    ['positions', { positionsScanned: false }],
    ['orders', { ordersScanned: false }],
    ['history', { historySelected: false }],
  ])('a scan that could not read %s is not absence', (_label, broken) => {
    expect(classifyMt5Evidence(MAGIC, fingerprint, scan(broken)).outcome).toBe('indeterminate');
  });

  it('history that starts after the send cannot prove absence', () => {
    // The order could have executed in the uncovered window.
    const verdict = classifyMt5Evidence(
      MAGIC,
      fingerprint,
      scan({ historyFrom: SEND_TO + 1, historyTo: SEND_TO + 60_000 }),
    );
    expect(verdict.outcome).toBe('indeterminate');
  });

  it('history that ends before the send cannot prove absence', () => {
    const verdict = classifyMt5Evidence(
      MAGIC,
      fingerprint,
      scan({ historyFrom: SEND_FROM - 60_000, historyTo: SEND_FROM - 1 }),
    );
    expect(verdict.outcome).toBe('indeterminate');
  });

  it('a complete connected scan covering the window is absence', () => {
    expect(classifyMt5Evidence(MAGIC, fingerprint, scan()).outcome).toBe('negative');
  });
});

describe('adversarial: execution truth', () => {
  it('a rejected historical order is never reconstructed as a fill', () => {
    const verdict = classifyMt5Evidence(
      MAGIC,
      fingerprint,
      scan({ candidates: [candidate({ kind: 'order', ticket: '9', orderState: 'REJECTED' })] }),
    );
    expect(verdict.outcome).toBe('terminal');
    if (verdict.outcome !== 'terminal') return;
    expect(verdict.venueState).toBe('REJECTED');
  });

  it('a working order proves receipt but not execution', () => {
    const verdict = classifyMt5Evidence(
      MAGIC,
      fingerprint,
      scan({ candidates: [candidate({ kind: 'order', ticket: '9', orderState: 'WORKING' })] }),
    );
    expect(verdict.outcome).toBe('indeterminate');
  });

  it('an active order coexisting with a partial position is not a clean fill', () => {
    // A partially filled entry leaves the remainder working. Reporting FILLED
    // would understate the exposure still to come.
    const verdict = classifyMt5Evidence(
      MAGIC,
      fingerprint,
      scan({
        candidates: [
          candidate({ kind: 'order', ticket: '9', orderState: 'PARTIAL' }),
          candidate({ kind: 'deal', ticket: '10', positionId: '77', volume: '0.04' }),
        ],
      }),
    );
    // Execution evidence exists, so this confirms — but it must carry the order
    // alongside so the caller can see the remainder is still working.
    expect(verdict.outcome).toBe('confirmed');
    if (verdict.outcome !== 'confirmed') return;
    expect(verdict.matches.some((m) => m.kind === 'order')).toBe(true);
  });

  it('two executions under one intent are a duplicate, never a fill', () => {
    const verdict = classifyMt5Evidence(
      MAGIC,
      fingerprint,
      scan({
        candidates: [
          candidate({ kind: 'position', ticket: '77', positionId: '77' }),
          candidate({ kind: 'position', ticket: '78', positionId: '78' }),
        ],
      }),
    );
    expect(verdict.outcome).toBe('duplicate');
  });
});

describe('adversarial: foreign and manual trades', () => {
  it('a manual trade matching symbol, side, volume and window is never confirmed', () => {
    // The operator opened the same thing by hand seconds after our send. Weak
    // similarity must not claim it.
    const verdict = classifyMt5Evidence(
      MAGIC,
      fingerprint,
      scan({
        candidates: [candidate({ magic: '0', kind: 'position', ticket: '55', positionId: '55' })],
      }),
    );
    expect(verdict.outcome).not.toBe('confirmed');
    expect(verdict.outcome).toBe('probable');
  });

  it('another system trade carrying a foreign magic is never confirmed', () => {
    const verdict = classifyMt5Evidence(
      MAGIC,
      fingerprint,
      scan({
        candidates: [
          candidate({ magic: FOREIGN, kind: 'position', ticket: '55', positionId: '55' }),
        ],
      }),
    );
    expect(verdict.outcome).not.toBe('confirmed');
  });

  it('two similar foreign trades cannot be narrowed to one by similarity', () => {
    const verdict = classifyMt5Evidence(
      MAGIC,
      fingerprint,
      scan({
        candidates: [
          candidate({ magic: '0', kind: 'position', ticket: '55', positionId: '55' }),
          candidate({ magic: '0', kind: 'position', ticket: '56', positionId: '56' }),
        ],
      }),
    );
    expect(verdict.outcome).toBe('indeterminate');
  });
});

describe('adversarial: clock domain', () => {
  it('a broker three hours ahead cannot pass its wall clock off as UTC', () => {
    expect(() =>
      assertUtcClockDomain({ utcMillis: Date.now() + 3 * 3_600_000 }, Date.now()),
    ).toThrow();
  });

  it('a broker behind UTC is refused too, which is the dangerous direction', () => {
    // Behind-UTC makes history coverage pass trivially, so false absence
    // becomes reachable.
    expect(() =>
      assertUtcClockDomain({ utcMillis: Date.now() - 5 * 3_600_000 }, Date.now()),
    ).toThrow();
  });
});

describe('adversarial: margin', () => {
  const fp = { symbol: 'XAUUSD', side: 'buy' as const, volume: '0.10', price: '2500.00' };
  const NOW = 1_700_000_000_000;

  it('an unavailable margin never becomes a number', () => {
    expect(
      marginForGovernor(
        parseMt5MarginResponse({ status: 'unavailable', reason: 'trade disabled' }, fp),
        NOW,
        5_000,
      ),
    ).toBeUndefined();
  });

  it('a timed-out margin (no response at all) never becomes a number', () => {
    expect(marginForGovernor(parseMt5MarginResponse(undefined, fp), NOW, 5_000)).toBeUndefined();
  });

  it('a malformed margin response never becomes a number', () => {
    expect(
      marginForGovernor(parseMt5MarginResponse({ requiredAccountCurrency: {} }, fp), NOW, 5_000),
    ).toBeUndefined();
  });

  it('a margin computed for a different order is refused', () => {
    const outcome = parseMt5MarginResponse(
      {
        status: 'available',
        requiredAccountCurrency: '240.00',
        asOfUtcMs: NOW,
        requestFingerprint: { ...fp, volume: '5.00' },
      },
      fp,
    );
    expect(marginForGovernor(outcome, NOW, 5_000)).toBeUndefined();
  });

  it('a fresh matching margin is usable', () => {
    const outcome = parseMt5MarginResponse(
      {
        status: 'available',
        requiredAccountCurrency: '240.00',
        asOfUtcMs: NOW,
        requestFingerprint: fp,
      },
      fp,
    );
    const value = marginForGovernor(outcome, NOW + 100, 5_000);
    expect(value).toBeDefined();
    if (value === undefined) return;
    expect(D.Decimal.toString(value)).toBe('240.00');
  });
});
