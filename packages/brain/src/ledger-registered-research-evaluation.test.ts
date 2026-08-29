import { describe, expect, it } from 'vitest';
import {
  evaluateLedgerRegisteredResearchFamily,
  LEDGER_REGISTERED_RESEARCH_SOURCE,
  type LedgerRegisteredResearchFamily,
} from './ledger-registered-research-evaluation.js';

function input(overrides: Partial<LedgerRegisteredResearchFamily> = {}): LedgerRegisteredResearchFamily {
  return {
    source: LEDGER_REGISTERED_RESEARCH_SOURCE,
    ledgerSeq: 42,
    ledgerHash: 'a'.repeat(64),
    family: {
      version: 'registered-hypothesis-family:v1',
      familyId: 'family-ledger-a',
      registeredAt: 1_000,
      method: 'benjamini-hochberg',
      qLevel: 0.05,
      hypotheses: [
        {
          questionId: 'q1',
          testId: 'paired-forward-v1',
          analysisPlanHash: 'sha256:plan-q1',
          alternative: 'greater',
        },
      ],
    },
    receipt: {
      familyHash: 'sha256:78b79285ff68f3971583f6fa90d91aa1ec5b94dc2b39d84d43fe8a6509e2c7c5',
      knownAt: 1_100,
    },
    ...overrides,
  };
}

const results = [
  {
    questionId: 'q1',
    testId: 'paired-forward-v1',
    analysisPlanHash: 'sha256:plan-q1',
    firstEvidenceKnownAt: 1_200,
    evaluatedAt: 1_300,
    pValue: 0.01,
    status: 'complete' as const,
  },
];

describe('ledger-registered research evaluation boundary', () => {
  it('rejects non-ledger provenance before statistical evaluation', () => {
    expect(() =>
      evaluateLedgerRegisteredResearchFamily(
        { ...input(), source: 'forged-memory' as typeof LEDGER_REGISTERED_RESEARCH_SOURCE },
        results,
      ),
    ).toThrow(/Desk hash-chained ledger/);
  });

  it('rejects malformed durable row identity', () => {
    expect(() => evaluateLedgerRegisteredResearchFamily(input({ ledgerSeq: 0 }), results)).toThrow(
      /ledgerSeq/,
    );
    expect(() =>
      evaluateLedgerRegisteredResearchFamily(input({ ledgerHash: 'ABC' }), results),
    ).toThrow(/ledgerHash/);
  });

  it('still fails closed on family tampering even with plausible ledger provenance', () => {
    expect(() =>
      evaluateLedgerRegisteredResearchFamily(
        input({ family: { ...input().family, qLevel: 0.1 } }),
        results,
      ),
    ).toThrow(/family hash mismatch/);
  });
});
