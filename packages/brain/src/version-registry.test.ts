import { describe, expect, it } from 'vitest';
import type { BrainVersion } from './index.js';
import {
  comparisonWindowForMission,
  isForwardPromotionEvidence,
  type BrainVersionRecord,
  type BrainVersionRegistry,
  validateVersionRegistry,
} from './version-registry.js';

const version: BrainVersion = {
  id: 'brain-v1.0.0',
  featureSetVersion: 'features-v1',
  rubricVersion: 'rubric-v1',
  missingFeaturePolicy: 'insufficient-data',
  features: [{ key: 'trendAlignment', weight: 1, polarity: 'positive' }],
};

const champion: BrainVersionRecord = {
  version,
  contentHash: `sha256:${'a'.repeat(64)}`,
  createdAt: 1_700_000_000_000,
  role: 'champion',
  changeSummary: 'Initial sealed champion',
};

const challenger: BrainVersionRecord = {
  version: { ...version, id: 'brain-v1.1.0', rubricVersion: 'rubric-v2' },
  contentHash: `sha256:${'b'.repeat(64)}`,
  createdAt: 1_800_000_000_000,
  role: 'challenger',
  changeSummary: 'Test a pre-specified trend weight hypothesis',
  hypothesisId: 'hypothesis-trend-001',
};

function registry(records: readonly BrainVersionRecord[] = [champion, challenger]): BrainVersionRegistry {
  return { championHash: champion.contentHash, records };
}

describe('Brain champion/challenger registry', () => {
  it('keeps pre-creation missions out of challenger comparison evidence', () => {
    const before = comparisonWindowForMission(registry(), challenger.createdAt - 1);
    const equal = comparisonWindowForMission(registry(), challenger.createdAt);

    expect(before.champion.contentHash).toBe(champion.contentHash);
    expect(before.challengers).toEqual([]);
    expect(equal.challengers).toEqual([]);
    expect(isForwardPromotionEvidence(challenger, challenger.createdAt)).toBe(false);
  });

  it('admits only strictly forward missions to paired challenger scoring', () => {
    const after = comparisonWindowForMission(registry(), challenger.createdAt + 1);

    expect(after.champion.contentHash).toBe(champion.contentHash);
    expect(after.challengers.map((record) => record.contentHash)).toEqual([
      challenger.contentHash,
    ]);
    expect(isForwardPromotionEvidence(challenger, challenger.createdAt + 1)).toBe(true);
  });

  it('never treats retired versions as active challengers', () => {
    const retired: BrainVersionRecord = {
      ...challenger,
      version: { ...challenger.version, id: 'brain-v1.0.5' },
      contentHash: `sha256:${'c'.repeat(64)}`,
      role: 'retired',
    };
    const window = comparisonWindowForMission(
      registry([champion, challenger, retired]),
      challenger.createdAt + 10_000,
    );

    expect(window.challengers.map((record) => record.version.id)).toEqual(['brain-v1.1.0']);
  });

  it('fails closed for ambiguous champion or duplicate immutable identities', () => {
    expect(() =>
      validateVersionRegistry(
        registry([{ ...champion, role: 'challenger' }, challenger]),
      ),
    ).toThrow(/exactly one champion/);

    expect(() =>
      validateVersionRegistry(
        registry([
          champion,
          {
            ...challenger,
            contentHash: champion.contentHash,
          },
        ]),
      ),
    ).toThrow(/duplicate Brain content hash/);
  });

  it('rejects malformed hashes and non-challenger promotion evidence queries', () => {
    expect(() =>
      validateVersionRegistry({
        championHash: champion.contentHash,
        records: [{ ...champion, contentHash: 'sha256:not-a-hash' }],
      }),
    ).toThrow(/invalid Brain content hash/);

    expect(() => isForwardPromotionEvidence(champion, challenger.createdAt + 1)).toThrow(
      /requires a challenger/,
    );
  });

  it('orders concurrent challengers deterministically by immutable content hash', () => {
    const challengerC: BrainVersionRecord = {
      ...challenger,
      version: { ...challenger.version, id: 'brain-v1.2.0' },
      contentHash: `sha256:${'c'.repeat(64)}`,
      createdAt: challenger.createdAt - 1,
    };
    const window = comparisonWindowForMission(
      registry([champion, challengerC, challenger]),
      challenger.createdAt + 10,
    );

    expect(window.challengers.map((record) => record.contentHash)).toEqual([
      challenger.contentHash,
      challengerC.contentHash,
    ]);
  });
});
