import { describe, expect, it } from 'vitest';
import { inferEpisodeBalancedAlignment } from './episode-balanced-inference.js';

function episode(id: string, missionIds: readonly string[]) {
  return {
    episodeId: id,
    canonical: 'XAUUSD',
    firstObservedAt: 1,
    lastObservedAt: 2,
    missionIds,
  };
}

describe('episode-balanced inference', () => {
  it('gives one market episode one vote even when it contains many decisive scans', () => {
    const evidence = [
      ...Array.from({ length: 20 }, (_, index) => ({
        missionId: `burst-${index}`,
        aligned: 'challenger' as const,
      })),
      { missionId: 'later-1', aligned: 'champion' as const },
      { missionId: 'later-2', aligned: 'champion' as const },
    ];
    const result = inferEpisodeBalancedAlignment(
      evidence,
      [
        episode(
          'burst',
          evidence.slice(0, 20).map((item) => item.missionId),
        ),
        episode('later-1', ['later-1']),
        episode('later-2', ['later-2']),
      ],
      { minimumDecisiveEpisodes: 3 },
    );

    expect(result.decisiveMissionCount).toBe(22);
    expect(result.decisiveEpisodeCount).toBe(3);
    expect(result.challengerAlignedEpisodes).toBe(1);
    expect(result.championAlignedEpisodes).toBe(2);
    expect(result.challengerEpisodeShare).toBeCloseTo(1 / 3);
    expect(result.inference).toBe('inconclusive');
  });

  it('does not let a within-episode tie create directional evidence', () => {
    const result = inferEpisodeBalancedAlignment(
      [
        { missionId: 'm1', aligned: 'challenger' },
        { missionId: 'm2', aligned: 'champion' },
        { missionId: 'm3', aligned: 'challenger' },
      ],
      [episode('e1', ['m1', 'm2']), episode('e2', ['m3'])],
      { minimumDecisiveEpisodes: 2 },
    );

    expect(result.directionalEpisodeCount).toBe(2);
    expect(result.tiedEpisodeCount).toBe(1);
    expect(result.decisiveEpisodeCount).toBe(1);
    expect(result.status).toBe('insufficient-data');
    expect(result.reasons).toContain('minimum-decisive-market-episodes-not-met');
  });

  it('fails closed if decisive evidence is not represented by exactly one episode', () => {
    expect(() =>
      inferEpisodeBalancedAlignment(
        [{ missionId: 'missing', aligned: 'challenger' }],
        [episode('e1', ['other'])],
        { minimumDecisiveEpisodes: 1 },
      ),
    ).toThrow(/absent from market episodes/);

    expect(() =>
      inferEpisodeBalancedAlignment(
        [{ missionId: 'm1', aligned: 'challenger' }],
        [episode('e1', ['m1']), episode('e2', ['m1'])],
        { minimumDecisiveEpisodes: 1 },
      ),
    ).toThrow(/multiple market episodes/);
  });
});
