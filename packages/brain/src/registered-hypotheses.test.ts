import { describe, expect, it } from 'vitest';
import {
  evaluateRegisteredHypothesisFamily,
  REGISTERED_HYPOTHESIS_FAMILY_VERSION,
  type RegisteredHypothesisFamily,
  type RegisteredHypothesisFamilyReceipt,
  type RegisteredTestResult,
  sealRegisteredHypothesisFamily,
} from './registered-hypotheses.js';

function family(): RegisteredHypothesisFamily {
  return {
    version: REGISTERED_HYPOTHESIS_FAMILY_VERSION,
    familyId: 'brain-v3-xauusd-2026q3',
    registeredAt: 100,
    method: 'benjamini-hochberg',
    qLevel: 0.05,
    hypotheses: [
      {
        questionId: 'q1',
        testId: 'paired-sign-v1',
        analysisPlanHash: 'sha256:plan-1',
        alternative: 'greater',
      },
      {
        questionId: 'q2',
        testId: 'paired-sign-v1',
        analysisPlanHash: 'sha256:plan-2',
        alternative: 'greater',
      },
      {
        questionId: 'q3',
        testId: 'paired-sign-v1',
        analysisPlanHash: 'sha256:plan-3',
        alternative: 'greater',
      },
      {
        questionId: 'q4',
        testId: 'paired-sign-v1',
        analysisPlanHash: 'sha256:plan-4',
        alternative: 'greater',
      },
    ],
  };
}

function receipt(
  input: RegisteredHypothesisFamily,
  knownAt = 105,
): RegisteredHypothesisFamilyReceipt {
  return { familyHash: sealRegisteredHypothesisFamily(input), knownAt };
}

function results(pValues: readonly number[]): RegisteredTestResult[] {
  return pValues.map((pValue, index) => ({
    questionId: `q${index + 1}`,
    testId: 'paired-sign-v1',
    analysisPlanHash: `sha256:plan-${index + 1}`,
    firstEvidenceKnownAt: 110 + index,
    evaluatedAt: 500,
    pValue,
    status: 'complete',
  }));
}

function replaceResult(
  source: readonly RegisteredTestResult[],
  index: number,
  patch: Partial<RegisteredTestResult>,
): RegisteredTestResult[] {
  return source.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item));
}

describe('registered hypothesis families', () => {
  it('applies deterministic Benjamini-Hochberg FDR control to the complete registered family', () => {
    const input = family();
    const evaluation = evaluateRegisteredHypothesisFamily(
      input,
      receipt(input),
      results([0.001, 0.03, 0.04, 0.2]),
    );

    expect(evaluation.status).toBe('complete');
    expect(evaluation.discoveries).toBe(1);
    expect(evaluation.promotionAction).toBe('none');
    expect(evaluation.decisions.map((item) => [item.questionId, item.discovery])).toEqual([
      ['q1', true],
      ['q2', false],
      ['q3', false],
      ['q4', false],
    ]);
    expect(evaluation.decisions[0]?.adjustedPValue).toBeCloseTo(0.004);
  });

  it('uses the largest passing rank and rejects every earlier ordered p-value', () => {
    const input = family();
    const evaluation = evaluateRegisteredHypothesisFamily(
      input,
      receipt(input),
      results([0.01, 0.024, 0.03, 0.2]),
    );
    expect(evaluation.discoveries).toBe(3);
    expect(evaluation.decisions.slice(0, 3).every((item) => item.discovery)).toBe(true);
  });

  it('fails closed when a registered question is missing instead of shrinking the family denominator', () => {
    const input = family();
    expect(() =>
      evaluateRegisteredHypothesisFamily(input, receipt(input), results([0.001, 0.02, 0.03])),
    ).toThrow(/exactly match/);
  });

  it('reports the whole family as insufficient-data when any registered question is unresolved', () => {
    const input = family();
    const unresolved = replaceResult(results([0.001, 0.02, 0.03, 0.2]), 3, {
      pValue: null,
      status: 'insufficient-data',
    });
    const evaluation = evaluateRegisteredHypothesisFamily(input, receipt(input), unresolved);
    expect(evaluation.status).toBe('insufficient-data');
    expect(evaluation.discoveries).toBe(0);
    expect(evaluation.decisions.every((item) => item.discovery === false)).toBe(true);
  });

  it('rejects backdated registration when evidence predates durable knowledge', () => {
    const input = family();
    expect(() =>
      evaluateRegisteredHypothesisFamily(
        input,
        receipt(input, 120),
        results([0.001, 0.02, 0.03, 0.2]),
      ),
    ).toThrow(/evidence was already known before the family became durable/);
  });

  it('rejects a receipt that claims durability before the family registeredAt', () => {
    const input = family();
    expect(() =>
      evaluateRegisteredHypothesisFamily(
        input,
        receipt(input, 99),
        results([0.001, 0.02, 0.03, 0.2]),
      ),
    ).toThrow(/cannot become durable before registeredAt/);
  });

  it('rejects analysis-plan or test drift after registration', () => {
    const input = family();
    const drifted = replaceResult(results([0.001, 0.02, 0.03, 0.2]), 1, {
      analysisPlanHash: 'sha256:changed-after-results',
    });
    expect(() => evaluateRegisteredHypothesisFamily(input, receipt(input), drifted)).toThrow(
      /analysisPlanHash drift/,
    );
  });

  it('rejects a modified family whose immutable seal no longer matches', () => {
    const input = family();
    const sealedReceipt = receipt(input);
    const modified: RegisteredHypothesisFamily = { ...input, qLevel: 0.1 };
    expect(() =>
      evaluateRegisteredHypothesisFamily(
        modified,
        sealedReceipt,
        results([0.001, 0.02, 0.03, 0.2]),
      ),
    ).toThrow(/family hash mismatch/);
  });

  it('rejects duplicate results, unregistered questions and impossible bitemporal order', () => {
    const input = family();
    const registration = receipt(input);
    const duplicate = replaceResult(results([0.001, 0.02, 0.03, 0.2]), 3, {
      questionId: 'q1',
      analysisPlanHash: 'sha256:plan-1',
    });
    expect(() => evaluateRegisteredHypothesisFamily(input, registration, duplicate)).toThrow(
      /duplicate test result/,
    );

    const future = replaceResult(results([0.001, 0.02, 0.03, 0.2]), 0, {
      firstEvidenceKnownAt: 600,
      evaluatedAt: 500,
    });
    expect(() => evaluateRegisteredHypothesisFamily(input, registration, future)).toThrow(
      /evaluated before/,
    );
  });
});
