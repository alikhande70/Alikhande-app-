import { describe, expect, it } from 'vitest';
import { type BrainVersion, evaluate, type FeatureVector } from './index.js';

const version: BrainVersion = {
  id: 'brain-v1.0.0',
  featureSetVersion: 'features-v1',
  rubricVersion: 'rubric-v1',
  missingFeaturePolicy: 'insufficient-data',
  features: [
    {
      key: 'trendAlignment',
      weight: 3,
      polarity: 'positive',
      rationaleWhenStrong: 'TREND_ALIGNED_HTF',
    },
    {
      key: 'spreadStress',
      weight: 2,
      polarity: 'negative',
      rationaleWhenStrong: 'SPREAD_ELEVATED',
    },
    {
      key: 'riskGeometry',
      weight: 2,
      polarity: 'positive',
      rationaleWhenStrong: 'RISK_GEOMETRY_FAVOURABLE',
    },
  ],
};

const context = { canonical: 'XAUUSD', timeframe: 'M15', session: 'london' } as const;

function vector(values: FeatureVector['values']): FeatureVector {
  return {
    featureSetVersion: 'features-v1',
    asOf: 1_800_000_000_000,
    values,
  };
}

describe('deterministic Trading Brain boundary', () => {
  it('returns byte-equivalent output for the same versioned input', () => {
    const input = vector({ trendAlignment: 0.9, spreadStress: 0.1, riskGeometry: 0.8 });
    const first = evaluate(version, input, context);
    const second = evaluate(version, input, context);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('fails closed with an explicit insufficient-data state instead of imputing', () => {
    const output = evaluate(version, vector({ trendAlignment: 0.9, spreadStress: 0.1 }), context);
    expect(output).toEqual({
      status: 'insufficient-data',
      brainVersion: 'brain-v1.0.0',
      featureSetVersion: 'features-v1',
      rubricVersion: 'rubric-v1',
      asOf: 1_800_000_000_000,
      missing: ['riskGeometry'],
      rationaleCodes: ['FEATURE_MISSING'],
    });
  });

  it('rejects feature-set drift rather than comparing incomparable inputs', () => {
    expect(() =>
      evaluate(
        version,
        {
          featureSetVersion: 'features-v2',
          asOf: 1_800_000_000_000,
          values: { trendAlignment: 0.9, spreadStress: 0.1, riskGeometry: 0.8 },
        },
        context,
      ),
    ).toThrow(/feature set mismatch/);
  });

  it('rejects malformed normalized features and invalid rubrics', () => {
    expect(() =>
      evaluate(
        version,
        vector({ trendAlignment: 1.1, spreadStress: 0.1, riskGeometry: 0.8 }),
        context,
      ),
    ).toThrow(/must be a finite normalized value/);

    expect(() => evaluate({ ...version, features: [] }, vector({}), context)).toThrow(
      /must contain features/,
    );
  });

  it('keeps every valid score finite and inside 0..100', () => {
    const samples = [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1];
    for (const trendAlignment of samples) {
      for (const spreadStress of samples) {
        for (const riskGeometry of samples) {
          const output = evaluate(
            version,
            vector({ trendAlignment, spreadStress, riskGeometry }),
            context,
          );
          expect(output.status).toBe('scored');
          if (output.status === 'scored') {
            expect(Number.isFinite(output.score.value)).toBe(true);
            expect(output.score.value).toBeGreaterThanOrEqual(0);
            expect(output.score.value).toBeLessThanOrEqual(100);
          }
        }
      }
    }
  });

  it('never depends on wall-clock time or mutable process state', () => {
    const input = vector({ trendAlignment: 0.75, spreadStress: 0.25, riskGeometry: 0.75 });
    const before = Date.now;
    try {
      Date.now = () => 123;
      const a = evaluate(version, input, context);
      Date.now = () => 999_999_999_999;
      const b = evaluate(version, input, context);
      expect(a).toEqual(b);
    } finally {
      Date.now = before;
    }
  });
});
