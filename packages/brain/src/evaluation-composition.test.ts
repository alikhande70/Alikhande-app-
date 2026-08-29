import { describe, expect, it } from 'vitest';
import {
  EVALUATION_COMPOSITION_VERSION,
  type FinalEvaluationPolicy,
  type FinalEvaluationPopulation,
  validateFinalEvaluationComposition,
} from './evaluation-composition.js';

function population(): FinalEvaluationPopulation {
  return {
    ledgerHead: { seq: 8, hash: 'ledger-head-8' },
    pairedEligibility: [
      {
        missionId: 'scan-1',
        scanConfigVersion: 'scan:v1',
        canonical: 'XAUUSD',
        observedAt: 100,
        knownAt: 110,
      },
      {
        missionId: 'scan-2',
        scanConfigVersion: 'scan:v1',
        canonical: 'XAUUSD',
        observedAt: 120,
        knownAt: 130,
      },
    ],
    missions: [
      {
        missionId: 'scan-1',
        scanConfigVersion: 'scan:v1',
        canonical: 'XAUUSD',
        observedAt: 100,
        decisionSnapshot: {},
      },
    ],
    featureMissions: [
      { missionId: 'scan-1', observedAt: 100 },
      { missionId: 'scan-2', observedAt: 120 },
    ],
  } as unknown as FinalEvaluationPopulation;
}

function policy(): FinalEvaluationPolicy {
  return {
    currentKnowledgeCutoff: 300,
    aggregate: { evaluationCutoff: 250 },
    paired: {},
    analysisPlan: {
      compositionVersion: EVALUATION_COMPOSITION_VERSION,
      planId: 'plan-1',
      challengerContentHash: `sha256:${'a'.repeat(64)}`,
      registeredAt: 150,
      analysisCutoff: 250,
      minimumPairingCoverage: 0.8,
      dependence: {},
      maturity: {},
      featureStrata: {
        featureKey: 'trend-alignment',
        featureSetVersion: 'features:v3',
      },
    },
  } as unknown as FinalEvaluationPolicy;
}

describe('validateFinalEvaluationComposition', () => {
  it('audits one durable identity/timeline across every evaluation layer', () => {
    expect(validateFinalEvaluationComposition(population(), policy())).toEqual({
      compositionVersion: EVALUATION_COMPOSITION_VERSION,
      ledgerHead: { seq: 8, hash: 'ledger-head-8' },
      durableScanPopulation: 2,
      decisionMissionPopulation: 1,
      featureMissionPopulation: 2,
      earliestObservedAt: 100,
      latestObservedAt: 120,
      latestKnownAt: 130,
      analysisCutoff: 250,
    });
  });

  it('rejects a feature population that silently drops a durable scan', () => {
    const base = population();
    const malformed = {
      ...base,
      featureMissions: base.featureMissions.slice(0, 1),
    } as FinalEvaluationPopulation;
    expect(() => validateFinalEvaluationComposition(malformed, policy())).toThrow(
      /missing durable scan 'scan-2'/,
    );
  });

  it('rejects a feature population containing a scan outside the durable denominator', () => {
    const base = population();
    const malformed = {
      ...base,
      featureMissions: [...base.featureMissions, { missionId: 'scan-3', observedAt: 140 }],
    } as FinalEvaluationPopulation;
    expect(() => validateFinalEvaluationComposition(malformed, policy())).toThrow(
      /unknown scan 'scan-3'/,
    );
  });

  it('rejects decision Mission observation-time drift', () => {
    const base = population();
    const malformed = {
      ...base,
      missions: [{ ...base.missions[0], observedAt: 101 }],
    } as FinalEvaluationPopulation;
    expect(() => validateFinalEvaluationComposition(malformed, policy())).toThrow(
      /decision Mission observation-time drift/,
    );
  });

  it('rejects snapshot-feature observation-time drift', () => {
    const base = population();
    const malformed = {
      ...base,
      featureMissions: [base.featureMissions[0], { ...base.featureMissions[1], observedAt: 121 }],
    } as FinalEvaluationPopulation;
    expect(() => validateFinalEvaluationComposition(malformed, policy())).toThrow(
      /feature Mission observation-time drift/,
    );
  });

  it('rejects future durable evidence relative to the declared current knowledge boundary', () => {
    const base = policy();
    const staleKnowledge = { ...base, currentKnowledgeCutoff: 125 } as FinalEvaluationPolicy;
    expect(() => validateFinalEvaluationComposition(population(), staleKnowledge)).toThrow(
      /not yet known at currentKnowledgeCutoff/,
    );
  });

  it('rejects running an analysis plan before the plan was registered', () => {
    const base = policy();
    const impossible = { ...base, currentKnowledgeCutoff: 140 } as FinalEvaluationPolicy;
    expect(() => validateFinalEvaluationComposition(population(), impossible)).toThrow(
      /predate analysis-plan registration/,
    );
  });

  it('rejects aggregate/paired cutoff drift so hindsight cannot enter one side only', () => {
    const base = policy();
    const drifted = {
      ...base,
      aggregate: { ...base.aggregate, evaluationCutoff: 240 },
    } as FinalEvaluationPolicy;
    expect(() => validateFinalEvaluationComposition(population(), drifted)).toThrow(
      /cutoffs must be identical/,
    );
  });

  it('rejects duplicate durable identities before any statistical layer can count them', () => {
    const base = population();
    const malformed = {
      ...base,
      pairedEligibility: [...base.pairedEligibility, base.pairedEligibility[0]],
    } as FinalEvaluationPopulation;
    expect(() => validateFinalEvaluationComposition(malformed, policy())).toThrow(
      /duplicate mission 'scan-1'/,
    );
  });

  it('rejects an unknown composition semantics version', () => {
    const base = policy();
    const malformed = {
      ...base,
      analysisPlan: { ...base.analysisPlan, compositionVersion: 'evaluation-composition:v2' },
    } as unknown as FinalEvaluationPolicy;
    expect(() => validateFinalEvaluationComposition(population(), malformed)).toThrow(
      /unsupported evaluation composition version/,
    );
  });
});
