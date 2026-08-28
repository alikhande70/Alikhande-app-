import type { MarketEpisode } from './dependence-guard.js';

export interface LongitudinalMaturityPolicy {
  /** Minimum elapsed market-observation time between first and last decisive episode. */
  readonly minimumForwardSpanMs: number;
  /** Fixed bucket width registered before forward evidence is observed. */
  readonly maturityBucketMs: number;
  /** Minimum number of distinct fixed time buckets containing decisive episodes. */
  readonly minimumOccupiedMaturityBuckets: number;
}

export interface LongitudinalMaturityReport {
  readonly status: 'ready' | 'insufficient-data';
  readonly reasons: readonly string[];
  readonly decisiveEpisodeCount: number;
  readonly firstObservedAt: number | null;
  readonly lastObservedAt: number | null;
  readonly forwardSpanMs: number;
  readonly maturityBucketMs: number;
  readonly occupiedMaturityBuckets: readonly number[];
  readonly occupiedMaturityBucketCount: number;
}

function validatePolicy(policy: LongitudinalMaturityPolicy): void {
  if (!Number.isFinite(policy.minimumForwardSpanMs) || policy.minimumForwardSpanMs < 0) {
    throw new Error('minimumForwardSpanMs must be finite and non-negative');
  }
  if (!Number.isFinite(policy.maturityBucketMs) || policy.maturityBucketMs <= 0) {
    throw new Error('maturityBucketMs must be finite and positive');
  }
  if (
    !Number.isInteger(policy.minimumOccupiedMaturityBuckets) ||
    policy.minimumOccupiedMaturityBuckets < 1
  ) {
    throw new Error('minimumOccupiedMaturityBuckets must be a positive integer');
  }
}

/**
 * Conservative longitudinal maturity gate for ADR-0021.
 *
 * Episode separation protects against repeated scans in one market move, but several separated
 * episodes can still occur in one short-lived market condition. This guard therefore requires
 * decisive episodes to span a pre-registered amount of market-observation time and occupy a
 * pre-registered number of fixed time buckets. It uses only `firstObservedAt`/`lastObservedAt`
 * from causal market episodes; ingestion time and future outcomes cannot make evidence look older.
 */
export function assessLongitudinalMaturity(
  episodes: readonly MarketEpisode[],
  policy: LongitudinalMaturityPolicy,
): LongitudinalMaturityReport {
  validatePolicy(policy);

  const ids = new Set<string>();
  for (const episode of episodes) {
    if (episode.episodeId.trim().length === 0) throw new Error('episodeId is required');
    if (ids.has(episode.episodeId)) throw new Error(`duplicate episode '${episode.episodeId}'`);
    ids.add(episode.episodeId);
    if (
      !Number.isFinite(episode.firstObservedAt) ||
      !Number.isFinite(episode.lastObservedAt) ||
      episode.firstObservedAt < 0 ||
      episode.lastObservedAt < episode.firstObservedAt
    ) {
      throw new Error(`invalid observed interval for episode '${episode.episodeId}'`);
    }
  }

  if (episodes.length === 0) {
    return {
      status: 'insufficient-data',
      reasons: ['no-decisive-market-episodes'],
      decisiveEpisodeCount: 0,
      firstObservedAt: null,
      lastObservedAt: null,
      forwardSpanMs: 0,
      maturityBucketMs: policy.maturityBucketMs,
      occupiedMaturityBuckets: [],
      occupiedMaturityBucketCount: 0,
    };
  }

  const firstObservedAt = Math.min(...episodes.map((episode) => episode.firstObservedAt));
  const lastObservedAt = Math.max(...episodes.map((episode) => episode.lastObservedAt));
  const forwardSpanMs = lastObservedAt - firstObservedAt;
  const bucketIds = [
    ...new Set(
      episodes.map((episode) =>
        Math.floor((episode.firstObservedAt - firstObservedAt) / policy.maturityBucketMs),
      ),
    ),
  ].sort((a, b) => a - b);

  const reasons: string[] = [];
  if (forwardSpanMs < policy.minimumForwardSpanMs) {
    reasons.push('minimum-forward-span-not-met');
  }
  if (bucketIds.length < policy.minimumOccupiedMaturityBuckets) {
    reasons.push('minimum-maturity-buckets-not-met');
  }

  return {
    status: reasons.length === 0 ? 'ready' : 'insufficient-data',
    reasons,
    decisiveEpisodeCount: episodes.length,
    firstObservedAt,
    lastObservedAt,
    forwardSpanMs,
    maturityBucketMs: policy.maturityBucketMs,
    occupiedMaturityBuckets: bucketIds,
    occupiedMaturityBucketCount: bucketIds.length,
  };
}
