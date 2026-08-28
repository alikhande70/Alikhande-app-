import { describe, expect, it } from 'vitest';
import { evaluateScanPopulation } from './evaluation.js';
import {
  type DurableMissionForEvaluation,
  projectDurableMissionsForEvaluation,
  projectDurableMissionsForPairedEvaluation,
  type VersionedMarketOutcomeLabel,
} from './mission-evaluation.js';
import { buildForwardPairedCohort } from './paired-evaluation.js';

const HASH = `sha256:${'a'.repeat(64)}` as const;
const CHALLENGER_HASH = `sha256:${'b'.repeat(64)}` as const;

function mission(overrides: Partial<DurableMissionForEvaluation> = {}): DurableMissionForEvaluation {
  return {
    missionId: 'mission-1',
    scanConfigVersion: 'scan-v1',
    observedAt: 100,
    decisionSnapshot: {
      asOf: 110,
      brainEvaluation: {
        status: 'scored',
        brainVersion: 'brain-v1',
        knowledgeCutoff: 120,
        score: 78,
      },
      brainComparison: {
        missionKnowledgeTime: 120,
        championHash: HASH,
      },
    },
    ...overrides,
  };
}

function pairedMission(overrides: Partial<DurableMissionForEvaluation> = {}): DurableMissionForEvaluation {
  return mission({
    decisionSnapshot: {
      asOf: 110,
      brainEvaluation: {
        status: 'scored',
        brainVersion: 'brain-v1',
        knowledgeCutoff: 120,
        score: 78,
      },
      brainComparison: {
        missionKnowledgeTime: 120,
        championHash: HASH,
        evaluations: [
          {
            contentHash: HASH,
            role: 'champion',
            createdAt: 10,
            evaluation: {
              status: 'scored',
              brainVersion: 'brain-v1',
              knowledgeCutoff: 120,
              decisionAsOf: 110,
              score: 78,
              missing: [],
            },
          },
          {
            contentHash: CHALLENGER_HASH,
            role: 'challenger',
            createdAt: 100,
            evaluation: {
              status: 'scored',
              brainVersion: 'brain-v2',
              knowledgeCutoff: 120,
              decisionAsOf: 110,
              score: 81,
              missing: [],
            },
          },
        ],
      },
    },
    ...overrides,
  });
}

function label(overrides: Partial<VersionedMarketOutcomeLabel> = {}): VersionedMarketOutcomeLabel {
  return {
    labelVersion: 'future-r-v1',
    missionId: 'mission-1',
    decisionKnowledgeTime: 120,
    validAt: 220,
    recordedAt: 230,
    directional: 'favourable',
    counterfactualR: 1.5,
    ...overrides,
  };
}

describe('projectDurableMissionsForEvaluation', () => {
  it('feeds durable mission evidence directly into the scan evaluator', () => {
    const scans = projectDurableMissionsForEvaluation([mission()], [label()]);
    const report = evaluateScanPopulation(scans, {
      minimumScans: 1,
      minimumOutcomes: 1,
      evaluationCutoff: 300,
    });

    expect(report.status).toBe('ready');
    expect(report.decisionQuality.scoredScans).toBe(1);
    expect(report.outcomes.eligibleOutcomes).toBe(1);
    expect(report.outcomes.meanCounterfactualR).toBe(1.5);
    expect(scans[0]?.brainContentHash).toBe(HASH);
  });

  it('preserves explicit insufficient-data rather than inventing a score', () => {
    const scans = projectDurableMissionsForEvaluation([
      mission({
        decisionSnapshot: {
          asOf: 110,
          brainEvaluation: {
            status: 'insufficient-data',
            brainVersion: 'brain-v1',
            knowledgeCutoff: 120,
            missing: ['spread'],
          },
          brainComparison: { missionKnowledgeTime: 120, championHash: HASH },
        },
      }),
    ]);

    expect(scans[0]?.decision).toEqual({ status: 'insufficient-data', missing: ['spread'] });
  });

  it('rejects a future label generated against a different decision cutoff', () => {
    expect(() =>
      projectDurableMissionsForEvaluation([mission()], [label({ decisionKnowledgeTime: 121 })]),
    ).toThrow(/decision cutoff mismatch/);
  });

  it('rejects hindsight labels and impossible bitemporal ordering', () => {
    expect(() => projectDurableMissionsForEvaluation([mission()], [label({ validAt: 120 })])).toThrow(
      /not strictly forward/,
    );
    expect(() =>
      projectDurableMissionsForEvaluation([mission()], [label({ validAt: 220, recordedAt: 219 })]),
    ).toThrow(/recorded before it became valid/);
  });

  it('fails closed when immutable Brain identity is absent or cutoffs diverge', () => {
    expect(() => projectDurableMissionsForEvaluation([mission({ decisionSnapshot: { asOf: 110 } })])).toThrow(
      /lacks sealed Brain evaluation identity/,
    );

    expect(() =>
      projectDurableMissionsForEvaluation([
        mission({
          decisionSnapshot: {
            asOf: 110,
            brainEvaluation: {
              status: 'scored',
              brainVersion: 'brain-v1',
              knowledgeCutoff: 120,
              score: 78,
            },
            brainComparison: { missionKnowledgeTime: 121, championHash: HASH },
          },
        }),
      ]),
    ).toThrow(/divergent Brain knowledge cutoffs/);
  });

  it('rejects duplicate labels so later writes cannot silently overwrite evidence', () => {
    expect(() => projectDurableMissionsForEvaluation([mission()], [label(), label()])).toThrow(
      /duplicate outcome label/,
    );
  });
});

describe('projectDurableMissionsForPairedEvaluation', () => {
  it('projects the exact durable champion/challenger pair into the forward cohort', () => {
    const pairs = projectDurableMissionsForPairedEvaluation([pairedMission()]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.champion.brainContentHash).toBe(HASH);
    expect(pairs[0]?.challenger.brainContentHash).toBe(CHALLENGER_HASH);

    const report = buildForwardPairedCohort(pairs, {
      minimumPairs: 1,
      minimumFullyScoredPairs: 1,
      minimumDurationMs: 0,
    });
    expect(report.status).toBe('ready');
    expect(report.totalPairs).toBe(1);
  });

  it('rejects challenger evidence created at the decision boundary', () => {
    const base = pairedMission();
    const snapshot = base.decisionSnapshot;
    if (snapshot?.brainComparison?.evaluations === undefined) throw new Error('fixture missing comparison');
    const evaluations = snapshot.brainComparison.evaluations.map((entry) =>
      entry.role === 'challenger' ? { ...entry, createdAt: 120 } : entry,
    );

    expect(() =>
      projectDurableMissionsForPairedEvaluation([
        pairedMission({
          decisionSnapshot: {
            ...snapshot,
            brainComparison: { ...snapshot.brainComparison, evaluations },
          },
        }),
      ]),
    ).toThrow(/not forward-only evidence/);
  });

  it('fails closed if durable champion shadow evidence diverges from the primary decision', () => {
    const base = pairedMission();
    const snapshot = base.decisionSnapshot;
    if (snapshot?.brainComparison?.evaluations === undefined) throw new Error('fixture missing comparison');
    const evaluations = snapshot.brainComparison.evaluations.map((entry) =>
      entry.role === 'champion'
        ? { ...entry, evaluation: { ...entry.evaluation, score: 77 } }
        : entry,
    );

    expect(() =>
      projectDurableMissionsForPairedEvaluation([
        pairedMission({
          decisionSnapshot: {
            ...snapshot,
            brainComparison: { ...snapshot.brainComparison, evaluations },
          },
        }),
      ]),
    ).toThrow(/diverges from primary Brain decision/);
  });

  it('rejects duplicate immutable Brain identities within one Mission', () => {
    const base = pairedMission();
    const snapshot = base.decisionSnapshot;
    if (snapshot?.brainComparison?.evaluations === undefined) throw new Error('fixture missing comparison');
    const duplicate = snapshot.brainComparison.evaluations[1];
    if (duplicate === undefined) throw new Error('fixture missing challenger');

    expect(() =>
      projectDurableMissionsForPairedEvaluation([
        pairedMission({
          decisionSnapshot: {
            ...snapshot,
            brainComparison: {
              ...snapshot.brainComparison,
              evaluations: [...snapshot.brainComparison.evaluations, duplicate],
            },
          },
        }),
      ]),
    ).toThrow(/repeats Brain content/);
  });
});
