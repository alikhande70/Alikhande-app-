import { describe, expect, it } from 'vitest';
import { Ledger } from '../ledger/ledger.js';
import { buildMissionEvaluationPopulation } from './evaluation-population.js';
import { MissionService } from './service.js';
import type { DecisionSnapshot } from './types.js';

function scoredSnapshot(): DecisionSnapshot {
  const evaluation = {
    status: 'scored' as const,
    brainVersion: 'brain-v1',
    featureSetVersion: 'features-v1',
    rubricVersion: 'rubric-v1',
    decisionAsOf: 1_020,
    knowledgeCutoff: 1_020,
    score: 82,
    rationaleCodes: ['TREND_ALIGNED_HTF'],
    evidence: [
      {
        featureKey: 'trend',
        sourceKey: 'trendStrength',
        validAt: 1_000,
        recordedAt: 1_005,
        rawValue: 0.8,
        normalizedValue: 0.8,
      },
    ],
    missing: [] as const,
  };
  return {
    snapshotVersion: 2,
    asOf: 1_020,
    known: { source: 'immutable-mission-ledger' },
    missing: [],
    brainEvaluation: evaluation,
    brainComparison: {
      comparisonVersion: 1,
      missionKnowledgeTime: 1_020,
      championHash: `sha256:${'a'.repeat(64)}`,
      evaluations: [
        {
          contentHash: `sha256:${'a'.repeat(64)}`,
          role: 'champion',
          createdAt: 900,
          evaluation,
        },
      ],
    },
  };
}

function observeScanner(missions: MissionService, missionId: string, observedAt = 1_000): void {
  missions.observe({
    missionId,
    origin: 'scanner',
    canonical: 'XAUUSD',
    timeframe: 'M15',
    trigger: 'closed-bar-scan',
    observedAt,
    scanConfigVersion: 'scan-v7',
    marketState: { trendStrength: 0.8 },
  });
}

describe('Mission ledger -> ADR-0021 evaluation population', () => {
  it('projects sealed internal decisions while surfacing pending and external Missions explicitly', () => {
    const ledger = new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 1_030 });
    const missions = new MissionService(ledger);

    observeScanner(missions, 'mission-scored');
    missions.markCandidate('mission-scored', 'brain', 1_010);
    missions.plan('mission-scored', scoredSnapshot(), 'brain', 1_025);

    observeScanner(missions, 'mission-pending');

    missions.adoptExternalPosition({
      missionId: 'mission-external',
      canonical: 'XAUUSD',
      positionId: 'position-manual-1',
      origin: 'manual:mt5',
      observedAt: 1_000,
    });

    const population = buildMissionEvaluationPopulation(ledger);

    expect(population.missions).toHaveLength(1);
    expect(population.missions[0]).toMatchObject({
      missionId: 'mission-scored',
      canonical: 'XAUUSD',
      scanConfigVersion: 'scan-v7',
      observedAt: 1_000,
      decisionSnapshot: {
        brainEvaluation: { status: 'scored', score: 82 },
        brainComparison: { championHash: `sha256:${'a'.repeat(64)}` },
      },
    });
    expect(population.pendingDecisionMissionIds).toEqual(['mission-pending']);
    expect(population.externalMissionIds).toEqual(['mission-external']);
    expect(population.ledgerHead).toEqual(ledger.head);
    ledger.close();
  });

  it('fails closed if a market observation was durably recorded before it was valid', () => {
    const ledger = new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 1_000 });
    const missions = new MissionService(ledger);
    observeScanner(missions, 'mission-future-observation', 1_001);

    expect(() => buildMissionEvaluationPopulation(ledger)).toThrow(
      /recorded before its market observation was valid/,
    );
    ledger.close();
  });

  it('fails closed on duplicate durable Mission observations instead of inflating scan population', () => {
    const ledger = new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 1_030 });
    const observation = {
      missionId: 'mission-duplicate',
      origin: 'scanner' as const,
      canonical: 'XAUUSD',
      timeframe: 'M15',
      trigger: 'closed-bar-scan',
      observedAt: 1_000,
      scanConfigVersion: 'scan-v7',
      marketState: {},
    };
    ledger.append({ kind: 'mission.observed', observation });
    ledger.append({ kind: 'mission.observed', observation });

    expect(() => buildMissionEvaluationPopulation(ledger)).toThrow(
      /duplicate durable mission observation/,
    );
    ledger.close();
  });

  it('refuses evaluation when the ledger hash chain is no longer trustworthy', () => {
    const ledger = new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 1_030 });
    const missions = new MissionService(ledger);
    observeScanner(missions, 'mission-tamper');

    ledger.db.prepare("UPDATE ledger SET payload = '{}' WHERE seq = 1").run();

    expect(() => buildMissionEvaluationPopulation(ledger)).toThrow(
      /cannot evaluate an untrusted ledger/,
    );
    ledger.close();
  });
});
