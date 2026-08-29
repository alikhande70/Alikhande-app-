import { describe, expect, it, vi } from 'vitest';
import type { HypothesisFamilyRegistrationRecord } from '../../../services/desk/src/ledger/events.js';
import {
  recordHypothesisFamilyRegistration,
  sealHypothesisFamilyRegistration,
} from '../../../services/desk/src/ledger/hypothesis-registration.js';
import { Ledger } from '../../../services/desk/src/ledger/ledger.js';
import { evaluateDurableRegisteredResearch } from '../../../services/desk/src/research/evaluation-orchestration.js';
import { evaluateLedgerRegisteredResearchFamily } from './public-evaluation-composition.js';

function memoryLedger(): Ledger {
  return new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 5_000 });
}

function registration(): HypothesisFamilyRegistrationRecord {
  return sealHypothesisFamilyRegistration({
    version: 'registered-hypothesis-family:v1',
    familyId: 'family-orchestration-a',
    registeredAt: 4_000,
    method: 'benjamini-hochberg',
    qLevel: 0.05,
    hypotheses: [
      {
        questionId: 'q-forward-edge',
        testId: 'paired-forward-v1',
        analysisPlanHash: 'sha256:plan-forward-edge',
        alternative: 'greater',
      },
    ],
  });
}

describe('Desk ledger to Brain research orchestration', () => {
  it('runs the public deterministic evaluator only after Desk resolves durable provenance', () => {
    const ledger = memoryLedger();
    const sealed = registration();
    const recorded = recordHypothesisFamilyRegistration(ledger, sealed, 4_250);

    const evaluation = evaluateDurableRegisteredResearch(
      ledger,
      sealed.familyId,
      [
        {
          questionId: 'q-forward-edge',
          testId: 'paired-forward-v1',
          analysisPlanHash: 'sha256:plan-forward-edge',
          firstEvidenceKnownAt: 4_500,
          evaluatedAt: 4_750,
          pValue: 0.01,
          status: 'complete' as const,
        },
      ],
      evaluateLedgerRegisteredResearchFamily,
    );

    expect(evaluation.status).toBe('complete');
    expect(evaluation.discoveries).toBe(1);
    expect(evaluation.promotionAction).toBe('none');
    expect(evaluation.registrationProvenance).toEqual({
      source: 'desk-hash-chained-ledger:v1',
      ledgerSeq: recorded.registration.ledgerSeq,
      ledgerHash: recorded.registration.ledgerHash,
      familyHash: sealed.familyHash,
      registeredAt: 4_000,
      registrationKnownAt: 4_250,
    });
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  });

  it('fails before evaluator invocation when the family is absent from durable storage', () => {
    const ledger = memoryLedger();
    const evaluator = vi.fn();

    expect(() =>
      evaluateDurableRegisteredResearch(ledger, 'missing-family', [], evaluator),
    ).toThrow(/does not exist in the durable ledger/);
    expect(evaluator).not.toHaveBeenCalled();
    ledger.close();
  });

  it('preserves anti-backdating when evidence predates durable registration', () => {
    const ledger = memoryLedger();
    const sealed = registration();
    recordHypothesisFamilyRegistration(ledger, sealed, 4_250);

    expect(() =>
      evaluateDurableRegisteredResearch(
        ledger,
        sealed.familyId,
        [
          {
            questionId: 'q-forward-edge',
            testId: 'paired-forward-v1',
            analysisPlanHash: 'sha256:plan-forward-edge',
            firstEvidenceKnownAt: 4_200,
            evaluatedAt: 4_750,
            pValue: 0.01,
            status: 'complete' as const,
          },
        ],
        evaluateLedgerRegisteredResearchFamily,
      ),
    ).toThrow(/evidence was already known before the family became durable/);
    ledger.close();
  });
});
