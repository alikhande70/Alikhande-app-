import { describe, expect, it } from 'vitest';
import { buildScanDependenceReport } from './dependence-guard.js';

describe('scan dependence guard', () => {
  it('collapses repeated same-instrument scans by market observation time', () => {
    const report = buildScanDependenceReport(
      [
        { missionId: 'm1', canonical: 'XAUUSD', observedAt: 1_000, knownAt: 1_001 },
        { missionId: 'm2', canonical: 'XAUUSD', observedAt: 1_040, knownAt: 1_041 },
        { missionId: 'm3', canonical: 'XAUUSD', observedAt: 1_080, knownAt: 1_081 },
        { missionId: 'm4', canonical: 'XAUUSD', observedAt: 1_500, knownAt: 1_501 },
      ],
      { episodeGapMs: 50, minimumIndependentEpisodes: 2 },
    );

    expect(report.status).toBe('ready');
    expect(report.rawScanCount).toBe(4);
    expect(report.episodeCount).toBe(2);
    expect(report.effectiveEvidenceUnits).toBe(2);
    expect(report.maxScansPerEpisode).toBe(3);
    expect(report.largestEpisodeShare).toBe(0.75);
    expect(report.episodes.map((episode) => episode.missionIds)).toEqual([
      ['m1', 'm2', 'm3'],
      ['m4'],
    ]);
  });

  it('does not let delayed ledger ingestion split one underlying market episode', () => {
    const report = buildScanDependenceReport(
      [
        { missionId: 'm1', canonical: 'XAUUSD', observedAt: 1_000, knownAt: 1_001 },
        { missionId: 'm2', canonical: 'XAUUSD', observedAt: 1_010, knownAt: 5_000 },
        { missionId: 'm3', canonical: 'XAUUSD', observedAt: 1_020, knownAt: 9_000 },
      ],
      { episodeGapMs: 15, minimumIndependentEpisodes: 2 },
    );

    expect(report.rawScanCount).toBe(3);
    expect(report.episodeCount).toBe(1);
    expect(report.status).toBe('insufficient-data');
  });

  it('does not merge simultaneous scans from different canonical instruments', () => {
    const report = buildScanDependenceReport(
      [
        { missionId: 'gold', canonical: 'XAUUSD', observedAt: 1_000, knownAt: 1_001 },
        { missionId: 'euro', canonical: 'EURUSD', observedAt: 1_000, knownAt: 1_001 },
      ],
      { episodeGapMs: 60_000, minimumIndependentEpisodes: 2 },
    );

    expect(report.status).toBe('ready');
    expect(report.episodeCount).toBe(2);
  });

  it('fails readiness when a large raw scan population is only one continuing episode', () => {
    const evidence = Array.from({ length: 20 }, (_, index) => ({
      missionId: `m${index}`,
      canonical: 'XAUUSD',
      observedAt: 1_000 + index * 10,
      knownAt: 1_001 + index * 10,
    }));
    const report = buildScanDependenceReport(evidence, {
      episodeGapMs: 15,
      minimumIndependentEpisodes: 4,
    });

    expect(report.rawScanCount).toBe(20);
    expect(report.effectiveEvidenceUnits).toBe(1);
    expect(report.status).toBe('insufficient-data');
    expect(report.reasons).toContain('minimum-independent-market-episodes-not-met');
  });

  it('is deterministic under input reordering and uses the previous same-symbol scan boundary', () => {
    const evidence = [
      { missionId: 'm3', canonical: 'XAUUSD', observedAt: 1_080, knownAt: 1_081 },
      { missionId: 'm1', canonical: 'XAUUSD', observedAt: 1_000, knownAt: 1_001 },
      { missionId: 'm2', canonical: 'XAUUSD', observedAt: 1_040, knownAt: 1_041 },
    ];
    const policy = { episodeGapMs: 50, minimumIndependentEpisodes: 1 };

    expect(buildScanDependenceReport(evidence, policy)).toEqual(
      buildScanDependenceReport([...evidence].reverse(), policy),
    );
    expect(buildScanDependenceReport(evidence, policy).episodeCount).toBe(1);
  });

  it('fails closed on impossible bitemporal ordering, duplicate identities and invalid policy', () => {
    expect(() =>
      buildScanDependenceReport(
        [{ missionId: 'future', canonical: 'XAUUSD', observedAt: 2_000, knownAt: 1_000 }],
        { episodeGapMs: 50, minimumIndependentEpisodes: 1 },
      ),
    ).toThrow(/known before it was observed/);

    expect(() =>
      buildScanDependenceReport(
        [
          { missionId: 'm1', canonical: 'XAUUSD', observedAt: 1_000, knownAt: 1_001 },
          { missionId: 'm1', canonical: 'XAUUSD', observedAt: 2_000, knownAt: 2_001 },
        ],
        { episodeGapMs: 50, minimumIndependentEpisodes: 1 },
      ),
    ).toThrow(/duplicate dependence mission/);

    expect(() =>
      buildScanDependenceReport([], { episodeGapMs: -1, minimumIndependentEpisodes: 1 }),
    ).toThrow(/episodeGapMs/);
    expect(() =>
      buildScanDependenceReport([], { episodeGapMs: 0, minimumIndependentEpisodes: 0 }),
    ).toThrow(/minimumIndependentEpisodes/);
  });
});
