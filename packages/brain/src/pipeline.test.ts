import { describe, expect, it } from 'vitest';
import { evaluate, extractFeatureVector } from './index.js';
import type {
  BitemporalFeatureObservation,
  BrainVersion,
  FeatureSetVersion,
} from './index.js';

const featureSet: FeatureSetVersion = {
  id: 'pit-pipeline-v1',
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
  id: 'brain-pipeline-v1',
  featureSetVersion: featureSet.id,
  rubricVersion: 'rubric-pipeline-v1',
  missingFeaturePolicy: 'insufficient-data',
  features: [
    { key: 'trend', weight: 3, polarity: 'positive', rationaleWhenStrong: 'TREND_ALIGNED_HTF' },
    { key: 'spread', weight: 1, polarity: 'negative', rationaleWhenStrong: 'SPREAD_ELEVATED' },
  ],
};

const context = { canonical: 'XAUUSD', timeframe: 'M15', session: 'london' } as const;

function obs(
  sourceKey: string,
  value: number,
  validAt: number,
  recordedAt: number,
): BitemporalFeatureObservation {
  return { sourceKey, value, validAt, recordedAt };
}

describe('ADR-0019 point-in-time Brain pipeline', () => {
  it('replays the original score even after a later correction exists', () => {
    const observations = [
      obs('trendStrength', 0.6, 1_000, 1_005),
      obs('spreadBps', 4, 1_000, 1_005),
      // Same market valid-time, but knowledge that only arrived after the decision.
      obs('trendStrength', 0.95, 1_000, 1_200),
    ];

    const originalFeatures = extractFeatureVector({
      featureSet,
      observations,
      decisionAsOf: 1_020,
      knowledgeCutoff: 1_020,
    });
    const original = evaluate(brain, originalFeatures.vector, context);

    const exactReplayFeatures = extractFeatureVector({
      featureSet,
      observations,
      decisionAsOf: 1_020,
      knowledgeCutoff: 1_020,
    });
    const exactReplay = evaluate(brain, exactReplayFeatures.vector, context);

    const hindsightFeatures = extractFeatureVector({
      featureSet,
      observations,
      decisionAsOf: 1_020,
      knowledgeCutoff: 1_300,
    });
    const hindsight = evaluate(brain, hindsightFeatures.vector, context);

    expect(JSON.stringify(exactReplay)).toBe(JSON.stringify(original));
    expect(hindsight).not.toEqual(original);
    expect(originalFeatures.evidence.find((item) => item.featureKey === 'trend')?.recordedAt).toBe(
      1_005,
    );
    expect(hindsightFeatures.evidence.find((item) => item.featureKey === 'trend')?.recordedAt).toBe(
      1_200,
    );
  });

  it('turns missing point-in-time evidence into insufficient-data instead of a fabricated score', () => {
    const extracted = extractFeatureVector({
      featureSet,
      observations: [obs('trendStrength', 0.8, 1_000, 1_005)],
      decisionAsOf: 1_020,
      knowledgeCutoff: 1_020,
    });

    const result = evaluate(brain, extracted.vector, context);
    expect(result).toMatchObject({
      status: 'insufficient-data',
      brainVersion: 'brain-pipeline-v1',
      featureSetVersion: 'pit-pipeline-v1',
      missing: ['spread'],
      rationaleCodes: ['FEATURE_MISSING'],
    });
  });
});
