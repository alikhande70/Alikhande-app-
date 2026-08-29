import { describe, expect, it } from 'vitest';
import {
  buildMissionEvaluationPipeline,
  type EvaluationPipelineMission,
} from './evaluation-pipeline.js';
import type { MarketCloseObservation } from './outcome-labeling.js';

const championHash = `sha256:${'a'.repeat(64)}` as const;

function mission(
  missionId: string,
  knowledgeCutoff: number,
  plan: EvaluationPipelineMission['decisionSnapshot']['plan'] = {
    side: 'buy',
    entry: '100',
    stop: '98',
  },
): EvaluationPipelineMission {
  return {
    missionId,
    canonical: 'SIM-XAUUSD',
    scanConfigVersion: 'scan-v1',
    observedAt: knowledgeCutoff - 20,
    decisionSnapshot: {
      asOf: knowledgeCutoff - 10,
      brainEvaluation: {
        status: 'scored',
        brainVersion: '1.0.0',
        knowledgeCutoff,
        score: 82,
      },
      brainComparison: {
        missionKnowledgeTime: knowledgeCutoff,
        championHash,
      },
      plan,
    },
  };
}

const outcomePolicy = {
  labelVersion: 'fixed-close-r-v1',
  horizonMs: 300,
  flatThresholdR: 0.1,
} as const;

const evaluationPolicy = {
  minimumScans: 2,
  minimumOutcomes: 1,
  evaluationCutoff: 2_000,
} as const;

function market(validAt: number, close: number, recordedAt = validAt + 5): MarketCloseObservation {
  return { symbol: 'SIM-XAUUSD', validAt, recordedAt, close };
}

describe('buildMissionEvaluationPipeline', () => {
  it('composes durable Mission truth through fixed-horizon labels into scan evaluation', () => {
    const result = buildMissionEvaluationPipeline(
      [mission('m-1', 1_000), mission('m-2', 1_100)],
      [market(1_300, 103), market(1_400, 99)],
      outcomePolicy,
      evaluationPolicy,
    );

    expect(result.labels).toHaveLength(2);
    expect(result.outcomeEvidenceGaps).toEqual([]);
    expect(result.scans).toHaveLength(2);
    expect(result.report.status).toBe('ready');
    expect(result.report.decisionQuality.totalScans).toBe(2);
    expect(result.report.outcomes.eligibleOutcomes).toBe(2);
    expect(result.report.outcomes.favourable).toBe(1);
    expect(result.report.outcomes.unfavourable).toBe(1);
  });

  it('keeps scans in the population when an exact-horizon observation is missing', () => {
    const result = buildMissionEvaluationPipeline(
      [mission('m-1', 1_000), mission('m-2', 1_100)],
      [market(1_300, 103)],
      outcomePolicy,
      evaluationPolicy,
    );

    expect(result.scans).toHaveLength(2);
    expect(result.labels).toHaveLength(1);
    expect(result.outcomeEvidenceGaps).toEqual([
      { missionId: 'm-2', missing: ['market.close@300ms'] },
    ]);
    expect(result.report.outcomes.eligibleOutcomes).toBe(1);
  });

  it('surfaces missing directional plans without manufacturing counterfactuals', () => {
    const withoutPlan = mission('m-1', 1_000);
    const result = buildMissionEvaluationPipeline(
      [
        {
          ...withoutPlan,
          decisionSnapshot: { ...withoutPlan.decisionSnapshot, plan: undefined },
        },
        mission('m-2', 1_100),
      ],
      [market(1_400, 103)],
      outcomePolicy,
      evaluationPolicy,
    );

    expect(result.scans).toHaveLength(2);
    expect(result.labels.map((label) => label.missionId)).toEqual(['m-2']);
    expect(result.outcomeEvidenceGaps).toEqual([{ missionId: 'm-1', missing: ['plan'] }]);
  });

  it('does not leak outcomes learned after the evaluation cutoff', () => {
    const result = buildMissionEvaluationPipeline(
      [mission('m-1', 1_000), mission('m-2', 1_100)],
      [market(1_300, 103, 2_100), market(1_400, 103, 1_405)],
      outcomePolicy,
      evaluationPolicy,
    );

    expect(result.labels).toHaveLength(2);
    expect(result.report.outcomes.eligibleOutcomes).toBe(1);
  });

  it('fails closed on duplicate market identity instead of choosing one observation', () => {
    expect(() =>
      buildMissionEvaluationPipeline(
        [mission('m-1', 1_000)],
        [market(1_300, 103), market(1_300, 104)],
        outcomePolicy,
        { ...evaluationPolicy, minimumScans: 1 },
      ),
    ).toThrow(/duplicate market observation/);
  });

  it('fails closed on duplicate Mission identity instead of inflating sample size', () => {
    const duplicate = mission('m-1', 1_000);
    expect(() =>
      buildMissionEvaluationPipeline(
        [duplicate, duplicate],
        [market(1_300, 103)],
        outcomePolicy,
        evaluationPolicy,
      ),
    ).toThrow(/duplicate durable mission/);
  });

  it('rejects corrupt unused observations so bad market data cannot hide outside the chosen horizon', () => {
    expect(() =>
      buildMissionEvaluationPipeline(
        [mission('m-1', 1_000)],
        [market(1_300, 103), { ...market(9_999, 101), recordedAt: 9_998 }],
        outcomePolicy,
        { ...evaluationPolicy, minimumScans: 1 },
      ),
    ).toThrow(/recorded before it became valid/);
  });
});
