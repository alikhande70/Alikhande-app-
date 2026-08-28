import { describe, expect, it } from 'vitest';
import {
  projectSnapshotFeatureStrataEvidence,
  type SnapshotMissionForFeatureStrata,
} from './snapshot-feature-strata.js';

const FEATURE_KEY = 'trend-alignment';
const FEATURE_SET = 'features:v3';

function mission(overrides: Partial<SnapshotMissionForFeatureStrata> = {}): SnapshotMissionForFeatureStrata {
  return {
    missionId: 'mission-1',
    observedAt: 100,
    decisionSnapshot: {
      asOf: 110,
      brainEvaluation: {
        featureSetVersion: FEATURE_SET,
        decisionAsOf: 110,
        knowledgeCutoff: 120,
        evidence: [
          {
            featureKey: FEATURE_KEY,
            validAt: 105,
            recordedAt: 108,
            normalizedValue: 0.72,
          },
        ],
        missing: [],
      },
    },
    ...overrides,
  };
}

describe('projectSnapshotFeatureStrataEvidence', () => {
  it('projects the exact bitemporal value sealed into the immutable snapshot', () => {
    expect(projectSnapshotFeatureStrataEvidence([mission()], FEATURE_KEY, FEATURE_SET)).toEqual([
      {
        missionId: 'mission-1',
        featureKey: FEATURE_KEY,
        normalizedValue: 0.72,
        validAt: 105,
        recordedAt: 108,
      },
    ]);
  });

  it('keeps a missing decision snapshot visible by omitting evidence instead of fabricating it', () => {
    expect(
      projectSnapshotFeatureStrataEvidence(
        [mission({ decisionSnapshot: undefined })],
        FEATURE_KEY,
        FEATURE_SET,
      ),
    ).toEqual([]);
  });

  it('keeps a feature explicitly missing at decision time as missing evidence', () => {
    const missingFeature = mission({
      decisionSnapshot: {
        asOf: 110,
        brainEvaluation: {
          featureSetVersion: FEATURE_SET,
          decisionAsOf: 110,
          knowledgeCutoff: 120,
          evidence: [],
          missing: [FEATURE_KEY],
        },
      },
    });

    expect(projectSnapshotFeatureStrataEvidence([missingFeature], FEATURE_KEY, FEATURE_SET)).toEqual(
      [],
    );
  });

  it('fails closed when an older feature schema is mixed into the registered cohort', () => {
    const stale = mission({
      decisionSnapshot: {
        asOf: 110,
        brainEvaluation: {
          featureSetVersion: 'features:v2',
          decisionAsOf: 110,
          knowledgeCutoff: 120,
          evidence: [],
          missing: [FEATURE_KEY],
        },
      },
    });

    expect(() => projectSnapshotFeatureStrataEvidence([stale], FEATURE_KEY, FEATURE_SET)).toThrow(
      /feature-set mismatch/,
    );
  });

  it('rejects a caller-visible feature that was learned after the sealed knowledge cutoff', () => {
    const leaked = mission({
      decisionSnapshot: {
        asOf: 110,
        brainEvaluation: {
          featureSetVersion: FEATURE_SET,
          decisionAsOf: 110,
          knowledgeCutoff: 120,
          evidence: [
            {
              featureKey: FEATURE_KEY,
              validAt: 105,
              recordedAt: 121,
              normalizedValue: 0.9,
            },
          ],
          missing: [],
        },
      },
    });

    expect(() => projectSnapshotFeatureStrataEvidence([leaked], FEATURE_KEY, FEATURE_SET)).toThrow(
      /learned after knowledgeCutoff/,
    );
  });

  it('rejects future market evidence even when it was persisted into a malformed snapshot', () => {
    const future = mission({
      decisionSnapshot: {
        asOf: 110,
        brainEvaluation: {
          featureSetVersion: FEATURE_SET,
          decisionAsOf: 110,
          knowledgeCutoff: 130,
          evidence: [
            {
              featureKey: FEATURE_KEY,
              validAt: 111,
              recordedAt: 112,
              normalizedValue: 0.9,
            },
          ],
          missing: [],
        },
      },
    });

    expect(() => projectSnapshotFeatureStrataEvidence([future], FEATURE_KEY, FEATURE_SET)).toThrow(
      /uses future evidence/,
    );
  });

  it('rejects a feature silently absent from both evidence and the decision-time missing set', () => {
    const hidden = mission({
      decisionSnapshot: {
        asOf: 110,
        brainEvaluation: {
          featureSetVersion: FEATURE_SET,
          decisionAsOf: 110,
          knowledgeCutoff: 120,
          evidence: [],
          missing: [],
        },
      },
    });

    expect(() => projectSnapshotFeatureStrataEvidence([hidden], FEATURE_KEY, FEATURE_SET)).toThrow(
      /neither persists nor marks feature/,
    );
  });

  it('rejects duplicate mission identities so evidence cannot be counted twice', () => {
    expect(() =>
      projectSnapshotFeatureStrataEvidence([mission(), mission()], FEATURE_KEY, FEATURE_SET),
    ).toThrow(/duplicate snapshot mission/);
  });

  it('rejects duplicate feature keys inside a malformed immutable snapshot', () => {
    const duplicateFeature = mission({
      decisionSnapshot: {
        asOf: 110,
        brainEvaluation: {
          featureSetVersion: FEATURE_SET,
          decisionAsOf: 110,
          knowledgeCutoff: 120,
          evidence: [
            {
              featureKey: FEATURE_KEY,
              validAt: 105,
              recordedAt: 108,
              normalizedValue: 0.72,
            },
            {
              featureKey: FEATURE_KEY,
              validAt: 106,
              recordedAt: 109,
              normalizedValue: 0.74,
            },
          ],
          missing: [],
        },
      },
    });

    expect(() =>
      projectSnapshotFeatureStrataEvidence([duplicateFeature], FEATURE_KEY, FEATURE_SET),
    ).toThrow(/duplicate feature/);
  });

  it('rejects a snapshot timeline that predates the market observation', () => {
    const impossible = mission({
      observedAt: 111,
    });

    expect(() =>
      projectSnapshotFeatureStrataEvidence([impossible], FEATURE_KEY, FEATURE_SET),
    ).toThrow(/predates its market observation/);
  });
});
