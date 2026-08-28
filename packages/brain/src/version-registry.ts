import type { BrainVersion } from './index.js';

export type BrainContentHash = `sha256:${string}`;

export interface BrainVersionRecord {
  readonly version: BrainVersion;
  readonly contentHash: BrainContentHash;
  /** Knowledge-time when this immutable candidate bundle was sealed. */
  readonly createdAt: number;
  readonly role: 'champion' | 'challenger' | 'retired';
  readonly changeSummary: string;
  readonly hypothesisId?: string;
}

export interface BrainVersionRegistry {
  readonly championHash: BrainContentHash;
  readonly records: readonly BrainVersionRecord[];
}

export interface MissionComparisonWindow {
  readonly missionKnowledgeTime: number;
  readonly champion: BrainVersionRecord;
  readonly challengers: readonly BrainVersionRecord[];
}

function validateTimestamp(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative timestamp`);
  }
}

function validateHash(hash: BrainContentHash): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`invalid Brain content hash '${hash}'`);
  }
}

function validateRecord(record: BrainVersionRecord): void {
  validateHash(record.contentHash);
  validateTimestamp('Brain version createdAt', record.createdAt);
  if (record.version.id.trim().length === 0) throw new Error('Brain version id is required');
  if (record.changeSummary.trim().length === 0) throw new Error('change summary is required');
  if (record.hypothesisId !== undefined && record.hypothesisId.trim().length === 0) {
    throw new Error('hypothesis id cannot be blank');
  }
}

/**
 * Validates immutable registry identity and its single explicit champion.
 *
 * This is deliberately pure: it performs no promotion, persistence, wall-clock lookup
 * or execution action. Promotion remains an explicit operator workflow outside the
 * scoring core as required by ADR-0022.
 */
export function validateVersionRegistry(registry: BrainVersionRegistry): void {
  validateHash(registry.championHash);
  if (registry.records.length === 0) throw new Error('Brain registry cannot be empty');

  const hashes = new Set<BrainContentHash>();
  const versionIds = new Set<string>();
  let championCount = 0;

  for (const record of registry.records) {
    validateRecord(record);
    if (hashes.has(record.contentHash)) {
      throw new Error(`duplicate Brain content hash '${record.contentHash}'`);
    }
    hashes.add(record.contentHash);
    if (versionIds.has(record.version.id)) {
      throw new Error(`duplicate Brain version id '${record.version.id}'`);
    }
    versionIds.add(record.version.id);
    if (record.role === 'champion') championCount += 1;
  }

  if (championCount !== 1) throw new Error('Brain registry must contain exactly one champion');
  const champion = registry.records.find((record) => record.contentHash === registry.championHash);
  if (champion === undefined) throw new Error('championHash does not reference a registry record');
  if (champion.role !== 'champion') throw new Error('championHash must reference the champion');
}

/**
 * Selects the versions eligible to score one mission without leaking pre-creation data
 * into challenger evidence.
 *
 * The champion always scores. A challenger only joins the pair when the mission's
 * knowledge-time is strictly later than the challenger's sealed creation timestamp.
 * Equality is excluded so timestamp coalescing cannot accidentally admit information
 * that existed while the challenger was being created.
 */
export function comparisonWindowForMission(
  registry: BrainVersionRegistry,
  missionKnowledgeTime: number,
): MissionComparisonWindow {
  validateVersionRegistry(registry);
  validateTimestamp('mission knowledge time', missionKnowledgeTime);

  const champion = registry.records.find((record) => record.contentHash === registry.championHash);
  if (champion === undefined || champion.role !== 'champion') {
    throw new Error('unreachable invalid champion');
  }

  const challengers = registry.records
    .filter(
      (record) => record.role === 'challenger' && missionKnowledgeTime > record.createdAt,
    )
    .sort((a, b) => a.contentHash.localeCompare(b.contentHash));

  return { missionKnowledgeTime, champion, challengers };
}

/**
 * A promotion-evidence guard independent of score/outcome statistics. ADR-0021 owns
 * those statistics; this function only enforces the temporal eligibility invariant.
 */
export function isForwardPromotionEvidence(
  challenger: BrainVersionRecord,
  missionKnowledgeTime: number,
): boolean {
  validateRecord(challenger);
  validateTimestamp('mission knowledge time', missionKnowledgeTime);
  if (challenger.role !== 'challenger') {
    throw new Error('forward promotion evidence requires a challenger record');
  }
  return missionKnowledgeTime > challenger.createdAt;
}
