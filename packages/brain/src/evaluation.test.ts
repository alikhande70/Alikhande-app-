import { describe, expect, it } from 'vitest';
import {
  type EvaluationPolicy,
  evaluateScanPopulation,
  type ScanDecisionEvidence,
} from './evaluation.js';

const hash = `sha256:${'a'.repeat(64)}`;
const policy: EvaluationPolicy = {
  minimumScans: 2,
  minimumOutcomes: 2,
  evaluationCutoff: 10_000,
};

function scan(
  missionId: string,
  overrides: Partial<ScanDecisionEvidence> = {},
): ScanDecisionEvidence {
  return {
    missionId,
    scanConfigVersion: 'scan-v1',
    knowledgeTime: 1_000,
    brainContentHash: hash,
    brainVersion: 'brain-v1',
    decision: { status: 'scored', score: 70 },
    outcome: {
      validAt: 2_000,
      recordedAt: 2_100,
      directional: 'favourable',
      counterfactualR: 1.2,
    },
    ...overrides,
  };
}

describe('scan-level evaluator', () => {
  it('keeps decision evidence separate from future market and trade outcomes', () => {
    const report = evaluateScanPopulation(
      [
        scan('m1', {
          decision: { status: 'scored', score: 80 },
          outcome: {
            validAt: 2_000,
            recordedAt: 2_100,
            directional: 'unfavourable',
            counterfactualR: -1,
            realisedTradeR: -0.8,
          },
        }),
        scan('m2', {
          decision: { status: 'scored', score: 40 },
          outcome: {
            validAt: 2_200,
            recordedAt: 2_300,
            directional: 'favourable',
            counterfactualR: 2,
          },
        }),
      ],
      policy,
    );

    expect(report.status).toBe('ready');
    expect(report.decisionQuality).toEqual({
      totalScans: 2,
      scoredScans: 2,
      insufficientDataScans: 0,
      coverage: 1,
      meanScore: 60,
    });
    expect(report.outcomes).toEqual({
      eligibleOutcomes: 2,
      favourable: 1,
      unfavourable: 1,
      flat: 0,
      meanCounterfactualR: 0.5,
      realisedTrades: 1,
      meanRealisedTradeR: -0.8,
    });
  });

  it('counts rejected and insufficient-data scans in the population', () => {
    const report = evaluateScanPopulation(
      [
        scan('m1', {
          decision: { status: 'insufficient-data', missing: ['spread'] },
        }),
        scan('m2'),
      ],
      policy,
    );

    expect(report.decisionQuality.totalScans).toBe(2);
    expect(report.decisionQuality.insufficientDataScans).toBe(1);
    expect(report.decisionQuality.coverage).toBe(0.5);
    expect(report.decisionQuality.meanScore).toBe(70);
  });

  it('excludes outcomes that were not yet known at the evaluation cutoff', () => {
    const report = evaluateScanPopulation(
      [
        scan('m1'),
        scan('m2', {
          outcome: {
            validAt: 2_500,
            recordedAt: 12_000,
            directional: 'unfavourable',
            counterfactualR: -3,
          },
        }),
      ],
      policy,
    );

    expect(report.status).toBe('insufficient-data');
    expect(report.reasons).toContain('minimum-forward-outcomes-not-met');
    expect(report.outcomes.eligibleOutcomes).toBe(1);
    expect(report.outcomes.meanCounterfactualR).toBe(1.2);
  });

  it('fails closed on hindsight, impossible bitemporal ordering, and duplicate scans', () => {
    expect(() =>
      evaluateScanPopulation(
        [
          scan('m1', {
            outcome: {
              validAt: 1_000,
              recordedAt: 1_100,
              directional: 'flat',
            },
          }),
        ],
        { ...policy, minimumScans: 1, minimumOutcomes: 1 },
      ),
    ).toThrow(/not strictly forward/);

    expect(() =>
      evaluateScanPopulation(
        [
          scan('m1', {
            outcome: {
              validAt: 2_000,
              recordedAt: 1_999,
              directional: 'flat',
            },
          }),
        ],
        { ...policy, minimumScans: 1, minimumOutcomes: 1 },
      ),
    ).toThrow(/recorded before it became valid/);

    expect(() => evaluateScanPopulation([scan('m1'), scan('m1')], policy)).toThrow(
      /duplicate mission/,
    );
  });

  it('prevents accidental cross-cohort and cross-version aggregation', () => {
    expect(() =>
      evaluateScanPopulation([scan('m1'), scan('m2', { scanConfigVersion: 'scan-v2' })], policy),
    ).toThrow(/one scan configuration cohort/);

    expect(() =>
      evaluateScanPopulation(
        [scan('m1'), scan('m2', { brainContentHash: `sha256:${'b'.repeat(64)}` })],
        policy,
      ),
    ).toThrow(/one immutable Brain content hash/);
  });
});
