import { describe, expect, it } from 'vitest';
import {
  evaluateRegisteredHypothesisFamily,
  REGISTERED_HYPOTHESIS_FAMILY_VERSION,
  sealRegisteredHypothesisFamily,
  type RegisteredHypothesisFamily,
  type RegisteredTestResult,
} from './registered-hypotheses.js';

function family(): RegisteredHypothesisFamily {
  return {
    version: REGISTERED_HYPOTHESIS_FAMILY_VERSION,
    familyId: 'brain-v3-xauusd-2026q3',
    registeredAt: 100,
    method: 'benjamini-hochberg',
    qLevel: 0.05,
    hypotheses: [
      { questionId: 'q1', testId: 'paired-sign-v1', analysisPlanHash: 'sha256:plan-1', alternative: 'greater' },
      { questionId: 'q2', testId: 'paired-sign-v1', analysisPlanHash: 'sha256:plan-2', alternative: 'greater' },
      { questionId: 'q3', testId: 'paired-sign-v1', analysisPlanHash: 'sha256:plan-3', alternative: 'greater' },
      { questionId: 'q4', testId: 'paired-sign-v1', analysisPlanHash: 'sha256:plan-4', alternative: 'greater' },
    ],
  };
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

describe('registered hypothesis families', () => {
  it('applies deterministic Benjamini-Hochberg FDR control to the complete registered family', () => {
    const input = family();
    const sealed = sealRegisteredHypothesisFamily(input);
    const evaluation = evaluateRegisteredHypothesisFamily(
      input,
      sealed,
      results([0.001, 0.02, 0.03, 0.2]),
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
      sealRegisteredHypothesisFamily(input),
      results([0.01, 0.024, 0.03, 0.2]),
    );
    expect(evaluation.discoveries).toBe(3);
    expect(evaluation.decisions.slice(0, 3).every((item) => item.discovery)).toBe(true);
  });

  it('fails closed when a registered question is missing instead of shrinking the family denominator', () => {
    const input = family();
    expect(() =>
      evaluateRegisteredHypothesisFamily(
        input,
        sealRegisteredHypothesisFamily(input),
        results([0.001, 0.02, 0.03]),
      ),
    ).toThrow(/exactly match/);
  });

  it('reports the whole family as insufficient-data when any registered question is unresolved', () => {
    const input = family();
    const unresolved: RegisteredTestResult[] = results([0.001, 0.02, 0.03, 0.2]);
    unresolved[3] = {
      ...unresolved[3]!,
      pValue: null,
      status: 'insufficient-data',
    };
    const evaluation = evaluateRegisteredHypothesisFamily(
      input,
      sealRegisteredHypothesisFamily(input),
      unresolved,
    );
    expect(evaluation.status).toBe('insufficient-data');
    expect(evaluation.discoveries).toBe(0);
    expect(evaluation.decisions.every((item) => item.discovery === false)).toBe(true);
  });

  it('rejects late registration after evidence was already known', () => {
    const input = family();
    const contaminated = results([0.001, 0.02, 0.03, 0.2]);
    contaminated[0] = { ...contaminated[0]!, firstEvidenceKnownAt: 99 };
    expect(() =>
      evaluateRegisteredHypothesisFamily(
        input,
        sealRegisteredHypothesisFamily(input),
        contaminated,
      ),
    ).toThrow(/registered after evidence became known/);
  });

  it('rejects analysis-plan or test drift after registration', () => {
    const input = family();
    const drifted = results([0.001, 0.02, 0.03, 0.2]);
    drifted[1] = { ...drifted[1]!, analysisPlanHash: 'sha256:changed-after-results' };
    expect(() =>
      evaluateRegisteredHypothesisFamily(
        input,
        sealRegisteredHypothesisFamily(input),
        drifted,
      ),
    ).toThrow(/analysisPlanHash drift/);
  });

  it('rejects a modified family whose immutable seal no longer matches', () => {
    const input = family();
    const sealed = sealRegisteredHypothesisFamily(input);
    const modified: RegisteredHypothesisFamily = { ...input, qLevel: 0.1 };
    expect(() => evaluateRegisteredHypothesisFamily(modified, sealed, results([0.001, 0.02, 0.03, 0.2]))).toThrow(
      /family hash mismatch/,
    );
  });

  it('rejects duplicate results, unregistered questions and impossible bitemporal order', () => {
    const input = family();
    const sealed = sealRegisteredHypothesisFamily(input);
    const duplicate = results([0.001, 0.02, 0.03, 0.2]);
    duplicate[3] = { ...duplicate[3]!, questionId: 'q1', analysisPlanHash: 'sha256:plan-1' };
    expect(() => evaluateRegisteredHypothesisFamily(input, sealed, duplicate)).toThrow(/duplicate test result/);

    const future = results([0.001, 0.02, 0.03, 0.2]);
    future[0] = { ...future[0]!, firstEvidenceKnownAt: 600, evaluatedAt: 500 };
    expect(() => evaluateRegisteredHypothesisFamily(input, sealed, future)).toThrow(/evaluated before/);
  });
});
