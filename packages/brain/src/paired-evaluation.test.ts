import { describe, expect, it } from 'vitest';
import {
  buildForwardPairedCohort,
  type ForwardPairedScanEvidence,
  type PairedEvaluationPolicy,
} from './paired-evaluation.js';

const championHash = `sha256:${'a'.repeat(64)}`;
const challengerHash = `sha256:${'b'.repeat(64)}`;
const challengerCreatedAt = 1_000;
const policy: PairedEvaluationPolicy = { minimumPairs: 2, minimumDurationMs: 100 };

function pair(
  missionId: string,
  knowledgeTime: number,
  overrides: Partial<ForwardPairedScanEvidence> = {},
): ForwardPairedScanEvidence {
  return {
    missionId,
    scanConfigVersion: 'scan-v1',
    knowledgeTime,
    challengerCreatedAt,
    champion: {
      brainContentHash: championHash,
      brainVersion: 'brain-v1',
      decision: { status: 'scored', score: 70 },
    },
    challenger: {
      brainContentHash: challengerHash,
      brainVersion: 'brain-v2',
      decision: { status: 'scored', score: 72 },
    },
    ...overrides,
  };
}

describe('forward-only paired evaluation cohort', () => {
  it('accepts only an uncontaminated single-version pair and applies pre-registered gates', () => {
    const report = buildForwardPairedCohort([pair('m1', 1_100), pair('m2', 1_250)], policy);

    expect(report).toEqual({
      status: 'ready',
      reasons: [],
      scanConfigVersion: 'scan-v1',
      championHash,
      challengerHash,
      challengerCreatedAt,
      totalPairs: 2,
      fullyScoredPairs: 2,
      pairsWithInsufficientData: 0,
      durationMs: 150,
    });
  });

  it('treats missing Brain evidence as a population fact rather than inventing a score', () => {
    const report = buildForwardPairedCohort(
      [
        pair('m1', 1_100, {
          challenger: {
            brainContentHash: challengerHash,
            brainVersion: 'brain-v2',
            decision: { status: 'insufficient-data', missing: ['spread'] },
          },
        }),
        pair('m2', 1_250),
      ],
      policy,
    );

    expect(report.status).toBe('ready');
    expect(report.fullyScoredPairs).toBe(1);
    expect(report.pairsWithInsufficientData).toBe(1);
  });

  it('returns insufficient-data when sample or duration gates are not met', () => {
    const report = buildForwardPairedCohort([pair('m1', 1_010), pair('m2', 1_020)], {
      minimumPairs: 3,
      minimumDurationMs: 100,
    });

    expect(report.status).toBe('insufficient-data');
    expect(report.reasons).toEqual([
      'minimum-paired-scan-population-not-met',
      'minimum-forward-duration-not-met',
    ]);
  });

  it('fails closed at and before challenger creation instead of silently admitting hindsight', () => {
    expect(() => buildForwardPairedCohort([pair('m1', challengerCreatedAt)], policy)).toThrow(
      /not forward-only challenger evidence/,
    );
    expect(() => buildForwardPairedCohort([pair('m1', challengerCreatedAt - 1)], policy)).toThrow(
      /not forward-only challenger evidence/,
    );
  });

  it('rejects duplicate Missions, population drift, and changing immutable pair identity', () => {
    expect(() => buildForwardPairedCohort([pair('m1', 1_100), pair('m1', 1_250)], policy)).toThrow(
      /duplicate mission/,
    );

    expect(() =>
      buildForwardPairedCohort(
        [pair('m1', 1_100), pair('m2', 1_250, { scanConfigVersion: 'scan-v2' })],
        policy,
      ),
    ).toThrow(/one scan configuration cohort/);

    expect(() =>
      buildForwardPairedCohort(
        [
          pair('m1', 1_100),
          pair('m2', 1_250, {
            challenger: {
              brainContentHash: `sha256:${'c'.repeat(64)}`,
              brainVersion: 'brain-v3',
              decision: { status: 'scored', score: 73 },
            },
          }),
        ],
        policy,
      ),
    ).toThrow(/one challenger content hash/);
  });

  it('contains no winner or promotion output', () => {
    const report = buildForwardPairedCohort([pair('m1', 1_100), pair('m2', 1_250)], policy);
    const output = report as unknown as Record<string, unknown>;

    expect(output.winner).toBeUndefined();
    expect(output.promote).toBeUndefined();
    expect(output.recommendation).toBeUndefined();
  });
});
