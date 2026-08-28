import { describe, expect, it } from 'vitest';
import type { VersionedMarketOutcomeLabel } from './mission-evaluation.js';
import {
  inferForwardPairedOutcomeAlignment,
  type PairedOutcomeInferencePolicy,
} from './paired-inference.js';
import type { ForwardPairedScanEvidence } from './paired-evaluation.js';

const championHash = `sha256:${'a'.repeat(64)}`;
const challengerHash = `sha256:${'b'.repeat(64)}`;
const challengerCreatedAt = 1_000;
const policy: PairedOutcomeInferencePolicy = {
  minimumPairs: 4,
  minimumFullyScoredPairs: 4,
  minimumDurationMs: 300,
  evaluationCutoff: 10_000,
  minimumOutcomeCoverage: 1,
  minimumDirectionalComparisons: 4,
};

function pair(missionId: string, knowledgeTime: number): ForwardPairedScanEvidence {
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
      decision: { status: 'scored', score: 80 },
    },
  };
}

function label(
  missionId: string,
  decisionKnowledgeTime: number,
  directional: VersionedMarketOutcomeLabel['directional'] = 'favourable',
  overrides: Partial<VersionedMarketOutcomeLabel> = {},
): VersionedMarketOutcomeLabel {
  return {
    labelVersion: 'fixed-horizon-v1',
    missionId,
    decisionKnowledgeTime,
    validAt: decisionKnowledgeTime + 100,
    recordedAt: decisionKnowledgeTime + 100,
    directional,
    counterfactualR: directional === 'favourable' ? 1 : directional === 'unfavourable' ? -1 : 0,
    ...overrides,
  };
}

const evidence = [
  pair('m1', 1_100),
  pair('m2', 1_200),
  pair('m3', 1_300),
  pair('m4', 1_400),
];

const favourableLabels = [
  label('m1', 1_100),
  label('m2', 1_200),
  label('m3', 1_300),
  label('m4', 1_400),
];

describe('forward paired outcome inference', () => {
  it('uses the same forward outcomes and reports challenger-favouring evidence without promotion', () => {
    const report = inferForwardPairedOutcomeAlignment(evidence, favourableLabels, policy);

    expect(report.status).toBe('ready');
    expect(report.inference).toBe('challenger-favouring');
    expect(report.challengerAlignedPairs).toBe(4);
    expect(report.championAlignedPairs).toBe(0);
    expect(report.challengerAlignmentShare).toBe(1);
    expect(report.challengerAlignmentWilson95?.lower).toBeGreaterThan(0.5);
    expect(report.outcomeCoverage).toBe(1);

    const output = report as unknown as Record<string, unknown>;
    expect(output.winner).toBeUndefined();
    expect(output.promote).toBeUndefined();
    expect(output.recommendation).toBeUndefined();
  });

  it('treats lower scores as better aligned when the same future setup outcome is unfavourable', () => {
    const challengerLower = evidence.map((item) => ({
      ...item,
      challenger: {
        ...item.challenger,
        decision: { status: 'scored' as const, score: 60 },
      },
    }));
    const labels = evidence.map((item) => label(item.missionId, item.knowledgeTime, 'unfavourable'));

    const report = inferForwardPairedOutcomeAlignment(challengerLower, labels, policy);

    expect(report.inference).toBe('challenger-favouring');
    expect(report.challengerAlignedPairs).toBe(4);
  });

  it('reports inconclusive when paired directional evidence is balanced', () => {
    const labels = [
      label('m1', 1_100, 'favourable'),
      label('m2', 1_200, 'favourable'),
      label('m3', 1_300, 'unfavourable'),
      label('m4', 1_400, 'unfavourable'),
    ];

    const report = inferForwardPairedOutcomeAlignment(evidence, labels, policy);

    expect(report.status).toBe('ready');
    expect(report.inference).toBe('inconclusive');
    expect(report.challengerAlignedPairs).toBe(2);
    expect(report.championAlignedPairs).toBe(2);
    expect(report.challengerAlignmentWilson95?.lower).toBeLessThan(0.5);
    expect(report.challengerAlignmentWilson95?.upper).toBeGreaterThan(0.5);
  });

  it('keeps late outcomes unavailable at a historical cutoff instead of leaking them into inference', () => {
    const labels = favourableLabels.map((item, index) =>
      index === 3 ? { ...item, recordedAt: policy.evaluationCutoff + 1 } : item,
    );

    const report = inferForwardPairedOutcomeAlignment(evidence, labels, policy);

    expect(report.status).toBe('insufficient-data');
    expect(report.reasons).toContain('minimum-outcome-coverage-not-met');
    expect(report.reasons).toContain('minimum-directional-comparisons-not-met');
    expect(report.eligibleOutcomePairs).toBe(3);
    expect(report.missingOutcomePairs).toBe(1);
    expect(report.inference).toBe('insufficient-data');
  });

  it('does not let flat outcomes, tied scores, or insufficient Brain data inflate decisive evidence', () => {
    const modified = evidence.map((item, index) => {
      if (index === 1) {
        return {
          ...item,
          challenger: { ...item.challenger, decision: { status: 'scored' as const, score: 70 } },
        };
      }
      if (index === 2) {
        return {
          ...item,
          challenger: {
            ...item.challenger,
            decision: { status: 'insufficient-data' as const, missing: ['spread'] },
          },
        };
      }
      return item;
    });
    const labels = [
      label('m1', 1_100, 'flat'),
      label('m2', 1_200),
      label('m3', 1_300),
      label('m4', 1_400),
    ];

    const report = inferForwardPairedOutcomeAlignment(modified, labels, {
      ...policy,
      minimumFullyScoredPairs: 3,
      minimumDirectionalComparisons: 1,
    });

    expect(report.flatOutcomePairs).toBe(1);
    expect(report.tiedDirectionalPairs).toBe(1);
    expect(report.incompleteDecisionPairs).toBe(1);
    expect(report.decisiveDirectionalPairs).toBe(1);
  });

  it('fails closed on outcome identity, temporal corruption, cohort leakage, and label-version drift', () => {
    expect(() =>
      inferForwardPairedOutcomeAlignment(
        evidence,
        [...favourableLabels, label('outside', 1_500)],
        policy,
      ),
    ).toThrow(/outside the paired cohort/);

    expect(() =>
      inferForwardPairedOutcomeAlignment(
        evidence,
        favourableLabels.map((item, index) =>
          index === 0 ? { ...item, decisionKnowledgeTime: item.decisionKnowledgeTime + 1 } : item,
        ),
        policy,
      ),
    ).toThrow(/decision cutoff mismatch/);

    expect(() =>
      inferForwardPairedOutcomeAlignment(
        evidence,
        favourableLabels.map((item, index) =>
          index === 0 ? { ...item, validAt: item.decisionKnowledgeTime } : item,
        ),
        policy,
      ),
    ).toThrow(/not strictly forward/);

    expect(() =>
      inferForwardPairedOutcomeAlignment(
        evidence,
        favourableLabels.map((item, index) =>
          index === 0 ? { ...item, labelVersion: 'fixed-horizon-v2' } : item,
        ),
        policy,
      ),
    ).toThrow(/one outcome label version/);
  });
});
