import { describe, expect, it } from 'vitest';
import { Ledger } from '../ledger/ledger.js';
import { BrainComparisonInvariantError, withBrainComparisonEvidence } from './brain-comparison.js';
import { MissionService } from './service.js';
import type { BrainContentHash, DecisionSnapshot } from './types.js';

const CHAMPION_HASH = `sha256:${'1'.repeat(64)}` as BrainContentHash;
const CHALLENGER_HASH = `sha256:${'2'.repeat(64)}` as BrainContentHash;

function baseSnapshot(): DecisionSnapshot {
  return {
    snapshotVersion: 3,
    asOf: 2_000,
    known: { session: 'london', source: 'immutable-scan-ledger' },
    missing: [],
    plan: {
      side: 'buy',
      entry: '2400.30',
      stop: '2395.00',
      target: '2410.90',
      invalidation: ['M15 close below 2395.00'],
    },
  };
}

function extraction(options: { spread?: number; missingSpread?: boolean } = {}) {
  const missingSpread = options.missingSpread ?? false;
  const spread = options.spread ?? 0.2;
  return {
    vector: {
      featureSetVersion: 'features-v1',
      asOf: 2_000,
      values: { trend: 0.8, spread: missingSpread ? undefined : spread },
    },
    evidence: [
      {
        featureKey: 'trend',
        sourceKey: 'trendStrength',
        validAt: 1_990,
        recordedAt: 1_995,
        rawValue: 0.8,
        normalizedValue: 0.8,
      },
      ...(missingSpread
        ? []
        : [
            {
              featureKey: 'spread',
              sourceKey: 'spreadBps',
              validAt: 1_990,
              recordedAt: 1_995,
              rawValue: 4,
              normalizedValue: spread,
            },
          ]),
    ],
    missing: missingSpread ? ['spread'] : [],
  };
}

function scored(brainVersion: string, score: number) {
  return {
    status: 'scored' as const,
    brainVersion,
    featureSetVersion: 'features-v1',
    rubricVersion: brainVersion === 'brain-v1' ? 'rubric-v1' : 'rubric-v2',
    asOf: 2_000,
    score: { value: score, rationaleCodes: ['TREND_ALIGNED_HTF'] },
  };
}

function insufficient(brainVersion: string) {
  return {
    status: 'insufficient-data' as const,
    brainVersion,
    featureSetVersion: 'features-v1',
    rubricVersion: 'rubric-v2',
    asOf: 2_000,
    missing: ['spread'],
    rationaleCodes: ['FEATURE_MISSING'],
  };
}

function versions(challengerCreatedAt = 1_500) {
  return [
    {
      contentHash: CHAMPION_HASH,
      role: 'champion' as const,
      createdAt: 1_000,
      evaluation: scored('brain-v1', 80),
      extraction: extraction(),
      knowledgeCutoff: 2_000,
    },
    {
      contentHash: CHALLENGER_HASH,
      role: 'challenger' as const,
      createdAt: challengerCreatedAt,
      evaluation: scored('brain-v2', 84),
      extraction: extraction({ spread: 0.25 }),
      knowledgeCutoff: 2_000,
    },
  ];
}

function preparedMission(ledger: Ledger): MissionService {
  const missions = new MissionService(ledger);
  missions.observe({
    missionId: 'mission-paired-1',
    origin: 'scanner',
    canonical: 'XAUUSD',
    timeframe: 'M15',
    trigger: 'closed-bar-scan',
    observedAt: 1_990,
    scanConfigVersion: 'scan-v8',
    marketState: { trendStrength: 0.8, spreadBps: 4 },
  });
  missions.markCandidate('mission-paired-1', 'brain', 1_998);
  return missions;
}

describe('paired champion/challenger Mission evidence', () => {
  it('persists exact hashes and same-mission forward shadow outputs without granting execution authority', () => {
    const ledger = new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 2_010 });
    const missions = preparedMission(ledger);
    const snapshot = withBrainComparisonEvidence({
      snapshot: baseSnapshot(),
      missionKnowledgeTime: 2_000,
      championHash: CHAMPION_HASH,
      versions: versions(),
    });

    expect(snapshot.brainEvaluation).toMatchObject({ brainVersion: 'brain-v1', score: 80 });
    expect(snapshot.brainComparison).toEqual({
      comparisonVersion: 1,
      missionKnowledgeTime: 2_000,
      championHash: CHAMPION_HASH,
      evaluations: [
        expect.objectContaining({
          contentHash: CHAMPION_HASH,
          role: 'champion',
          createdAt: 1_000,
          evaluation: expect.objectContaining({ brainVersion: 'brain-v1', score: 80 }),
        }),
        expect.objectContaining({
          contentHash: CHALLENGER_HASH,
          role: 'challenger',
          createdAt: 1_500,
          evaluation: expect.objectContaining({ brainVersion: 'brain-v2', score: 84 }),
        }),
      ],
    });

    const planned = missions.plan('mission-paired-1', snapshot, 'brain', 2_005);
    expect(planned.decisionSnapshot?.brainComparison?.evaluations).toHaveLength(2);
    expect(
      ledger.readStream('mission-paired-1').some((row) => row.kind === 'intent.created'),
    ).toBe(false);
    expect(Ledger.isDurable('mission.snapshotSealed')).toBe(true);
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  });

  it('rejects challenger evidence from before or exactly at challenger creation', () => {
    for (const createdAt of [2_000, 2_100]) {
      expect(() =>
        withBrainComparisonEvidence({
          snapshot: baseSnapshot(),
          missionKnowledgeTime: 2_000,
          championHash: CHAMPION_HASH,
          versions: versions(createdAt),
        }),
      ).toThrow(/not forward-only evidence/);
    }
  });

  it('rejects paired evaluations that do not share the exact Mission knowledge-time', () => {
    const mismatched = versions().map((version, index) =>
      index === 1 ? { ...version, knowledgeCutoff: 1_999 } : version,
    );
    expect(() =>
      withBrainComparisonEvidence({
        snapshot: baseSnapshot(),
        missionKnowledgeTime: 2_000,
        championHash: CHAMPION_HASH,
        versions: mismatched,
      }),
    ).toThrow(/exact Mission knowledge-time/);
  });

  it('keeps challenger missing data out of the champion decision missing set', () => {
    const challengerMissing = [
      versions()[0],
      {
        ...versions()[1],
        evaluation: insufficient('brain-v2'),
        extraction: extraction({ missingSpread: true }),
      },
    ];
    const snapshot = withBrainComparisonEvidence({
      snapshot: { ...baseSnapshot(), missing: ['economic-calendar'] },
      missionKnowledgeTime: 2_000,
      championHash: CHAMPION_HASH,
      versions: challengerMissing,
    });

    expect(snapshot.missing).toEqual(['economic-calendar']);
    expect(snapshot.brainEvaluation?.status).toBe('scored');
    expect(snapshot.brainComparison?.evaluations[1]?.evaluation).toMatchObject({
      status: 'insufficient-data',
      missing: ['spread'],
    });
  });

  it('fails closed on duplicate immutable identity', () => {
    const duplicateHash = [versions()[0], { ...versions()[1], contentHash: CHAMPION_HASH }];
    expect(() =>
      withBrainComparisonEvidence({
        snapshot: baseSnapshot(),
        missionKnowledgeTime: 2_000,
        championHash: CHAMPION_HASH,
        versions: duplicateHash,
      }),
    ).toThrow(BrainComparisonInvariantError);

    const duplicateVersion = [
      versions()[0],
      { ...versions()[1], evaluation: scored('brain-v1', 84) },
    ];
    expect(() =>
      withBrainComparisonEvidence({
        snapshot: baseSnapshot(),
        missionKnowledgeTime: 2_000,
        championHash: CHAMPION_HASH,
        versions: duplicateVersion,
      }),
    ).toThrow(/duplicate Brain version id/);
  });
});
