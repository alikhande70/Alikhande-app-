import { describe, expect, it } from 'vitest';
import {
  EVALUATION_COMPOSITION_VERSION,
  type FinalEvaluationPopulation,
  type ResearchSafeFinalEvaluationPolicy,
} from './evaluation-composition.js';
import {
  LEAKAGE_WINDOW_GUARD_VERSION,
  type LockedHoldoutAccessReceipt,
} from './leakage-window-guard.js';
import {
  buildLockedHoldoutEvaluation,
  LOCKED_HOLDOUT_EVALUATION_VERSION,
  sealLockedHoldoutPopulation,
} from './locked-holdout-evaluation.js';
import type { FixedHorizonOutcomePolicy } from './outcome-labeling.js';

function outcomePolicy(): FixedHorizonOutcomePolicy {
  return { labelVersion: 'fixed-horizon:v2', horizonMs: 60, flatThresholdR: 0.1 };
}

function population(): FinalEvaluationPopulation {
  return {
    ledgerHead: { seq: 12, hash: 'ledger-head-12' },
    pairedEligibility: [
      {
        missionId: 'holdout-1',
        scanConfigVersion: 'scan:v1',
        canonical: 'XAUUSD',
        observedAt: 200,
        knownAt: 205,
      },
      {
        missionId: 'holdout-2',
        scanConfigVersion: 'scan:v1',
        canonical: 'EURUSD',
        observedAt: 220,
        knownAt: 225,
      },
    ],
    missions: [],
    featureMissions: [
      { missionId: 'holdout-1', observedAt: 200 },
      { missionId: 'holdout-2', observedAt: 220 },
    ],
  } as unknown as FinalEvaluationPopulation;
}

function policy(): ResearchSafeFinalEvaluationPolicy {
  return {
    currentKnowledgeCutoff: 320,
    aggregate: { evaluationCutoff: 300 },
    paired: {},
    analysisPlan: {
      compositionVersion: EVALUATION_COMPOSITION_VERSION,
      planId: 'holdout-plan-1',
      challengerContentHash: `sha256:${'a'.repeat(64)}`,
      registeredAt: 150,
      analysisCutoff: 300,
      minimumPairingCoverage: 0.8,
      dependence: {},
      maturity: {},
      featureStrata: {
        featureKey: 'trend-alignment',
        featureSetVersion: 'features:v3',
      },
      outcome: outcomePolicy(),
      leakageWindow: {
        version: LEAKAGE_WINDOW_GUARD_VERSION,
        holdoutId: 'holdout-2026-q3',
        questionId: 'challenger-a-vs-champion',
        sealedAt: 150,
        holdoutStartAt: 180,
        holdoutEndAt: 240,
        embargoMs: 30,
        labelHorizonMs: 60,
      },
    },
  } as unknown as ResearchSafeFinalEvaluationPolicy;
}

function receipt(populationHash: string): LockedHoldoutAccessReceipt {
  return {
    holdoutId: 'holdout-2026-q3',
    questionId: 'challenger-a-vs-champion',
    openedAt: 310,
    evaluationCutoff: 300,
    populationHash,
  };
}

describe('locked holdout evaluation boundary', () => {
  it('seals the exact holdout population deterministically without exposing identities', () => {
    const first = sealLockedHoldoutPopulation(population(), outcomePolicy(), policy());
    const base = population();
    const reordered = {
      ...base,
      pairedEligibility: [...base.pairedEligibility].reverse(),
      featureMissions: [...base.featureMissions].reverse(),
    } as FinalEvaluationPopulation;
    const second = sealLockedHoldoutPopulation(reordered, outcomePolicy(), policy());

    expect(first.version).toBe(LOCKED_HOLDOUT_EVALUATION_VERSION);
    expect(first.populationCount).toBe(2);
    expect(first.populationHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.populationHash).toBe(first.populationHash);
    expect(first).not.toHaveProperty('missionIds');
  });

  it('refuses to seal a holdout before its locked window is complete', () => {
    const base = policy();
    const early = { ...base, currentKnowledgeCutoff: 230 } as ResearchSafeFinalEvaluationPolicy;
    expect(() => sealLockedHoldoutPopulation(population(), outcomePolicy(), early)).toThrow(
      /cannot be sealed before the holdout window is complete/,
    );
  });

  it('requires a durable receipt before any holdout evaluation can run', () => {
    expect(() =>
      buildLockedHoldoutEvaluation(population(), [], outcomePolicy(), policy(), []),
    ).toThrow(/requires exactly one durable access receipt/);
  });

  it('rejects a receipt bound to a different sealed population', () => {
    const bad = receipt(`sha256:${'b'.repeat(64)}`);
    expect(() =>
      buildLockedHoldoutEvaluation(population(), [], outcomePolicy(), policy(), [bad]),
    ).toThrow(/population hash does not match/);
  });

  it('invalidates repeated peeking instead of treating a second access as confirmation', () => {
    const seal = sealLockedHoldoutPopulation(population(), outcomePolicy(), policy());
    const first = receipt(seal.populationHash);
    const second = { ...first, openedAt: 315 };
    expect(() =>
      buildLockedHoldoutEvaluation(population(), [], outcomePolicy(), policy(), [first, second]),
    ).toThrow(/opened more than once/);
  });

  it('rejects an access receipt from the future relative to current knowledge', () => {
    const seal = sealLockedHoldoutPopulation(population(), outcomePolicy(), policy());
    const future = { ...receipt(seal.populationHash), openedAt: 330 };
    expect(() =>
      buildLockedHoldoutEvaluation(population(), [], outcomePolicy(), policy(), [future]),
    ).toThrow(/not yet known at currentKnowledgeCutoff/);
  });

  it('binds the receipt to the pre-registered analysis cutoff', () => {
    const seal = sealLockedHoldoutPopulation(population(), outcomePolicy(), policy());
    const drifted = { ...receipt(seal.populationHash), evaluationCutoff: 301 };
    expect(() =>
      buildLockedHoldoutEvaluation(population(), [], outcomePolicy(), policy(), [drifted]),
    ).toThrow(/evaluationCutoff must match the registered analysis cutoff/);
  });
});
