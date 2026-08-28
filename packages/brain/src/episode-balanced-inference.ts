import type { MarketEpisode } from './dependence-guard.js';
import type {
  PairedDirectionalAlignmentEvidence,
  WilsonInterval95,
} from './paired-inference.js';

export interface EpisodeBalancedInferencePolicy {
  /** Minimum non-tied market episodes required for interval-based direction. */
  readonly minimumDecisiveEpisodes: number;
}

export interface EpisodeDirectionalVote {
  readonly episodeId: string;
  readonly canonical: string;
  readonly challengerAlignedScans: number;
  readonly championAlignedScans: number;
  readonly vote: 'challenger' | 'champion' | 'tie';
}

export interface EpisodeBalancedInferenceReport {
  readonly status: 'ready' | 'insufficient-data';
  readonly reasons: readonly string[];
  readonly decisiveMissionCount: number;
  readonly directionalEpisodeCount: number;
  readonly tiedEpisodeCount: number;
  readonly decisiveEpisodeCount: number;
  readonly challengerAlignedEpisodes: number;
  readonly championAlignedEpisodes: number;
  readonly challengerEpisodeShare: number | null;
  readonly challengerEpisodeWilson95: WilsonInterval95 | null;
  readonly episodeVotes: readonly EpisodeDirectionalVote[];
  /** Dependence-adjusted statistical direction only; never a promotion instruction. */
  readonly inference:
    | 'challenger-favouring'
    | 'champion-favouring'
    | 'inconclusive'
    | 'insufficient-data';
}

function validatePolicy(policy: EpisodeBalancedInferencePolicy): void {
  if (!Number.isInteger(policy.minimumDecisiveEpisodes) || policy.minimumDecisiveEpisodes < 1) {
    throw new Error('minimumDecisiveEpisodes must be a positive integer');
  }
}

function wilson95(successes: number, trials: number): WilsonInterval95 {
  if (trials < 1 || successes < 0 || successes > trials) {
    throw new Error('invalid Wilson interval inputs');
  }
  const z = 1.96;
  const z2 = z * z;
  const p = successes / trials;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const half =
    (z / denominator) * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return {
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
  };
}

/**
 * Equal-weight market-episode analysis for ADR-0021.
 *
 * Every pre-registered episode contributes at most one directional vote regardless of how many
 * scans occurred inside it. This deliberately avoids pretending that repeated scans in one move
 * are independent Bernoulli trials. A tied episode contributes diagnostics but not interval
 * evidence. The function is deterministic and consumes only immutable per-Mission alignment plus
 * the pre-registered episode partition; it does not infer or mutate trading truth.
 */
export function inferEpisodeBalancedAlignment(
  evidence: readonly PairedDirectionalAlignmentEvidence[],
  episodes: readonly MarketEpisode[],
  policy: EpisodeBalancedInferencePolicy,
): EpisodeBalancedInferenceReport {
  validatePolicy(policy);

  const missionToEpisode = new Map<string, MarketEpisode>();
  const episodeIds = new Set<string>();
  for (const episode of episodes) {
    if (episode.episodeId.trim().length === 0) throw new Error('episodeId is required');
    if (episodeIds.has(episode.episodeId)) throw new Error(`duplicate episode '${episode.episodeId}'`);
    episodeIds.add(episode.episodeId);
    for (const missionId of episode.missionIds) {
      if (missionToEpisode.has(missionId)) {
        throw new Error(`mission '${missionId}' appears in multiple market episodes`);
      }
      missionToEpisode.set(missionId, episode);
    }
  }

  const evidenceByEpisode = new Map<string, PairedDirectionalAlignmentEvidence[]>();
  const evidenceMissionIds = new Set<string>();
  for (const item of evidence) {
    if (item.missionId.trim().length === 0) throw new Error('directional missionId is required');
    if (evidenceMissionIds.has(item.missionId)) {
      throw new Error(`duplicate directional mission '${item.missionId}'`);
    }
    evidenceMissionIds.add(item.missionId);
    const episode = missionToEpisode.get(item.missionId);
    if (episode === undefined) {
      throw new Error(`directional mission '${item.missionId}' is absent from market episodes`);
    }
    const bucket = evidenceByEpisode.get(episode.episodeId) ?? [];
    bucket.push(item);
    evidenceByEpisode.set(episode.episodeId, bucket);
  }

  const episodeVotes: EpisodeDirectionalVote[] = [];
  let challengerAlignedEpisodes = 0;
  let championAlignedEpisodes = 0;
  let tiedEpisodeCount = 0;

  for (const episode of episodes) {
    const bucket = evidenceByEpisode.get(episode.episodeId);
    if (bucket === undefined || bucket.length === 0) continue;
    const challengerAlignedScans = bucket.filter((item) => item.aligned === 'challenger').length;
    const championAlignedScans = bucket.length - challengerAlignedScans;
    let vote: EpisodeDirectionalVote['vote'] = 'tie';
    if (challengerAlignedScans > championAlignedScans) {
      vote = 'challenger';
      challengerAlignedEpisodes += 1;
    } else if (championAlignedScans > challengerAlignedScans) {
      vote = 'champion';
      championAlignedEpisodes += 1;
    } else {
      tiedEpisodeCount += 1;
    }
    episodeVotes.push({
      episodeId: episode.episodeId,
      canonical: episode.canonical,
      challengerAlignedScans,
      championAlignedScans,
      vote,
    });
  }

  const directionalEpisodeCount = episodeVotes.length;
  const decisiveEpisodeCount = challengerAlignedEpisodes + championAlignedEpisodes;
  const reasons: string[] = [];
  if (decisiveEpisodeCount < policy.minimumDecisiveEpisodes) {
    reasons.push('minimum-decisive-market-episodes-not-met');
  }

  const interval =
    decisiveEpisodeCount === 0 ? null : wilson95(challengerAlignedEpisodes, decisiveEpisodeCount);
  const challengerEpisodeShare =
    decisiveEpisodeCount === 0 ? null : challengerAlignedEpisodes / decisiveEpisodeCount;

  let inference: EpisodeBalancedInferenceReport['inference'] = 'insufficient-data';
  if (reasons.length === 0 && interval !== null) {
    if (interval.lower > 0.5) inference = 'challenger-favouring';
    else if (interval.upper < 0.5) inference = 'champion-favouring';
    else inference = 'inconclusive';
  }

  return {
    status: reasons.length === 0 ? 'ready' : 'insufficient-data',
    reasons,
    decisiveMissionCount: evidence.length,
    directionalEpisodeCount,
    tiedEpisodeCount,
    decisiveEpisodeCount,
    challengerAlignedEpisodes,
    championAlignedEpisodes,
    challengerEpisodeShare,
    challengerEpisodeWilson95: interval,
    episodeVotes,
    inference,
  };
}
