export interface ScanDependenceEvidence {
  readonly missionId: string;
  readonly canonical: string;
  readonly knownAt: number;
}

export interface ScanDependencePolicy {
  /**
   * Consecutive scans for the same canonical instrument at or inside this gap are
   * treated as one market episode. This value must be pre-registered before evidence.
   */
  readonly episodeGapMs: number;
  /** Minimum conservative evidence units required before paired analysis is ready. */
  readonly minimumIndependentEpisodes: number;
}

export interface MarketEpisode {
  readonly episodeId: string;
  readonly canonical: string;
  readonly firstKnownAt: number;
  readonly lastKnownAt: number;
  readonly missionIds: readonly string[];
}

export interface ScanDependenceReport {
  readonly status: 'ready' | 'insufficient-data';
  readonly reasons: readonly string[];
  readonly rawScanCount: number;
  /**
   * Conservative evidence units. This is intentionally not presented as an estimated
   * statistical Neff: one contiguous same-instrument episode contributes at most one unit.
   */
  readonly effectiveEvidenceUnits: number;
  readonly episodeCount: number;
  readonly maxScansPerEpisode: number;
  readonly largestEpisodeShare: number;
  readonly episodes: readonly MarketEpisode[];
}

function requireTimestamp(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative timestamp`);
  }
}

function validatePolicy(policy: ScanDependencePolicy): void {
  if (!Number.isFinite(policy.episodeGapMs) || policy.episodeGapMs < 0) {
    throw new Error('episodeGapMs must be finite and non-negative');
  }
  if (!Number.isInteger(policy.minimumIndependentEpisodes) || policy.minimumIndependentEpisodes < 1) {
    throw new Error('minimumIndependentEpisodes must be a positive integer');
  }
}

/**
 * Collapse temporally adjacent scans into deterministic same-instrument market episodes.
 *
 * This is a conservative dependence guard for ADR-0021. It does not infer correlation
 * from outcomes and does not claim that different episodes are mathematically independent.
 * Instead it prevents repeated scans inside one continuing market move from satisfying
 * readiness gates as if every scan were a fresh independent observation.
 */
export function buildScanDependenceReport(
  evidence: readonly ScanDependenceEvidence[],
  policy: ScanDependencePolicy,
): ScanDependenceReport {
  validatePolicy(policy);
  const missionIds = new Set<string>();
  for (const item of evidence) {
    if (item.missionId.trim().length === 0) throw new Error('dependence missionId is required');
    if (missionIds.has(item.missionId)) {
      throw new Error(`duplicate dependence mission '${item.missionId}'`);
    }
    missionIds.add(item.missionId);
    if (item.canonical.trim().length === 0) {
      throw new Error(`dependence canonical is required for '${item.missionId}'`);
    }
    requireTimestamp('dependence knownAt', item.knownAt);
  }

  const sorted = [...evidence].sort(
    (left, right) =>
      left.canonical.localeCompare(right.canonical) ||
      left.knownAt - right.knownAt ||
      left.missionId.localeCompare(right.missionId),
  );
  const mutableEpisodes: Array<{
    episodeId: string;
    canonical: string;
    firstKnownAt: number;
    lastKnownAt: number;
    missionIds: string[];
  }> = [];
  const latestByCanonical = new Map<string, (typeof mutableEpisodes)[number]>();

  for (const item of sorted) {
    const current = latestByCanonical.get(item.canonical);
    if (current !== undefined && item.knownAt - current.lastKnownAt <= policy.episodeGapMs) {
      current.lastKnownAt = item.knownAt;
      current.missionIds.push(item.missionId);
      continue;
    }

    const episode = {
      episodeId: `${item.canonical}:${item.knownAt}:${item.missionId}`,
      canonical: item.canonical,
      firstKnownAt: item.knownAt,
      lastKnownAt: item.knownAt,
      missionIds: [item.missionId],
    };
    mutableEpisodes.push(episode);
    latestByCanonical.set(item.canonical, episode);
  }

  const episodes: MarketEpisode[] = mutableEpisodes.map((episode) => ({
    ...episode,
    missionIds: [...episode.missionIds],
  }));
  const episodeCount = episodes.length;
  const maxScansPerEpisode = episodes.reduce(
    (largest, episode) => Math.max(largest, episode.missionIds.length),
    0,
  );
  const largestEpisodeShare = evidence.length === 0 ? 0 : maxScansPerEpisode / evidence.length;
  const reasons: string[] = [];
  if (episodeCount < policy.minimumIndependentEpisodes) {
    reasons.push('minimum-independent-market-episodes-not-met');
  }

  return {
    status: reasons.length === 0 ? 'ready' : 'insufficient-data',
    reasons,
    rawScanCount: evidence.length,
    effectiveEvidenceUnits: episodeCount,
    episodeCount,
    maxScansPerEpisode,
    largestEpisodeShare,
    episodes,
  };
}
