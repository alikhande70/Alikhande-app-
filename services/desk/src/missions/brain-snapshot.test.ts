import { describe, expect, it } from 'vitest';
import { Ledger } from '../ledger/ledger.js';
import { BrainSnapshotInvariantError, withBrainDecisionEvidence } from './brain-snapshot.js';
import { MissionService } from './service.js';
import type { DecisionSnapshot } from './types.js';

function baseSnapshot(): DecisionSnapshot {
  return {
    snapshotVersion: 2,
    asOf: 1_020,
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

function extraction(recordedAt = 1_005) {
  return {
    vector: {
      featureSetVersion: 'features-v1',
      asOf: 1_020,
      values: { trend: 0.8, spread: 0.2 },
    },
    evidence: [
      {
        featureKey: 'trend',
        sourceKey: 'trendStrength',
        validAt: 1_000,
        recordedAt,
        rawValue: 0.8,
        normalizedValue: 0.8,
      },
      {
        featureKey: 'spread',
        sourceKey: 'spreadBps',
        validAt: 1_000,
        recordedAt,
        rawValue: 4,
        normalizedValue: 0.2,
      },
    ],
    missing: [],
  } as const;
}

function scoredEvaluation() {
  return {
    status: 'scored' as const,
    brainVersion: 'brain-v1',
    featureSetVersion: 'features-v1',
    rubricVersion: 'rubric-v3',
    asOf: 1_020,
    score: { value: 82.5, rationaleCodes: ['TREND_ALIGNED_HTF'] },
  };
}

function preparedMission(ledger: Ledger): MissionService {
  const missions = new MissionService(ledger);
  missions.observe({
    missionId: 'mission-brain-1',
    origin: 'scanner',
    canonical: 'XAUUSD',
    timeframe: 'M15',
    trigger: 'closed-bar-scan',
    observedAt: 1_000,
    scanConfigVersion: 'scan-v7',
    marketState: { trendStrength: 0.8, spreadBps: 4 },
  });
  missions.markCandidate('mission-brain-1', 'brain', 1_010);
  return missions;
}

describe('deterministic Brain -> Mission decision snapshot', () => {
  it('persists versions, score, rationale and bitemporal evidence in the durable Mission ledger', () => {
    const ledger = new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 1_030 });
    const missions = preparedMission(ledger);
    const sealed = withBrainDecisionEvidence({
      snapshot: baseSnapshot(),
      evaluation: scoredEvaluation(),
      extraction: extraction(),
      knowledgeCutoff: 1_020,
    });

    const planned = missions.plan('mission-brain-1', sealed, 'brain', 1_025);
    expect(planned.decisionSnapshot?.brainEvaluation).toEqual({
      status: 'scored',
      brainVersion: 'brain-v1',
      featureSetVersion: 'features-v1',
      rubricVersion: 'rubric-v3',
      decisionAsOf: 1_020,
      knowledgeCutoff: 1_020,
      score: 82.5,
      rationaleCodes: ['TREND_ALIGNED_HTF'],
      evidence: [
        {
          featureKey: 'spread',
          sourceKey: 'spreadBps',
          validAt: 1_000,
          recordedAt: 1_005,
          rawValue: 4,
          normalizedValue: 0.2,
        },
        {
          featureKey: 'trend',
          sourceKey: 'trendStrength',
          validAt: 1_000,
          recordedAt: 1_005,
          rawValue: 0.8,
          normalizedValue: 0.8,
        },
      ],
      missing: [],
    });

    const sealedRow = ledger
      .readStream('mission-brain-1')
      .find((row) => row.kind === 'mission.snapshotSealed');
    expect(sealedRow?.event).toMatchObject({
      kind: 'mission.snapshotSealed',
      snapshot: { brainVersion: 'brain-v1' },
    });
    expect(Ledger.isDurable('mission.snapshotSealed')).toBe(true);
    expect(ledger.readStream('mission-brain-1').some((row) => row.kind === 'intent.created')).toBe(
      false,
    );
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  });

  it('persists insufficient-data and merges missing Brain features into the decision snapshot', () => {
    const ledger = new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 1_030 });
    const missions = preparedMission(ledger);
    const partialExtraction = {
      ...extraction(),
      vector: {
        featureSetVersion: 'features-v1',
        asOf: 1_020,
        values: { trend: 0.8, spread: undefined },
      },
      evidence: extraction().evidence.filter((item) => item.featureKey === 'trend'),
      missing: ['spread'],
    };
    const evaluation = {
      status: 'insufficient-data' as const,
      brainVersion: 'brain-v1',
      featureSetVersion: 'features-v1',
      rubricVersion: 'rubric-v3',
      asOf: 1_020,
      missing: ['spread'],
      rationaleCodes: ['FEATURE_MISSING'],
    };

    const sealed = withBrainDecisionEvidence({
      snapshot: { ...baseSnapshot(), missing: ['economic-calendar'] },
      evaluation,
      extraction: partialExtraction,
      knowledgeCutoff: 1_020,
    });
    const abandoned = missions.abandon(
      'mission-brain-1',
      'brain',
      1_025,
      'deterministic Brain has insufficient data',
      sealed,
    );

    expect(abandoned.decisionSnapshot?.missing).toEqual(['economic-calendar', 'spread']);
    expect(abandoned.decisionSnapshot?.brainEvaluation).toMatchObject({
      status: 'insufficient-data',
      missing: ['spread'],
      rationaleCodes: ['FEATURE_MISSING'],
    });
    ledger.close();
  });

  it('rejects hindsight evidence learned after the knowledge cutoff before anything is sealed', () => {
    const ledger = new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 1_300 });
    preparedMission(ledger);

    expect(() =>
      withBrainDecisionEvidence({
        snapshot: baseSnapshot(),
        evaluation: scoredEvaluation(),
        extraction: extraction(1_200),
        knowledgeCutoff: 1_020,
      }),
    ).toThrow(BrainSnapshotInvariantError);
    expect(
      ledger.readStream('mission-brain-1').filter((row) => row.kind === 'mission.snapshotSealed'),
    ).toHaveLength(0);
    ledger.close();
  });
});
