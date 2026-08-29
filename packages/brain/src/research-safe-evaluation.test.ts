import { describe, expect, it } from 'vitest';
import {
  EVALUATION_COMPOSITION_VERSION,
  projectResearchSafeEvaluationPopulation,
  type FinalEvaluationPopulation,
  type ResearchSafeFinalEvaluationPolicy,
} from './evaluation-composition.js';
import { LEAKAGE_WINDOW_GUARD_VERSION } from './leakage-window-guard.js';
import type { FixedHorizonOutcomePolicy } from './outcome-labeling.js';

function outcomePolicy(): FixedHorizonOutcomePolicy {
  return {
    labelVersion: 'fixed-horizon:v2',
    horizonMs: 300,
    flatThresholdR: 0.1,
  };
}

function population(): FinalEvaluationPopulation {
  const scans = [
    ['research-before', 1_600, 1_610],
    ['purged', 1_800, 1_810],
    ['holdout', 2_400, 2_410],
    ['embargoed', 3_100, 3_110],
    ['research-after', 3_300, 3_310],
  ] as const;
  return {
    ledgerHead: { seq: 20, hash: 'ledger-head-20' },
    pairedEligibility: scans.map(([missionId, observedAt, knownAt]) => ({
      missionId,
      scanConfigVersion: 'scan:v1',
      canonical: 'XAUUSD',
      observedAt,
      knownAt,
    })),
    missions: [],
    featureMissions: scans.map(([missionId, observedAt]) => ({ missionId, observedAt })),
  } as unknown as FinalEvaluationPopulation;
}

function policy(): ResearchSafeFinalEvaluationPolicy {
  return {
    currentKnowledgeCutoff: 4_000,
    aggregate: { evaluationCutoff: 3_500 },
    paired: {},
    analysisPlan: {
      compositionVersion: EVALUATION_COMPOSITION_VERSION,
      planId: 'plan-research-safe',
      challengerContentHash: `sha256:${'a'.repeat(64)}`,
      registeredAt: 1_500,
      analysisCutoff: 3_500,
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
        sealedAt: 1_000,
        holdoutStartAt: 2_000,
        holdoutEndAt: 3_000,
        embargoMs: 200,
        labelHorizonMs: 300,
      },
    },
  } as unknown as ResearchSafeFinalEvaluationPolicy;
}

describe('projectResearchSafeEvaluationPopulation', () => {
  it('removes purged, locked-holdout and embargoed scans from every evaluator projection', () => {
    const result = projectResearchSafeEvaluationPopulation(population(), outcomePolicy(), policy());

    expect(result.population.pairedEligibility.map((item) => item.missionId)).toEqual([
      'research-before',
      'research-after',
    ]);
    expect(result.population.featureMissions.map((item) => item.missionId)).toEqual([
      'research-before',
      'research-after',
    ]);
    expect(result.audit).toMatchObject({
      sourcePopulation: 5,
      researchPopulation: 2,
      purgedPopulation: 1,
      holdoutPopulation: 1,
      embargoedPopulation: 1,
    });
  });

  it('does not return locked-holdout Mission identities in the research projection or audit', () => {
    const result = projectResearchSafeEvaluationPopulation(population(), outcomePolicy(), policy());
    expect(JSON.stringify(result)).not.toContain('"holdout"');
    expect(JSON.stringify(result)).not.toContain('"embargoed"');
    expect(JSON.stringify(result)).not.toContain('"purged"');
  });

  it('rejects label-horizon drift between leakage protection and outcome evaluation', () => {
    const base = policy();
    const drifted = {
      ...base,
      analysisPlan: {
        ...base.analysisPlan,
        leakageWindow: { ...base.analysisPlan.leakageWindow, labelHorizonMs: 301 },
      },
    } as ResearchSafeFinalEvaluationPolicy;
    expect(() =>
      projectResearchSafeEvaluationPopulation(population(), outcomePolicy(), drifted),
    ).toThrow(/label horizon must match/);
  });

  it('validates the full durable population before filtering so malformed holdout rows cannot hide', () => {
    const base = population();
    const malformed = {
      ...base,
      featureMissions: base.featureMissions.filter((item) => item.missionId !== 'holdout'),
    } as FinalEvaluationPopulation;
    expect(() =>
      projectResearchSafeEvaluationPopulation(malformed, outcomePolicy(), policy()),
    ).toThrow(/missing durable scan 'holdout'/);
  });
});
