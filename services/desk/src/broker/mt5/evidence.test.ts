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
  const base: Mt5EvidenceCandidate = {
    kind: 'deal',
    ticket: '9001',
    magic: MAGIC,
    symbol: 'EURUSD',
    side: 'buy',
    volume: '0.10',
    price: '1.10000',
    serverTime: 10_050,
    positionId: '7001',
  };
  const merged = { ...base, ...overrides } as Mt5EvidenceCandidate;
  if (merged.kind === 'order' && merged.orderState === undefined) {
    return { ...merged, orderState: 'WORKING' };
  }
  return merged;
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
  it('treats matching magic as confirmed venue evidence without inventing execution state', () => {
    const rejectedOrder = candidate({ kind: 'order', ticket: '8001', orderState: 'REJECTED' });
    const result = resolveMt5Evidence(MAGIC, fingerprint, [observation(11_000, [rejectedOrder])]);

    expect(result.outcome).toBe('found');
    if (result.outcome === 'found') {
      expect(result.certainty).toBe('confirmed');
      expect(result.matches).toEqual([rejectedOrder]);
      expect(result.matches[0]?.orderState).toBe('REJECTED');
    }
  });

  it('does not count order/deal/position from one position as three fingerprint executions', () => {
    const result = resolveMt5Evidence(MAGIC, fingerprint, [
      observation(11_000, [
        candidate({ kind: 'order', ticket: '8001', magic: '0', orderState: 'FILLED' }),
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

  it('rejects order evidence that omits terminal/working state', () => {
    const invalid = {
      kind: 'order',
      ticket: '8001',
      magic: MAGIC,
      symbol: 'EURUSD',
      side: 'buy',
      volume: '0.10',
      serverTime: 10_050,
    } as Mt5EvidenceCandidate;

    expect(() => resolveMt5Evidence(MAGIC, fingerprint, [observation(11_000, [invalid])])).toThrow(
      'orderState',
    );
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
