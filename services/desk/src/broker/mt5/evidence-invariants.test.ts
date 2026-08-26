import fc from 'fast-check';
import { describe, it } from 'vitest';
import type {
  Mt5EvidenceCandidate,
  Mt5EvidenceOrderState,
  Mt5ReconcileObservation,
} from './evidence.js';
import { classifyMt5Evidence } from './observation.js';

/**
 * Invariants the single evidence classifier must hold for *any* input.
 *
 * These are written to attack the classifier, not to mirror it. Each one
 * corresponds to a way the system could report a trade that does not exist, or
 * miss one that does — so a counterexample here is a real defect, not a test
 * that needs relaxing.
 */

const MAGIC = '281474976710777';
const OTHER_MAGIC = '281474976710778';

const orderStates: Mt5EvidenceOrderState[] = [
  'PENDING_SUBMIT',
  'WORKING',
  'PARTIAL',
  'FILLED',
  'CANCEL_PENDING',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'UNKNOWN',
];

const fingerprint = {
  symbol: 'XAUUSD',
  side: 'buy' as const,
  volume: '0.10',
  sentNotBefore: 1_000_000,
  sentNotAfter: 1_001_000,
};

const arbCandidate = fc
  .record({
    kind: fc.constantFrom('order', 'deal', 'position'),
    ticket: fc.integer({ min: 1, max: 9_999 }).map(String),
    magic: fc.constantFrom(MAGIC, OTHER_MAGIC, '0'),
    symbol: fc.constantFrom('XAUUSD', 'EURUSD'),
    side: fc.constantFrom('buy', 'sell'),
    volume: fc.constantFrom('0.01', '0.10', '1.00'),
    serverTime: fc.integer({ min: 999_000, max: 1_002_000 }),
    positionId: fc.option(fc.integer({ min: 1, max: 20 }).map(String), { nil: undefined }),
    orderState: fc.constantFrom(...orderStates),
  })
  .map((row): Mt5EvidenceCandidate => {
    const base = {
      kind: row.kind as Mt5EvidenceCandidate['kind'],
      ticket: row.ticket,
      magic: row.magic,
      symbol: row.symbol,
      side: row.side as 'buy' | 'sell',
      volume: row.volume,
      serverTime: row.serverTime,
      ...(row.positionId === undefined ? {} : { positionId: row.positionId }),
    };
    // orderState is required on orders and forbidden elsewhere.
    return row.kind === 'order' ? { ...base, orderState: row.orderState } : base;
  });

const arbObservation = fc
  .record({
    connected: fc.boolean(),
    positionsScanned: fc.boolean(),
    ordersScanned: fc.boolean(),
    historySelected: fc.boolean(),
    historyFrom: fc.integer({ min: 0, max: 1_000_000 }),
    historySpan: fc.integer({ min: 0, max: 2_000_000 }),
    candidates: fc.array(arbCandidate, { maxLength: 6 }),
  })
  .map(
    (row): Mt5ReconcileObservation => ({
      observedAt: 1_002_000,
      connected: row.connected,
      positionsScanned: row.positionsScanned,
      ordersScanned: row.ordersScanned,
      historySelected: row.historySelected,
      historyFrom: row.historyFrom,
      historyTo: row.historyFrom + row.historySpan,
      candidates: row.candidates,
    }),
  );

describe('evidence classifier invariants', () => {
  it('never reports absence while any candidate carries the expected magic', () => {
    // The cardinal rule. If our magic is present anywhere in the scan, "the
    // order does not exist" is false regardless of scan completeness.
    fc.assert(
      fc.property(arbObservation, (observation) => {
        const verdict = classifyMt5Evidence(MAGIC, fingerprint, observation);
        const carriesMagic = observation.candidates.some((c) => c.magic === MAGIC);
        return !(carriesMagic && verdict.outcome === 'negative');
      }),
      { numRuns: 2_000 },
    );
  });

  it('never confirms a fill from order evidence alone', () => {
    // An order proves the venue received the request. Only a deal or position
    // proves anything executed.
    fc.assert(
      fc.property(arbObservation, (observation) => {
        const verdict = classifyMt5Evidence(MAGIC, fingerprint, observation);
        if (verdict.outcome !== 'confirmed') return true;
        return verdict.matches.some((m) => m.kind === 'deal' || m.kind === 'position');
      }),
      { numRuns: 2_000 },
    );
  });

  it('never concludes absence on an incomplete or disconnected scan', () => {
    fc.assert(
      fc.property(arbObservation, (observation) => {
        const verdict = classifyMt5Evidence(MAGIC, fingerprint, observation);
        if (verdict.outcome !== 'negative') return true;
        return (
          observation.connected &&
          observation.positionsScanned &&
          observation.ordersScanned &&
          observation.historySelected
        );
      }),
      { numRuns: 2_000 },
    );
  });

  it('never concludes absence when history does not cover the send window', () => {
    fc.assert(
      fc.property(arbObservation, (observation) => {
        const verdict = classifyMt5Evidence(MAGIC, fingerprint, observation);
        if (verdict.outcome !== 'negative') return true;
        return (
          observation.historyFrom <= fingerprint.sentNotBefore &&
          observation.historyTo >= fingerprint.sentNotAfter
        );
      }),
      { numRuns: 2_000 },
    );
  });

  it('never attributes a foreign magic as our execution', () => {
    // Weak similarity must not claim someone else's trade. A candidate whose
    // magic is not ours may only ever be `probable`, never `confirmed`.
    fc.assert(
      fc.property(arbObservation, (observation) => {
        const verdict = classifyMt5Evidence(MAGIC, fingerprint, observation);
        if (verdict.outcome !== 'confirmed') return true;
        return verdict.matches.every((m) => m.magic === MAGIC);
      }),
      { numRuns: 2_000 },
    );
  });

  it('reports duplicate whenever our magic spans two distinct executions', () => {
    // The grouping below is deliberately an *independent* formulation, not a
    // copy of `groupKey`. That is why it works: the implementation used to
    // build keys that could collide across two id spaces, and a test that
    // mirrored the implementation would have collided identically and passed.
    // An invariant test that reproduces the code under test proves nothing.
    fc.assert(
      fc.property(arbObservation, (observation) => {
        const verdict = classifyMt5Evidence(MAGIC, fingerprint, observation);
        const executions = new Set(
          observation.candidates
            .filter((c) => c.magic === MAGIC && (c.kind === 'deal' || c.kind === 'position'))
            .map((c) =>
              c.positionId === undefined ? `${c.kind}:${c.ticket}` : `p:${c.positionId}`,
            ),
        );
        if (executions.size <= 1) return true;
        return verdict.outcome === 'duplicate';
      }),
      { numRuns: 2_000 },
    );
  });

  it('is deterministic for identical input', () => {
    fc.assert(
      fc.property(arbObservation, (observation) => {
        const a = classifyMt5Evidence(MAGIC, fingerprint, observation);
        const b = classifyMt5Evidence(MAGIC, fingerprint, observation);
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 500 },
    );
  });
});
