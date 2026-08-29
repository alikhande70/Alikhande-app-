import { describe, expect, it } from 'vitest';
import type { Mt5EvidenceCandidate, Mt5ReconcileObservation } from './evidence.js';
import { classifyMt5Evidence } from './observation.js';

const MAGIC = '281474976710777';
const fingerprint = {
  symbol: 'XAUUSD',
  side: 'buy' as const,
  volume: '0.01',
  sentNotBefore: 1_700_000_000_000,
  sentNotAfter: 1_700_000_001_000,
};

function observation(candidates: readonly Mt5EvidenceCandidate[]): Mt5ReconcileObservation {
  return {
    observedAt: 1_700_000_002_000,
    connected: true,
    positionsScanned: true,
    ordersScanned: true,
    historySelected: true,
    historyFrom: 1_699_999_990_000,
    historyTo: 1_700_000_020_000,
    candidates,
  };
}

function order(
  orderState: Mt5EvidenceCandidate['orderState'],
  ticket = '8001',
): Mt5EvidenceCandidate {
  return {
    kind: 'order',
    ticket,
    magic: MAGIC,
    symbol: 'XAUUSD',
    side: 'buy',
    volume: '0.01',
    price: '2500.30',
    serverTime: 1_700_000_000_500,
    orderState,
  };
}

function deal(): Mt5EvidenceCandidate {
  return {
    kind: 'deal',
    ticket: '9001',
    magic: MAGIC,
    symbol: 'XAUUSD',
    side: 'buy',
    volume: '0.01',
    price: '2500.30',
    serverTime: 1_700_000_000_600,
    positionId: '7001',
  };
}

describe('classifyMt5Evidence', () => {
  it.each(['REJECTED', 'CANCELLED', 'EXPIRED'] as const)(
    'positively resolves %s order-only history without claiming execution',
    (state) => {
      const verdict = classifyMt5Evidence(MAGIC, fingerprint, observation([order(state)]));
      expect(verdict).toMatchObject({ outcome: 'terminal', venueState: state });
      if (verdict.outcome === 'terminal') {
        expect(verdict.order.ticket).toBe('8001');
        expect(verdict.evidence).toContain(state);
      }
    },
  );

  it('keeps a FILLED historical order without deal/position evidence indeterminate', () => {
    const verdict = classifyMt5Evidence(MAGIC, fingerprint, observation([order('FILLED')]));
    expect(verdict).toMatchObject({ outcome: 'indeterminate' });
  });

  it('keeps conflicting terminal order evidence indeterminate', () => {
    const verdict = classifyMt5Evidence(
      MAGIC,
      fingerprint,
      observation([order('REJECTED', '8001'), order('CANCELLED', '8002')]),
    );
    expect(verdict).toMatchObject({ outcome: 'indeterminate' });
  });

  it('requires orderState on order evidence', () => {
    const invalid = {
      kind: 'order',
      ticket: '8001',
      magic: MAGIC,
      symbol: 'XAUUSD',
      side: 'buy',
      volume: '0.01',
      serverTime: 1_700_000_000_500,
    } as Mt5EvidenceCandidate;

    expect(() => classifyMt5Evidence(MAGIC, fingerprint, observation([invalid]))).toThrow(
      'orderState',
    );
  });

  it('confirms execution when an actual deal carries the expected magic', () => {
    const verdict = classifyMt5Evidence(MAGIC, fingerprint, observation([order('FILLED'), deal()]));
    expect(verdict.outcome).toBe('confirmed');
    if (verdict.outcome === 'confirmed') {
      expect(verdict.matches.some((candidate) => candidate.kind === 'deal')).toBe(true);
    }
  });
});

describe('duplicate execution detection', () => {
  const fp = {
    symbol: 'XAUUSD',
    side: 'buy' as const,
    volume: '0.10',
    sentNotBefore: 1_000,
    sentNotAfter: 2_000,
  };

  function cand(over: Partial<Mt5EvidenceCandidate>): Mt5EvidenceCandidate {
    return {
      kind: 'deal',
      ticket: '1',
      magic: '77',
      symbol: 'XAUUSD',
      side: 'buy',
      volume: '0.10',
      serverTime: 1_500,
      ...over,
    };
  }

  function obs(candidates: readonly Mt5EvidenceCandidate[]): Mt5ReconcileObservation {
    return {
      observedAt: 3_000,
      connected: true,
      positionsScanned: true,
      ordersScanned: true,
      historySelected: true,
      historyFrom: -100_000,
      historyTo: 100_000,
      candidates,
    };
  }

  it('confirms when one execution carries the magic, however many objects', () => {
    // A deal and the position it opened share the magic. Normal, not a duplicate.
    const verdict = classifyMt5Evidence(
      '77',
      fp,
      obs([
        cand({ kind: 'deal', ticket: '11', positionId: '900' }),
        cand({ kind: 'position', ticket: '900', positionId: '900' }),
      ]),
    );
    expect(verdict.outcome).toBe('confirmed');
  });

  it('refuses to confirm when the magic spans two distinct executions', () => {
    // The same intent reached the venue twice. Reporting `confirmed` would
    // attribute one execution and silently strand the other.
    const verdict = classifyMt5Evidence(
      '77',
      fp,
      obs([
        cand({ kind: 'position', ticket: '900', positionId: '900' }),
        cand({ kind: 'position', ticket: '901', positionId: '901' }),
      ]),
    );
    expect(verdict.outcome).toBe('duplicate');
    if (verdict.outcome !== 'duplicate') return;
    expect(verdict.reason).toContain('2 distinct executions');
  });

  it('never reports absence or a clean fill for a duplicate', () => {
    const verdict = classifyMt5Evidence(
      '77',
      fp,
      obs([
        cand({ kind: 'deal', ticket: '11', positionId: '900' }),
        cand({ kind: 'deal', ticket: '12', positionId: '901' }),
      ]),
    );
    expect(verdict.outcome).not.toBe('negative');
    expect(verdict.outcome).not.toBe('confirmed');
  });
});
