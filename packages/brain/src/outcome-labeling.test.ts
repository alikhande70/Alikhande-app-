import { describe, expect, it } from 'vitest';
import {
  buildFixedHorizonOutcomeLabel,
  type DurableOutcomeSeedMission,
  type FixedHorizonOutcomePolicy,
  type MarketCloseObservation,
  type OutcomeMissionSeed,
  projectOutcomeSeedFromDecisionSnapshot,
} from './outcome-labeling.js';

const seed: OutcomeMissionSeed = {
  missionId: 'mission-1',
  symbol: 'SIM-XAUUSD',
  decisionKnowledgeTime: 1_000,
  direction: 'long',
  referencePrice: 100,
  riskDistance: 2,
};

const durableMission: DurableOutcomeSeedMission = {
  missionId: 'mission-1',
  canonical: 'SIM-XAUUSD',
  decisionSnapshot: {
    asOf: 990,
    brainEvaluation: { knowledgeCutoff: 1_000 },
    plan: { side: 'buy', entry: '100', stop: '98' },
  },
};

const policy: FixedHorizonOutcomePolicy = {
  labelVersion: 'fixed-close-r-v1',
  horizonMs: 300,
  flatThresholdR: 0.1,
};

const observation: MarketCloseObservation = {
  symbol: 'SIM-XAUUSD',
  validAt: 1_300,
  recordedAt: 1_305,
  close: 103,
};

describe('projectOutcomeSeedFromDecisionSnapshot', () => {
  it('derives direction, reference price and risk only from the sealed Mission snapshot', () => {
    expect(projectOutcomeSeedFromDecisionSnapshot(durableMission)).toEqual({
      status: 'ready',
      seed,
    });
  });

  it('keeps rejected or unplanned scans as first-class insufficient data', () => {
    expect(
      projectOutcomeSeedFromDecisionSnapshot({
        ...durableMission,
        decisionSnapshot: { ...durableMission.decisionSnapshot, plan: undefined },
      }),
    ).toEqual({ status: 'insufficient-data', missing: ['plan'] });

    expect(
      projectOutcomeSeedFromDecisionSnapshot({
        ...durableMission,
        decisionSnapshot: {
          ...durableMission.decisionSnapshot,
          plan: { side: 'buy', stop: '98' },
        },
      }),
    ).toEqual({ status: 'insufficient-data', missing: ['plan.entry'] });
  });

  it('fails closed on impossible historical timing or a stop on the profitable side', () => {
    expect(() =>
      projectOutcomeSeedFromDecisionSnapshot({
        ...durableMission,
        decisionSnapshot: {
          ...durableMission.decisionSnapshot,
          asOf: 1_001,
        },
      }),
    ).toThrow(/after its Brain knowledge cutoff/);

    expect(() =>
      projectOutcomeSeedFromDecisionSnapshot({
        ...durableMission,
        decisionSnapshot: {
          ...durableMission.decisionSnapshot,
          plan: { side: 'buy', entry: '100', stop: '101' },
        },
      }),
    ).toThrow(/buy plan stop must be below entry/);

    expect(() =>
      projectOutcomeSeedFromDecisionSnapshot({
        ...durableMission,
        decisionSnapshot: {
          ...durableMission.decisionSnapshot,
          plan: { side: 'sell', entry: '100', stop: '99' },
        },
      }),
    ).toThrow(/sell plan stop must be above entry/);
  });

  it('refuses non-price plan strings instead of silently manufacturing an evaluation basis', () => {
    expect(() =>
      projectOutcomeSeedFromDecisionSnapshot({
        ...durableMission,
        decisionSnapshot: {
          ...durableMission.decisionSnapshot,
          plan: { side: 'buy', entry: 'market', stop: '98' },
        },
      }),
    ).toThrow(/plan.entry is not a canonical positive decimal/);
  });

  it('composes snapshot truth directly into a deterministic future label', () => {
    const projected = projectOutcomeSeedFromDecisionSnapshot(durableMission);
    expect(projected.status).toBe('ready');
    if (projected.status !== 'ready') throw new Error('expected a ready outcome seed');

    expect(buildFixedHorizonOutcomeLabel(projected.seed, observation, policy)).toEqual({
      labelVersion: 'fixed-close-r-v1',
      missionId: 'mission-1',
      decisionKnowledgeTime: 1_000,
      validAt: 1_300,
      recordedAt: 1_305,
      directional: 'favourable',
      counterfactualR: 1.5,
    });
  });
});

describe('buildFixedHorizonOutcomeLabel', () => {
  it('builds a deterministic long counterfactual label at the exact horizon', () => {
    expect(buildFixedHorizonOutcomeLabel(seed, observation, policy)).toEqual({
      labelVersion: 'fixed-close-r-v1',
      missionId: 'mission-1',
      decisionKnowledgeTime: 1_000,
      validAt: 1_300,
      recordedAt: 1_305,
      directional: 'favourable',
      counterfactualR: 1.5,
    });
  });

  it('uses direction symmetrically for short scenarios', () => {
    const result = buildFixedHorizonOutcomeLabel(
      { ...seed, direction: 'short' },
      { ...observation, close: 97 },
      policy,
    );
    expect(result.directional).toBe('favourable');
    expect(result.counterfactualR).toBe(1.5);
  });

  it('classifies small moves as flat without changing the R value', () => {
    const result = buildFixedHorizonOutcomeLabel(seed, { ...observation, close: 100.1 }, policy);
    expect(result.directional).toBe('flat');
    expect(result.counterfactualR).toBeCloseTo(0.05);
  });

  it('rejects market evidence from a different symbol', () => {
    expect(() =>
      buildFixedHorizonOutcomeLabel(seed, { ...observation, symbol: 'SIM-EURUSD' }, policy),
    ).toThrow(/does not match mission symbol/);
  });

  it('refuses nearest-bar substitution so data availability cannot move the horizon', () => {
    expect(() =>
      buildFixedHorizonOutcomeLabel(seed, { ...observation, validAt: 1_301 }, policy),
    ).toThrow(/fixed outcome horizon exactly/);
  });

  it('rejects impossible bitemporal market evidence', () => {
    expect(() =>
      buildFixedHorizonOutcomeLabel(
        seed,
        { ...observation, validAt: 1_300, recordedAt: 1_299 },
        policy,
      ),
    ).toThrow(/recorded before it became valid/);
  });

  it('rejects invalid risk and policy inputs instead of manufacturing labels', () => {
    expect(() =>
      buildFixedHorizonOutcomeLabel({ ...seed, riskDistance: 0 }, observation, policy),
    ).toThrow(/riskDistance must be greater than zero/);
    expect(() =>
      buildFixedHorizonOutcomeLabel(seed, observation, { ...policy, horizonMs: 0 }),
    ).toThrow(/horizonMs must be greater than zero/);
    expect(() =>
      buildFixedHorizonOutcomeLabel(seed, observation, { ...policy, flatThresholdR: -1 }),
    ).toThrow(/flatThresholdR must be non-negative/);
  });
});
