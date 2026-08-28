import { describe, expect, it } from 'vitest';
import { assessFeatureStrataCoverage } from './feature-strata-guard.js';

function eligible(missionId: string, observedAt: number) {
  return {
    missionId,
    scanConfigVersion: 'scan-v1',
    observedAt,
    knownAt: observedAt + 10,
  };
}

function evidence(missionId: string, value: number, validAt: number, recordedAt = validAt + 5) {
  return {
    missionId,
    featureKey: 'volatility.normalized',
    normalizedValue: value,
    validAt,
    recordedAt,
  };
}

const policy = {
  featureKey: 'volatility.normalized',
  boundaries: [0, 0.33, 0.66, 1],
  minimumEligibleCoverage: 0.75,
  minimumOccupiedEligibleBins: 2,
  minimumOccupiedDirectionalBins: 2,
  maximumDirectionalBinShare: 0.75,
} as const;

describe('feature strata guard', () => {
  it('accepts decision-time evidence distributed across pre-registered strata', () => {
    const eligibility = [
      eligible('m1', 100),
      eligible('m2', 200),
      eligible('m3', 300),
      eligible('m4', 400),
    ];
    const result = assessFeatureStrataCoverage(
      eligibility,
      [
        evidence('m1', 0.1, 90),
        evidence('m2', 0.4, 190),
        evidence('m3', 0.7, 290),
        evidence('m4', 0.8, 390),
      ],
      new Set(['m1', 'm2', 'm3', 'm4']),
      policy,
    );

    expect(result.status).toBe('ready');
    expect(result.evidenceCoverage).toBe(1);
    expect(result.occupiedEligibleBins).toBe(3);
    expect(result.occupiedDirectionalBins).toBe(3);
    expect(result.largestDirectionalBinShare).toBe(0.5);
  });

  it('keeps missing scan evidence in the denominator and blocks missing decisive evidence', () => {
    const eligibility = [
      eligible('m1', 100),
      eligible('m2', 200),
      eligible('m3', 300),
      eligible('m4', 400),
    ];
    const result = assessFeatureStrataCoverage(
      eligibility,
      [evidence('m1', 0.1, 90), evidence('m2', 0.4, 190), evidence('m3', 0.7, 290)],
      new Set(['m1', 'm2', 'm4']),
      policy,
    );

    expect(result.evidenceCoverage).toBe(0.75);
    expect(result.missingMissionIds).toEqual(['m4']);
    expect(result.missingDirectionalMissionIds).toEqual(['m4']);
    expect(result.status).toBe('insufficient-data');
    expect(result.reasons).toContain('directional-feature-evidence-missing');
  });

  it('blocks directional evidence concentrated in one market-condition stratum', () => {
    const eligibility = [
      eligible('m1', 100),
      eligible('m2', 200),
      eligible('m3', 300),
      eligible('m4', 400),
    ];
    const result = assessFeatureStrataCoverage(
      eligibility,
      [
        evidence('m1', 0.1, 90),
        evidence('m2', 0.2, 190),
        evidence('m3', 0.7, 290),
        evidence('m4', 0.8, 390),
      ],
      new Set(['m1', 'm2']),
      policy,
    );

    expect(result.occupiedEligibleBins).toBe(2);
    expect(result.occupiedDirectionalBins).toBe(1);
    expect(result.largestDirectionalBinShare).toBe(1);
    expect(result.status).toBe('insufficient-data');
    expect(result.reasons).toContain('minimum-directional-strata-not-met');
    expect(result.reasons).toContain('directional-stratum-concentration-exceeded');
  });

  it('fails closed on future, late, duplicate, or unknown evidence', () => {
    const eligibility = [eligible('m1', 100)];
    expect(() =>
      assessFeatureStrataCoverage(eligibility, [evidence('m1', 0.5, 101)], new Set(['m1']), {
        ...policy,
        minimumOccupiedEligibleBins: 1,
        minimumOccupiedDirectionalBins: 1,
      }),
    ).toThrow(/future market evidence/);

    expect(() =>
      assessFeatureStrataCoverage(eligibility, [evidence('m1', 0.5, 90, 111)], new Set(['m1']), {
        ...policy,
        minimumOccupiedEligibleBins: 1,
        minimumOccupiedDirectionalBins: 1,
      }),
    ).toThrow(/learned after the scan knowledge-time/);

    expect(() =>
      assessFeatureStrataCoverage(
        eligibility,
        [evidence('m1', 0.5, 90), evidence('m1', 0.6, 90)],
        new Set(['m1']),
        { ...policy, minimumOccupiedEligibleBins: 1, minimumOccupiedDirectionalBins: 1 },
      ),
    ).toThrow(/duplicate feature strata evidence/);

    expect(() =>
      assessFeatureStrataCoverage(eligibility, [evidence('other', 0.5, 90)], new Set(['m1']), {
        ...policy,
        minimumOccupiedEligibleBins: 1,
        minimumOccupiedDirectionalBins: 1,
      }),
    ).toThrow(/ineligible mission/);
  });

  it('rejects post-hoc or malformed strata policies', () => {
    const eligibility = [eligible('m1', 100)];
    expect(() =>
      assessFeatureStrataCoverage(eligibility, [evidence('m1', 0.5, 90)], new Set(['m1']), {
        ...policy,
        boundaries: [0, 0.7, 0.6, 1],
      }),
    ).toThrow(/strictly increasing/);
    expect(() =>
      assessFeatureStrataCoverage(eligibility, [evidence('m1', 0.5, 90)], new Set(['m1']), {
        ...policy,
        maximumDirectionalBinShare: 0,
      }),
    ).toThrow(/maximumDirectionalBinShare/);
  });
});
