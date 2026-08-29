import { describe, expect, it } from 'vitest';
import {
  buildDependenceAwarePreRegisteredEvaluation,
  type DependenceAwareEvaluationPolicy,
  type DependenceAwareEvaluationPopulation,
} from './dependence-aware-evaluation.js';
import type { EvaluationPipelineMission } from './evaluation-pipeline.js';
import type { MarketCloseObservation } from './outcome-labeling.js';

const championHash = `sha256:${'a'.repeat(64)}` as const;
const challengerHash = `sha256:${'b'.repeat(64)}` as const;
const challengerCreatedAt = 1_000;
const analysisCutoff = 2_000;

function mission(
  missionId: string,
  knowledgeTime: number,
  challengerScore = 80,
): EvaluationPipelineMission {
  return {
    missionId,
    scanConfigVersion: 'scan-v1',
    observedAt: knowledgeTime - 1,
    canonical: 'XAUUSD',
    decisionSnapshot: {
      asOf: knowledgeTime - 1,
      plan: { side: 'buy', entry: '2400', stop: '2390' },
      brainEvaluation: {
        status: 'scored',
        brainVersion: 'brain-v1',
        knowledgeCutoff: knowledgeTime,
        score: 60,
      },
      brainComparison: {
        missionKnowledgeTime: knowledgeTime,
        championHash,
        evaluations: [
          {
            contentHash: championHash,
            role: 'champion',
            createdAt: 0,
            evaluation: {
              status: 'scored',
              brainVersion: 'brain-v1',
              knowledgeCutoff: knowledgeTime,
              score: 60,
            },
          },
          {
            contentHash: challengerHash,
            role: 'challenger',
            createdAt: challengerCreatedAt,
            evaluation: {
              status: 'scored',
              brainVersion: 'brain-v2',
              knowledgeCutoff: knowledgeTime,
              score: challengerScore,
            },
          },
        ],
      },
    },
  };
}

function population(
  times: readonly number[],
  challengerScores: readonly number[] = [],
): DependenceAwareEvaluationPopulation {
  const missions = times.map((time, index) =>
    mission(`m${index + 1}`, time, challengerScores[index] ?? 80),
  );
  return {
    missions,
    pairedEligibility: missions.map((item, index) => ({
      missionId: item.missionId,
      canonical: item.canonical,
      scanConfigVersion: item.scanConfigVersion,
      observedAt: item.observedAt,
      knownAt: times[index] ?? 0,
    })),
    ledgerHead: { seq: missions.length * 2, hash: 'ledger-head-dependence-test' },
  };
}

function observations(times: readonly number[]): MarketCloseObservation[] {
  return times.map((time) => ({
    symbol: 'XAUUSD',
    validAt: time + 100,
    recordedAt: time + 100,
    close: 2420,
  }));
}

function policy(episodeGapMs: number): DependenceAwareEvaluationPolicy {
  return {
    currentKnowledgeCutoff: analysisCutoff,
    aggregate: {
      minimumScans: 4,
      minimumOutcomes: 4,
      evaluationCutoff: analysisCutoff,
    },
    paired: {
      minimumPairs: 4,
      minimumFullyScoredPairs: 4,
      minimumDurationMs: 30,
      minimumOutcomeCoverage: 1,
      minimumDirectionalComparisons: 4,
    },
    analysisPlan: {
      planId: 'challenger-b-episode-aware-v1',
      challengerContentHash: challengerHash,
      registeredAt: challengerCreatedAt,
      analysisCutoff,
      minimumPairingCoverage: 1,
      dependence: {
        episodeGapMs,
        minimumIndependentEpisodes: 2,
      },
      maturity: {
        minimumForwardSpanMs: 200,
        maturityBucketMs: 100,
        minimumOccupiedMaturityBuckets: 2,
      },
    },
  };
}

describe('dependence-aware pre-registered evaluation', () => {
  it('blocks readiness when raw paired scans all belong to one continuing market episode', () => {
    const times = [1_100, 1_110, 1_120, 1_130];
    const result = buildDependenceAwarePreRegisteredEvaluation(
      population(times),
      observations(times),
      { labelVersion: 'fixed-horizon-v1', horizonMs: 100, flatThresholdR: 0.01 },
      policy(15),
    );

    expect(result.paired.status).toBe('insufficient-data');
    if (result.paired.status === 'analysis-window-open') throw new Error('unreachable');
    expect(result.paired.observedPairedPopulation).toBe(4);
    expect(result.paired.inference?.decisiveDirectionalPairs).toBe(4);
    expect(result.dependence?.rawScanCount).toBe(4);
    expect(result.dependence?.effectiveEvidenceUnits).toBe(1);
    expect(result.directionalDependence?.effectiveEvidenceUnits).toBe(1);
    expect(result.episodeBalancedInference?.decisiveEpisodeCount).toBe(1);
    expect(result.longitudinalMaturity?.status).toBe('insufficient-data');
    expect(result.paired.reasons).toContain('minimum-independent-market-episodes-not-met');
  });

  it('allows the existing paired gates to decide once decisive scans span separated mature episodes', () => {
    const times = [1_100, 1_200, 1_300, 1_400];
    const result = buildDependenceAwarePreRegisteredEvaluation(
      population(times),
      observations(times),
      { labelVersion: 'fixed-horizon-v1', horizonMs: 100, flatThresholdR: 0.01 },
      policy(50),
    );

    expect(result.paired.status).toBe('ready');
    expect(result.dependence?.episodeCount).toBe(4);
    expect(result.directionalDependence?.episodeCount).toBe(4);
    expect(result.dependence?.largestEpisodeShare).toBe(0.25);
    expect(result.episodeBalancedInference?.decisiveEpisodeCount).toBe(4);
    expect(result.longitudinalMaturity?.status).toBe('ready');
  });

  it('blocks separated episodes that are still too young longitudinally', () => {
    const times = [1_100, 1_130, 1_160, 1_190];
    const configured = policy(20);
    const result = buildDependenceAwarePreRegisteredEvaluation(
      population(times),
      observations(times),
      { labelVersion: 'fixed-horizon-v1', horizonMs: 100, flatThresholdR: 0.01 },
      {
        ...configured,
        analysisPlan: {
          ...configured.analysisPlan,
          maturity: {
            minimumForwardSpanMs: 500,
            maturityBucketMs: 250,
            minimumOccupiedMaturityBuckets: 2,
          },
        },
      },
    );

    expect(result.directionalDependence?.episodeCount).toBe(4);
    expect(result.longitudinalMaturity?.status).toBe('insufficient-data');
    expect(result.paired.status).toBe('insufficient-data');
    expect(result.paired.reasons).toContain('maturity-minimum-forward-span-not-met');
    expect(result.paired.reasons).toContain('maturity-minimum-maturity-buckets-not-met');
  });

  it('blocks false confidence when decisive evidence is concentrated in one episode', () => {
    const times = [1_100, 1_110, 1_120, 1_130, 1_400, 1_600, 1_800];
    const scores = [80, 80, 80, 80, 60, 60, 60];
    const configured = policy(15);
    const result = buildDependenceAwarePreRegisteredEvaluation(
      population(times, scores),
      observations(times),
      { labelVersion: 'fixed-horizon-v1', horizonMs: 100, flatThresholdR: 0.01 },
      {
        ...configured,
        aggregate: { ...configured.aggregate, minimumScans: 7, minimumOutcomes: 7 },
        paired: { ...configured.paired, minimumPairs: 7, minimumFullyScoredPairs: 7 },
      },
    );

    if (result.paired.status === 'analysis-window-open') throw new Error('unreachable');
    expect(result.paired.inference?.decisiveDirectionalPairs).toBe(4);
    expect(result.dependence?.episodeCount).toBe(4);
    expect(result.directionalDependence?.episodeCount).toBe(1);
    expect(result.paired.status).toBe('insufficient-data');
    expect(result.paired.reasons).toContain(
      'directional-minimum-independent-market-episodes-not-met',
    );
  });

  it('uses episode-balanced uncertainty instead of treating every scan as independent', () => {
    const times = [1_100, 1_110, 1_120, 1_130, 1_400, 1_600, 1_800];
    const scores = [80, 80, 80, 80, 40, 40, 40];
    const configured = policy(15);
    const result = buildDependenceAwarePreRegisteredEvaluation(
      population(times, scores),
      observations(times),
      { labelVersion: 'fixed-horizon-v1', horizonMs: 100, flatThresholdR: 0.01 },
      {
        ...configured,
        aggregate: { ...configured.aggregate, minimumScans: 7, minimumOutcomes: 7 },
        paired: {
          ...configured.paired,
          minimumPairs: 7,
          minimumFullyScoredPairs: 7,
          minimumDirectionalComparisons: 7,
        },
      },
    );

    if (result.paired.status === 'analysis-window-open') throw new Error('unreachable');
    expect(result.paired.inference?.challengerAlignedPairs).toBe(4);
    expect(result.paired.inference?.championAlignedPairs).toBe(3);
    expect(result.episodeBalancedInference?.challengerAlignedEpisodes).toBe(1);
    expect(result.episodeBalancedInference?.championAlignedEpisodes).toBe(3);
    expect(result.episodeBalancedInference?.decisiveEpisodeCount).toBe(4);
    expect(result.episodeBalancedInference?.inference).toBe('inconclusive');
  });

  it('fails closed if durable eligibility rewrites the canonical instrument identity', () => {
    const times = [1_100, 1_200, 1_300, 1_400];
    const base = population(times);
    const drifted: DependenceAwareEvaluationPopulation = {
      ...base,
      pairedEligibility: base.pairedEligibility.map((item) =>
        item.missionId === 'm1' ? { ...item, canonical: 'EURUSD' } : item,
      ),
    };

    expect(() =>
      buildDependenceAwarePreRegisteredEvaluation(
        drifted,
        observations(times),
        { labelVersion: 'fixed-horizon-v1', horizonMs: 100, flatThresholdR: 0.01 },
        policy(50),
      ),
    ).toThrow(/canonical identity drift/);
  });

  it('does not reveal diagnostics before the fixed analysis window closes', () => {
    const times = [1_100, 1_200, 1_300, 1_400];
    const configured = policy(50);
    const early: DependenceAwareEvaluationPolicy = {
      ...configured,
      currentKnowledgeCutoff: 1_500,
      aggregate: { ...configured.aggregate, evaluationCutoff: 1_500 },
    };
    const result = buildDependenceAwarePreRegisteredEvaluation(
      population(times),
      observations(times),
      { labelVersion: 'fixed-horizon-v1', horizonMs: 100, flatThresholdR: 0.01 },
      early,
    );

    expect(result.paired.status).toBe('analysis-window-open');
    expect(result.dependence).toBeNull();
    expect(result.directionalDependence).toBeNull();
    expect(result.episodeBalancedInference).toBeNull();
    expect(result.longitudinalMaturity).toBeNull();
  });
});
