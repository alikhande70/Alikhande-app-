import { createHash } from 'node:crypto';
import { MissionInvariantError, MissionService } from './service.js';
import type { DecisionSnapshot, MissionRecord } from './types.js';

export type ScanDisposition = 'observed' | 'candidate' | 'rejected';

export interface ScanMissionInput {
  /** Stable identity from the scanner for one observation. Replays must reuse it. */
  readonly scanId: string;
  readonly canonical: string;
  readonly timeframe: string;
  readonly trigger: string;
  readonly scanConfigVersion: string;
  /** Valid time: when this market state was actually observed. */
  readonly observedAt: number;
  /** Bounded point-in-time deterministic facts. No AI prose or conclusions. */
  readonly marketState: Readonly<Record<string, unknown>>;
  readonly disposition: ScanDisposition;
  /** Required for rejected scans so "why we did not trade" remains evaluable later. */
  readonly decisionSnapshot?: DecisionSnapshot;
  readonly rejectionReason?: string;
}

function nonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new MissionInvariantError(`${field} must not be empty`);
}

function finiteTime(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new MissionInvariantError(`${field} must be a finite non-negative timestamp`);
  }
}

/**
 * Stable across retries/restarts and scoped by scanner configuration.
 *
 * A scan id alone is not globally unique once scanner populations are revised.
 * Including the configuration version keeps a replay stable while preventing a
 * later scanner generation from accidentally adopting an older mission.
 */
export function missionIdForScan(scanConfigVersion: string, scanId: string): string {
  nonEmpty(scanConfigVersion, 'scan configuration version');
  nonEmpty(scanId, 'scan id');
  const digest = createHash('sha256')
    .update(`${scanConfigVersion}\0${scanId}`)
    .digest('hex')
    .slice(0, 24);
  return `scan-${digest}`;
}

/**
 * Converts every deterministic scanner observation into durable ADR-0018 data.
 *
 * This sits deliberately before the Trading Brain. A scanner observation is
 * origin=`scanner`; the Brain may later consume the immutable snapshot, but it
 * cannot become the author of market truth retroactively.
 */
export class ScanMissionIngestor {
  constructor(private readonly missions: MissionService) {}

  ingest(input: ScanMissionInput): MissionRecord {
    nonEmpty(input.scanId, 'scan id');
    nonEmpty(input.canonical, 'canonical instrument');
    nonEmpty(input.timeframe, 'timeframe');
    nonEmpty(input.trigger, 'trigger');
    nonEmpty(input.scanConfigVersion, 'scan configuration version');
    finiteTime(input.observedAt, 'observedAt');

    if (input.disposition === 'rejected') {
      if (input.decisionSnapshot === undefined) {
        throw new MissionInvariantError('rejected scan requires a decision snapshot');
      }
      nonEmpty(input.rejectionReason ?? '', 'rejection reason');
    } else if (input.decisionSnapshot !== undefined) {
      throw new MissionInvariantError(
        'decision snapshot is only accepted here for a rejected scan; candidate planning seals it later',
      );
    }

    const missionId = missionIdForScan(input.scanConfigVersion, input.scanId);
    const existing = this.missions.load(missionId);
    if (existing !== undefined) {
      this.assertReplayMatches(existing, input);
      return existing;
    }

    this.missions.observe({
      missionId,
      origin: 'scanner',
      canonical: input.canonical,
      timeframe: input.timeframe,
      trigger: input.trigger,
      observedAt: input.observedAt,
      scanConfigVersion: input.scanConfigVersion,
      marketState: input.marketState,
    });
    this.missions.recordAction(missionId, {
      actionId: `${missionId}:scan`,
      origin: 'scanner',
      type: 'scan',
      at: input.observedAt,
      detail: {
        scanId: input.scanId,
        disposition: input.disposition,
        scanConfigVersion: input.scanConfigVersion,
      },
    });

    if (input.disposition === 'candidate') {
      return this.missions.markCandidate(missionId, 'scanner', input.observedAt);
    }
    if (input.disposition === 'rejected') {
      return this.missions.abandon(
        missionId,
        'scanner',
        input.observedAt,
        input.rejectionReason as string,
        input.decisionSnapshot,
      );
    }
    return this.missions.load(missionId) as MissionRecord;
  }

  private assertReplayMatches(existing: MissionRecord, input: ScanMissionInput): void {
    const expectedStage =
      input.disposition === 'candidate'
        ? 'CANDIDATE'
        : input.disposition === 'rejected'
          ? 'ABANDONED'
          : 'OBSERVED';
    const scanAction = existing.actions.find((action) => action.type === 'scan');
    const same =
      existing.origin === 'scanner' &&
      existing.canonical === input.canonical &&
      existing.timeframe === input.timeframe &&
      existing.trigger === input.trigger &&
      existing.observedAt === input.observedAt &&
      existing.scanConfigVersion === input.scanConfigVersion &&
      existing.stage === expectedStage &&
      scanAction?.detail?.scanId === input.scanId &&
      scanAction.detail.disposition === input.disposition;
    if (!same) {
      throw new MissionInvariantError(
        `scan replay conflicts with durable mission '${existing.missionId}'`,
      );
    }
  }
}
