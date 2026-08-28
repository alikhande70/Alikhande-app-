import { describe, expect, it } from 'vitest';
import type { BrainVersion, FeatureSetVersion } from './index.js';
import { evaluate, extractFeatureVector, observationsFromMissionLedger } from './index.js';

const featureSet: FeatureSetVersion = {
  id: 'ledger-pit-v1',
  definitions: [
    {
      key: 'trend',
      sourceKey: 'trendStrength',
      normalization: { kind: 'identity' },
      maxAgeMs: 60_000,
    },
    {
      key: 'spread',
      sourceKey: 'spreadBps',
      normalization: { kind: 'linear', min: 0, max: 20 },
      maxAgeMs: 10_000,
    },
  ],
};

const brain: BrainVersion = {
  id: 'brain-ledger-v1',
  featureSetVersion: featureSet.id,
  rubricVersion: 'rubric-ledger-v1',
  missingFeaturePolicy: 'insufficient-data',
  features: [
    { key: 'trend', weight: 3, polarity: 'positive', rationaleWhenStrong: 'TREND_ALIGNED_HTF' },
    { key: 'spread', weight: 1, polarity: 'negative', rationaleWhenStrong: 'SPREAD_ELEVATED' },
  ],
};

const bindings = [
  { sourceKey: 'trendStrength', marketStateKey: 'trendStrength' },
  { sourceKey: 'spreadBps', marketStateKey: 'spreadBps' },
] as const;

function missionRow(seq: number, recordedAt: number, marketState: Readonly<Record<string, unknown>>) {
  return {
    seq,
    ts: recordedAt,
    kind: 'mission.observed' as const,
    payload: {
      observation: {
        missionId: 'mission-ledger-1',
        observedAt: 1_000,
        marketState,
      },
    },
  };
}

describe('durable Mission ledger -> Brain pipeline', () => {
  it('replays the exact original decision while excluding evidence recorded later', () => {
    const rows = [
      missionRow(100, 1_005, { trendStrength: 0.6, spreadBps: 4 }),
      // Later immutable correction for the same market valid-time.
      missionRow(140, 1_200, { trendStrength: 0.95, spreadBps: 4 }),
    ];
    const observations = observationsFromMissionLedger({
      missionId: 'mission-ledger-1',
      bindings,
      rows,
    });

    const originalFeatures = extractFeatureVector({
      featureSet,
      observations,
      decisionAsOf: 1_020,
      knowledgeCutoff: 1_020,
    });
    const replayFeatures = extractFeatureVector({
      featureSet,
      observations,
      decisionAsOf: 1_020,
      knowledgeCutoff: 1_020,
    });
    const laterQueryFeatures = extractFeatureVector({
      featureSet,
      observations,
      decisionAsOf: 1_020,
      knowledgeCutoff: 1_300,
    });

    const context = { canonical: 'XAUUSD', timeframe: 'M15', session: 'london' } as const;
    const original = evaluate(brain, originalFeatures.vector, context);
    const replay = evaluate(brain, replayFeatures.vector, context);
    const laterQuery = evaluate(brain, laterQueryFeatures.vector, context);

    expect(JSON.stringify(replay)).toBe(JSON.stringify(original));
    expect(laterQuery).not.toEqual(original);
    expect(originalFeatures.evidence.find((item) => item.featureKey === 'trend')?.recordedAt).toBe(
      1_005,
    );
    expect(laterQueryFeatures.evidence.find((item) => item.featureKey === 'trend')?.recordedAt).toBe(
      1_200,
    );
  });

  it('propagates missing durable scan evidence to insufficient-data', () => {
    const observations = observationsFromMissionLedger({
      missionId: 'mission-ledger-1',
      bindings,
      rows: [missionRow(1, 1_005, { trendStrength: 0.7 })],
    });
    const extracted = extractFeatureVector({
      featureSet,
      observations,
      decisionAsOf: 1_020,
      knowledgeCutoff: 1_020,
    });

    const result = evaluate(brain, extracted.vector, {
      canonical: 'XAUUSD',
      timeframe: 'M15',
      session: 'london',
    });

    expect(result).toMatchObject({
      status: 'insufficient-data',
      missing: ['spread'],
      rationaleCodes: ['FEATURE_MISSING'],
    });
  });
});
