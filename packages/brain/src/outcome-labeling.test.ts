import { describe, expect, it } from 'vitest';
import {
  buildFixedHorizonOutcomeLabel,
  type FixedHorizonOutcomePolicy,
  type MarketCloseObservation,
  type OutcomeMissionSeed,
} from './outcome-labeling.js';

const seed: OutcomeMissionSeed = {
  missionId: 'mission-1',
  decisionKnowledgeTime: 1_000,
  direction: 'long',
  referencePrice: 100,
  riskDistance: 2,
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
    const result = buildFixedHorizonOutcomeLabel(
      seed,
      { ...observation, close: 100.1 },
      policy,
    );
    expect(result.directional).toBe('flat');
    expect(result.counterfactualR).toBeCloseTo(0.05);
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
