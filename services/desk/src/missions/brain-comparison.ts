import { BrainSnapshotInvariantError, withBrainDecisionEvidence } from './brain-snapshot.js';
import type {
  BrainComparisonEvidence,
  BrainContentHash,
  BrainPairedEvaluation,
  DecisionSnapshot,
} from './types.js';

export interface BrainComparisonInput {
  readonly contentHash: BrainContentHash;
  readonly role: 'champion' | 'challenger';
  readonly createdAt: number;
  readonly evaluation: Parameters<typeof withBrainDecisionEvidence>[0]['evaluation'];
  readonly extraction: Parameters<typeof withBrainDecisionEvidence>[0]['extraction'];
  readonly knowledgeCutoff: number;
}

export class BrainComparisonInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrainComparisonInvariantError';
  }
}

function finiteTime(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new BrainComparisonInvariantError(`${field} must be a finite non-negative timestamp`);
  }
}

function validateHash(hash: BrainContentHash): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
    throw new BrainComparisonInvariantError(`invalid Brain content hash '${hash}'`);
  }
}

function withoutBrainEvidence(snapshot: DecisionSnapshot): DecisionSnapshot {
  const { brainComparison: _comparison, brainEvaluation: _evaluation, brainVersion: _version, ...rest } =
    snapshot;
  return rest;
}

/**
 * Seal paired champion/challenger evidence for one Mission.
 *
 * Every version is evaluated against exactly the same knowledge cutoff. Challenger
 * evidence is accepted only when the Mission knowledge-time is strictly later than
 * the challenger's creation timestamp. The champion result alone is copied into the
 * actionable decision fields; challenger outputs remain durable shadow evidence.
 */
export function withBrainComparisonEvidence(input: {
  readonly snapshot: DecisionSnapshot;
  readonly missionKnowledgeTime: number;
  readonly championHash: BrainContentHash;
  readonly versions: readonly BrainComparisonInput[];
}): DecisionSnapshot {
  const { snapshot, missionKnowledgeTime, championHash, versions } = input;
  finiteTime(missionKnowledgeTime, 'missionKnowledgeTime');
  validateHash(championHash);
  if (versions.length === 0) {
    throw new BrainComparisonInvariantError('paired Brain comparison requires at least one version');
  }

  const hashes = new Set<BrainContentHash>();
  const versionIds = new Set<string>();
  let championCount = 0;

  for (const version of versions) {
    validateHash(version.contentHash);
    finiteTime(version.createdAt, 'Brain version createdAt');
    if (hashes.has(version.contentHash)) {
      throw new BrainComparisonInvariantError(`duplicate Brain content hash '${version.contentHash}'`);
    }
    hashes.add(version.contentHash);
    if (versionIds.has(version.evaluation.brainVersion)) {
      throw new BrainComparisonInvariantError(
        `duplicate Brain version id '${version.evaluation.brainVersion}'`,
      );
    }
    versionIds.add(version.evaluation.brainVersion);
    if (version.knowledgeCutoff !== missionKnowledgeTime) {
      throw new BrainComparisonInvariantError(
        'all paired Brain evaluations must use the exact Mission knowledge-time',
      );
    }
    if (version.role === 'champion') championCount += 1;
    if (version.role === 'challenger' && missionKnowledgeTime <= version.createdAt) {
      throw new BrainComparisonInvariantError(
        `challenger '${version.evaluation.brainVersion}' is not forward-only evidence`,
      );
    }
  }

  if (championCount !== 1) {
    throw new BrainComparisonInvariantError('paired Brain comparison requires exactly one champion');
  }
  const champion = versions.find((version) => version.contentHash === championHash);
  if (champion === undefined) {
    throw new BrainComparisonInvariantError('championHash does not reference a paired evaluation');
  }
  if (champion.role !== 'champion') {
    throw new BrainComparisonInvariantError('championHash must reference the champion evaluation');
  }

  const pristine = withoutBrainEvidence(snapshot);
  const sealedByHash = new Map<BrainContentHash, BrainPairedEvaluation>();
  const snapshotByHash = new Map<BrainContentHash, DecisionSnapshot>();

  for (const version of versions) {
    let sealed: DecisionSnapshot;
    try {
      sealed = withBrainDecisionEvidence({
        snapshot: pristine,
        evaluation: version.evaluation,
        extraction: version.extraction,
        knowledgeCutoff: version.knowledgeCutoff,
      });
    } catch (error) {
      if (error instanceof BrainSnapshotInvariantError) {
        throw new BrainComparisonInvariantError(
          `invalid paired evidence for '${version.evaluation.brainVersion}': ${error.message}`,
        );
      }
      throw error;
    }
    if (sealed.brainEvaluation === undefined) {
      throw new BrainComparisonInvariantError('unreachable missing Brain evaluation');
    }
    sealedByHash.set(version.contentHash, {
      contentHash: version.contentHash,
      role: version.role,
      createdAt: version.createdAt,
      evaluation: sealed.brainEvaluation,
    });
    snapshotByHash.set(version.contentHash, sealed);
  }

  const championSnapshot = snapshotByHash.get(championHash);
  const championEvaluation = sealedByHash.get(championHash);
  if (championSnapshot === undefined || championEvaluation === undefined) {
    throw new BrainComparisonInvariantError('unreachable missing champion evidence');
  }

  const challengers = [...sealedByHash.values()]
    .filter((entry) => entry.role === 'challenger')
    .sort((a, b) => a.contentHash.localeCompare(b.contentHash));
  const comparison: BrainComparisonEvidence = {
    comparisonVersion: 1,
    missionKnowledgeTime,
    championHash,
    evaluations: [championEvaluation, ...challengers],
  };

  return {
    ...championSnapshot,
    brainComparison: comparison,
  };
}
