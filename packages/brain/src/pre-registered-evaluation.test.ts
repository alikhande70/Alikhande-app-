import { describe, expect, it } from 'vitest';
import type { EvaluationPipelineMission } from './evaluation-pipeline.js';
import type { MarketCloseObservation } from './outcome-labeling.js';
import {
  buildPreRegisteredEvaluation,
  type PreRegisteredEvaluationPolicy,
} from './pre-registered-evaluation.js';

const championHash = `sha256:${'a'.repeat(64)}` as const;
const challengerHash = `sha256:${'b'.repeat(64)}` as const;
const challengerCreatedAt = 1_000;
const analysisCutoff = 2_000;

function mission(
  missionId: string,
  knowledgeTime: number,
  options: { includeChallenger?: boolean; challengerCreatedAt?: number } = {},
): EvaluationPipelineMission {
  const includeChallenger = options.includeChallenger ?? true;
  const createdAt = options.challengerCreatedAt ?? challengerCreatedAt;
  return {
    missionId,
    scanConfigVersion: 'scan-v1',
    observedAt: knowledgeTime - 10,
    canonical: 'EURUSD',
    decisionSnapshot: {
      asOf: knowledgeTime - 1,
      plan: { side: 'buy', entry: '1.1000', stop: '1.0900' },
      brainEvaluation: {
        status: 'scored',
        brainVersion: 'brain-v1',
        knowledgeCutoff: knowledgeTime,
        score: 70,
      },
      brainComparison: {
        missionKnowledgeTime: knowledgeTime,
        championHash,
        evaluations: [
          {
            contentHash: championHash,
            role: 'champion',
            createdAt: 0,
            evaluation: {
              status: 'scored',
              brainVersion: 'brain-v1',
              knowledgeCutoff: knowledgeTime,
              score: 70,
            },
          },
          ...(includeChallenger
            ? [
                {
                  contentHash: challengerHash,
                  role: 'challenger' as const,
                  createdAt,
                  evaluation: {
                    status: 'scored' as const,
                    brainVersion: 'brain-v2',
                    knowledgeCutoff: knowledgeTime,
                    score: 80,
                  },
                },
              ]
            : []),
        ],
      },
    },
  };
}

function close(mission: EvaluationPipelineMission, knowledgeTime: number): MarketCloseObservation {
  return {
    symbol: mission.canonical,
    validAt: knowledgeTime + 100,
    recordedAt: knowledgeTime + 100,
    close: 1.1200,
  };
}

const missions = [
  mission('m1', 1_100),
  mission('m2', 1_200),
  mission('m3', 1_300),
  mission('m4', 1_400),
];
const observations = missions.map((item, index) => close(item, 1_100 + index * 100));

function policy(currentKnowledgeCutoff: number): PreRegisteredEvaluationPolicy {
  return {
    currentKnowledgeCutoff,
    aggregate: {
      minimumScans: 4,
      minimumOutcomes: 4,
      evaluationCutoff: currentKnowledgeCutoff,
    },
    paired: {
      minimumPairs: 4,
      minimumFullyScoredPairs: 4,
      minimumDurationMs: 300,
      minimumOutcomeCoverage: 1,
      minimumDirectionalComparisons: 4,
    },
    analysisPlan: {
      planId: 'challenger-b-fixed-look-v1',
      challengerContentHash: challengerHash,
      registeredAt: challengerCreatedAt,
      analysisCutoff,
      minimumPairingCoverage: 1,
    },
  };
}

describe('pre-registered evaluation composition', () => {
  it('does not reveal paired inference before the fixed analysis cutoff', () => {
    const result = buildPreRegisteredEvaluation(
      missions,
      observations,
      { labelVersion: 'fixed-horizon-v1', horizonMs: 100, flatThresholdR: 0.01 },
      policy(1_500),
    );

    expect(result.paired).toEqual({
      status: 'analysis-window-open',
      planId: 'challenger-b-fixed-look-v1',
      analysisCutoff,
    });
    expect(result.aggregateReport.status).toBe('ready');
  });

  it('freezes paired inference to the pre-registered cutoff once the window closes', () => {
    const atCutoff = buildPreRegisteredEvaluation(
      missions,
      observations,
      { labelVersion: 'fixed-horizon-v1', horizonMs: 100, flatThresholdR: 0.01 },
      policy(analysisCutoff),
    );
    const muchLater = buildPreRegisteredEvaluation(
      missions,
      [
        ...observations,
        { symbol: 'EURUSD', validAt: 9_999, recordedAt: 9_999, close: 0.5 },
      ],
      { labelVersion: 'fixed-horizon-v1', horizonMs: 100, flatThresholdR: 0.01 },
      policy(10_000),
    );

    expect(atCutoff.paired.status).toBe('ready');
    expect(muchLater.paired.status).toBe('ready');
    if (atCutoff.paired.status === 'analysis-window-open') throw new Error('unreachable');
    if (muchLater.paired.status === 'analysis-window-open') throw new Error('unreachable');
    expect(muchLater.paired.analysisCutoff).toBe(atCutoff.paired.analysisCutoff);
    expect(muchLater.paired.inference).toEqual(atCutoff.paired.inference);
    expect(atCutoff.paired.inference?.inference).toBe('challenger-favouring');
  });

  it('fails closed when the plan is registered after forward Challenger evidence has begun', () => {
    const late = policy(analysisCutoff);
    const latePolicy: PreRegisteredEvaluationPolicy = {
      ...late,
      analysisPlan: { ...late.analysisPlan, registeredAt: 1_150 },
    };

    expect(() =>
      buildPreRegisteredEvaluation(
        missions,
        observations,
        { labelVersion: 'fixed-horizon-v1', horizonMs: 100, flatThresholdR: 0.01 },
        latePolicy,
      ),
    ).toThrow(/registered after forward Challenger evidence began/);
  });

  it('keeps missing Challenger shadow scans in the pairing denominator', () => {
    const population = [
      mission('m1', 1_100),
      mission('m2', 1_200),
      mission('m3', 1_300),
      mission('m4', 1_400, { includeChallenger: false }),
    ];
    const market = population.map((item, index) => close(item, 1_100 + index * 100));
    const configured = policy(analysisCutoff);
    const relaxed: PreRegisteredEvaluationPolicy = {
      ...configured,
      paired: { ...configured.paired, minimumPairs: 3, minimumFullyScoredPairs: 3 },
    };

    const result = buildPreRegisteredEvaluation(
      population,
      market,
      { labelVersion: 'fixed-horizon-v1', horizonMs: 100, flatThresholdR: 0.01 },
      relaxed,
    );

    expect(result.paired.status).toBe('insufficient-data');
    if (result.paired.status === 'analysis-window-open') throw new Error('unreachable');
    expect(result.paired.pairingCoverage).toBe(0.75);
    expect(result.paired.missingPairedMissionIds).toEqual(['m4']);
    expect(result.paired.reasons).toContain('minimum-pairing-coverage-not-met');
  });

  it('fails closed on inconsistent Challenger creation identity and future aggregate cutoffs', () => {
    const inconsistent = [
      mission('m1', 1_100),
      mission('m2', 1_200, { challengerCreatedAt: 999 }),
      mission('m3', 1_300),
      mission('m4', 1_400),
    ];

    expect(() =>
      buildPreRegisteredEvaluation(
        inconsistent,
        observations,
        { labelVersion: 'fixed-horizon-v1', horizonMs: 100, flatThresholdR: 0.01 },
        policy(analysisCutoff),
      ),
    ).toThrow(/inconsistent creation boundaries/);

    const futureAggregate = policy(1_500);
    expect(() =>
      buildPreRegisteredEvaluation(
        missions,
        observations,
        { labelVersion: 'fixed-horizon-v1', horizonMs: 100, flatThresholdR: 0.01 },
        {
          ...futureAggregate,
          aggregate: { ...futureAggregate.aggregate, evaluationCutoff: 1_501 },
        },
      ),
    ).toThrow(/cannot be later than current knowledge/);
  });
});
