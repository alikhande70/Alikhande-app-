import { describe, expect, it } from 'vitest';
import {
  type Mt5EvidenceCandidate,
  type Mt5ReconcileObservation,
  resolveMt5Evidence,
} from './evidence.js';

const MAGIC = '281474976710777';
const fingerprint = {
  symbol: 'EURUSD',
  side: 'buy' as const,
  volume: '0.10',
  sentNotBefore: 10_000,
  sentNotAfter: 10_100,
};

function candidate(overrides: Partial<Mt5EvidenceCandidate> = {}): Mt5EvidenceCandidate {
  return {
    kind: 'deal',
    ticket: '9001',
    magic: MAGIC,
    symbol: 'EURUSD',
    side: 'buy',
    volume: '0.10',
    price: '1.10000',
    serverTime: 10_050,
    positionId: '7001',
    ...overrides,
  };
}

function observation(
  observedAt: number,
  candidates: readonly Mt5EvidenceCandidate[] = [],
  overrides: Partial<Mt5ReconcileObservation> = {},
): Mt5ReconcileObservation {
  return {
    observedAt,
    connected: true,
    positionsScanned: true,
    ordersScanned: true,
    historySelected: true,
    historyFrom: 0,
    historyTo: 20_000,
    candidates,
    ...overrides,
  };
}

describe('resolveMt5Evidence', () => {
  it('treats any matching magic in broker state/history as confirmed existence', () => {
    const result = resolveMt5Evidence(MAGIC, fingerprint, [
      observation(11_000, [candidate()]),
      observation(12_000),
    ]);

    expect(result.outcome).toBe('found');
    if (result.outcome === 'found') {
      expect(result.certainty).toBe('confirmed');
      expect(result.matches).toHaveLength(1);
    }
  });

  it('does not count order/deal/position from one position as three fingerprint executions', () => {
    const result = resolveMt5Evidence(MAGIC, fingerprint, [
      observation(11_000, [
        candidate({ kind: 'order', ticket: '8001', magic: '0' }),
        candidate({ kind: 'deal', ticket: '9001', magic: '0' }),
        candidate({ kind: 'position', ticket: '7001', magic: '0' }),
      ]),
    ]);

    expect(result.outcome).toBe('probable');
    if (result.outcome === 'probable') expect(result.matches).toHaveLength(3);
  });

  it('refuses to guess when the fallback fingerprint matches multiple executions', () => {
    const result = resolveMt5Evidence(MAGIC, fingerprint, [
      observation(11_000, [
        candidate({ ticket: '9001', magic: '0', positionId: '7001' }),
        candidate({ ticket: '9002', magic: '0', positionId: '7002' }),
      ]),
    ]);

    expect(result).toMatchObject({ outcome: 'indeterminate' });
  });

  it('requires repeated separated full negatives before declaring absence', () => {
    expect(resolveMt5Evidence(MAGIC, fingerprint, [observation(11_000)])).toMatchObject({
      outcome: 'indeterminate',
    });

    expect(
      resolveMt5Evidence(MAGIC, fingerprint, [observation(11_000), observation(11_500)]),
    ).toMatchObject({ outcome: 'indeterminate' });

    expect(
      resolveMt5Evidence(MAGIC, fingerprint, [observation(11_000), observation(12_000)]),
    ).toMatchObject({ outcome: 'absent' });
  });

  it('does not treat disconnected or incomplete history as evidence of absence', () => {
    const result = resolveMt5Evidence(MAGIC, fingerprint, [
      observation(11_000, [], { connected: false }),
      observation(12_000, [], { historySelected: false }),
      observation(13_000, [], { positionsScanned: false }),
    ]);

    expect(result).toMatchObject({ outcome: 'indeterminate' });
  });

  it('requires the selected history window to cover the ambiguous send', () => {
    const result = resolveMt5Evidence(MAGIC, fingerprint, [
      observation(11_000, [], { historyFrom: 9_500 }),
      observation(12_000, [], { historyFrom: 9_500 }),
    ]);

    expect(result).toMatchObject({ outcome: 'indeterminate' });
  });

  it('deduplicates repeated sightings of the same MT5 object across reconciliations', () => {
    const sameDeal = candidate();
    const result = resolveMt5Evidence(MAGIC, fingerprint, [
      observation(11_000, [sameDeal]),
      observation(12_000, [sameDeal]),
    ]);

    expect(result.outcome).toBe('found');
    if (result.outcome === 'found') expect(result.matches).toHaveLength(1);
  });
});

describe('duplicate execution detection', () => {
  const dupFingerprint = {
    symbol: 'XAUUSD',
    side: 'buy' as const,
    volume: '0.10',
    sentNotBefore: 1_000,
    sentNotAfter: 2_000,
  };

  function candidate(over: Partial<Mt5EvidenceCandidate>): Mt5EvidenceCandidate {
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

  function observation(candidates: readonly Mt5EvidenceCandidate[]): Mt5ReconcileObservation {
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
    // An order, its deal and its position all share the magic. That is normal
    // and must not be mistaken for two executions.
    const verdict = resolveMt5Evidence('77', dupFingerprint, [
      observation([
        candidate({ kind: 'order', ticket: '10', positionId: '900' }),
        candidate({ kind: 'deal', ticket: '11', positionId: '900' }),
        candidate({ kind: 'position', ticket: '900', positionId: '900' }),
      ]),
    ]);
    expect(verdict.outcome).toBe('found');
  });

  it('refuses to confirm when the magic spans two distinct executions', () => {
    // Found in audit. The fingerprint path always grouped before deciding; the
    // exact-magic path did not, so the same intent reaching the venue twice was
    // reported as one clean fill and the second position was stranded.
    const verdict = resolveMt5Evidence('77', dupFingerprint, [
      observation([
        candidate({ kind: 'deal', ticket: '11', positionId: '900' }),
        candidate({ kind: 'deal', ticket: '12', positionId: '901' }),
      ]),
    ]);
    expect(verdict.outcome).toBe('duplicate');
    if (verdict.outcome !== 'duplicate') return;
    expect(verdict.reason).toContain('2 distinct executions');
  });

  it('never reports absence or a clean fill when a duplicate is present', () => {
    const verdict = resolveMt5Evidence('77', dupFingerprint, [
      observation([
        candidate({ kind: 'position', ticket: '900', positionId: '900' }),
        candidate({ kind: 'position', ticket: '901', positionId: '901' }),
      ]),
    ]);
    expect(verdict.outcome).not.toBe('absent');
    expect(verdict.outcome).not.toBe('found');
  });
});
