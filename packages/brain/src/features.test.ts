import { describe, expect, it } from 'vitest';
import {
  type BitemporalFeatureObservation,
  extractFeatureVector,
  type FeatureSetVersion,
} from './features.js';

const featureSet: FeatureSetVersion = {
  id: 'pit-v1',
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
      maxAgeMs: 5_000,
    },
  ],
};

function observation(
  sourceKey: string,
  value: number,
  validAt: number,
  recordedAt = validAt,
): BitemporalFeatureObservation {
  return { sourceKey, value, validAt, recordedAt };
}

describe('ADR-0019 point-in-time feature extraction', () => {
  it('is deterministic regardless of input observation order', () => {
    const observations = [
      observation('trendStrength', 0.8, 1_000, 1_010),
      observation('spreadBps', 4, 1_000, 1_005),
    ];
    const a = extractFeatureVector({
      featureSet,
      observations,
      decisionAsOf: 1_020,
      knowledgeCutoff: 1_020,
    });
    const b = extractFeatureVector({
      featureSet,
      observations: [...observations].reverse(),
      decisionAsOf: 1_020,
      knowledgeCutoff: 1_020,
    });

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.vector).toEqual({
      featureSetVersion: 'pit-v1',
      asOf: 1_020,
      values: { trend: 0.8, spread: 0.2 },
    });
  });

  it('cannot see a market observation from after the decision valid-time', () => {
    const result = extractFeatureVector({
      featureSet,
      observations: [
        observation('trendStrength', 0.4, 1_000, 1_000),
        observation('trendStrength', 0.95, 1_021, 1_021),
        observation('spreadBps', 5, 1_000, 1_000),
      ],
      decisionAsOf: 1_020,
      knowledgeCutoff: 1_030,
    });

    expect(result.vector.values.trend).toBe(0.4);
  });

  it('cannot leak a correction that was recorded after the historical knowledge cutoff', () => {
    const observations = [
      observation('trendStrength', 0.4, 1_000, 1_005),
      observation('trendStrength', 0.9, 1_000, 1_100),
      observation('spreadBps', 4, 1_000, 1_005),
    ];

    const historical = extractFeatureVector({
      featureSet,
      observations,
      decisionAsOf: 1_020,
      knowledgeCutoff: 1_020,
    });
    const laterReplay = extractFeatureVector({
      featureSet,
      observations,
      decisionAsOf: 1_020,
      knowledgeCutoff: 1_120,
    });

    expect(historical.vector.values.trend).toBe(0.4);
    expect(laterReplay.vector.values.trend).toBe(0.9);
    expect(historical.evidence.find((item) => item.featureKey === 'trend')?.recordedAt).toBe(1_005);
  });

  it('leaves stale evidence explicitly missing instead of carrying it forward forever', () => {
    const result = extractFeatureVector({
      featureSet,
      observations: [
        observation('trendStrength', 0.7, 900, 900),
        observation('spreadBps', 3, 900, 900),
      ],
      decisionAsOf: 10_000,
      knowledgeCutoff: 10_000,
    });

    expect(result.missing).toEqual(['spread', 'trend']);
    expect(result.vector.values).toEqual({ trend: undefined, spread: undefined });
  });

  it('fails on contradictory facts at identical bitemporal coordinates', () => {
    expect(() =>
      extractFeatureVector({
        featureSet,
        observations: [
          observation('trendStrength', 0.4, 1_000, 1_010),
          observation('trendStrength', 0.8, 1_000, 1_010),
          observation('spreadBps', 4, 1_000, 1_010),
        ],
        decisionAsOf: 1_020,
        knowledgeCutoff: 1_020,
      }),
    ).toThrow(/contradictory observations/);
  });

  it('fails closed on impossible clock domains and invalid numeric evidence', () => {
    expect(() =>
      extractFeatureVector({
        featureSet,
        observations: [observation('trendStrength', 0.5, 1_000, 999)],
        decisionAsOf: 1_020,
        knowledgeCutoff: 1_020,
      }),
    ).toThrow(/recorded before its valid time/);

    expect(() =>
      extractFeatureVector({
        featureSet,
        observations: [observation('trendStrength', Number.NaN, 1_000, 1_000)],
        decisionAsOf: 1_020,
        knowledgeCutoff: 1_020,
      }),
    ).toThrow(/value must be finite/);
  });

  it('does not clamp out-of-contract feature values into a plausible score', () => {
    expect(() =>
      extractFeatureVector({
        featureSet,
        observations: [
          observation('trendStrength', 0.7, 1_000),
          observation('spreadBps', 25, 1_000),
        ],
        decisionAsOf: 1_001,
        knowledgeCutoff: 1_001,
      }),
    ).toThrow(/outside declared range/);
  });

  it('requires the knowledge cutoff to be at or after the decision valid-time', () => {
    expect(() =>
      extractFeatureVector({
        featureSet,
        observations: [],
        decisionAsOf: 1_000,
        knowledgeCutoff: 999,
      }),
    ).toThrow(/knowledgeCutoff cannot precede decisionAsOf/);
  });
});
