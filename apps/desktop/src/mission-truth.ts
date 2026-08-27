export type DesktopMissionStage =
  | 'OBSERVED'
  | 'CANDIDATE'
  | 'PLANNED'
  | 'ARMED'
  | 'EXECUTING'
  | 'MANAGING'
  | 'CLOSED'
  | 'ABANDONED'
  | 'REVIEWED';

export interface DesktopMissionView {
  readonly missionId: string;
  readonly canonical: string;
  readonly stage: DesktopMissionStage;
  readonly lastEventAt: number;
}

export interface MissionTruthGate {
  canSubmit(missionId: string, canonical: string):
    | { readonly ok: true; readonly mission: DesktopMissionView }
    | { readonly ok: false; readonly reason: string };
}

export type MissionTruthState = 'empty' | 'current' | 'incomplete' | 'disconnected';

const submitStages = new Set<DesktopMissionStage>(['PLANNED', 'ARMED']);
const stages = new Set<DesktopMissionStage>([
  'OBSERVED',
  'CANDIDATE',
  'PLANNED',
  'ARMED',
  'EXECUTING',
  'MANAGING',
  'CLOSED',
  'ABANDONED',
  'REVIEWED',
]);

function parseMission(value: unknown): DesktopMissionView | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.missionId !== 'string' || raw.missionId.trim().length === 0) return undefined;
  if (typeof raw.canonical !== 'string' || raw.canonical.trim().length === 0) return undefined;
  if (typeof raw.stage !== 'string' || !stages.has(raw.stage as DesktopMissionStage)) return undefined;
  if (typeof raw.lastEventAt !== 'number' || !Number.isFinite(raw.lastEventAt)) return undefined;
  return {
    missionId: raw.missionId,
    canonical: raw.canonical,
    stage: raw.stage as DesktopMissionStage,
    lastEventAt: raw.lastEventAt,
  };
}

function parseMissionArray(payload: unknown): readonly DesktopMissionView[] | undefined {
  if (!Array.isArray(payload)) return undefined;
  const parsed: DesktopMissionView[] = [];
  for (const item of payload) {
    const mission = parseMission(item);
    if (mission === undefined) return undefined;
    parsed.push(mission);
  }
  return parsed;
}

/**
 * Desktop projection of server Mission truth.
 *
 * This class deliberately owns no trading truth. It only keeps the last
 * server-provided Mission projection plus the sequence proof that the view is
 * complete. Disconnects and gaps retain the last-known rows for display, but
 * mark them unusable for consequential actions until a fresh snapshot arrives.
 */
export class DesktopMissionTruth implements MissionTruthGate {
  private readonly missions = new Map<string, DesktopMissionView>();
  private seq: number | undefined;
  private state: MissionTruthState = 'empty';

  get status(): MissionTruthState {
    return this.state;
  }

  get sequence(): number | undefined {
    return this.seq;
  }

  list(): readonly DesktopMissionView[] {
    return [...this.missions.values()].sort((a, b) => b.lastEventAt - a.lastEventAt);
  }

  replaceSnapshot(seq: number, payload: unknown): boolean {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      this.markIncomplete();
      return false;
    }
    const parsed = parseMissionArray(payload);
    if (parsed === undefined) {
      this.markIncomplete();
      return false;
    }
    const next = new Map<string, DesktopMissionView>();
    for (const mission of parsed) {
      if (next.has(mission.missionId)) {
        this.markIncomplete();
        return false;
      }
      next.set(mission.missionId, mission);
    }
    this.missions.clear();
    for (const [id, mission] of next) this.missions.set(id, mission);
    this.seq = seq;
    this.state = 'current';
    return true;
  }

  applyDelta(seq: number, upsert: unknown, remove: readonly string[] = []): boolean {
    if (this.state !== 'current' || this.seq === undefined || seq !== this.seq + 1) {
      this.markIncomplete();
      return false;
    }
    const parsed = parseMissionArray(upsert);
    if (parsed === undefined || remove.some((id) => typeof id !== 'string' || id.length === 0)) {
      this.markIncomplete();
      return false;
    }
    for (const mission of parsed) this.missions.set(mission.missionId, mission);
    for (const id of remove) this.missions.delete(id);
    this.seq = seq;
    return true;
  }

  markDisconnected(): void {
    if (this.state !== 'empty') this.state = 'disconnected';
  }

  markIncomplete(): void {
    this.state = 'incomplete';
    this.seq = undefined;
  }

  canSubmit(missionId: string, canonical: string):
    | { readonly ok: true; readonly mission: DesktopMissionView }
    | { readonly ok: false; readonly reason: string } {
    if (this.state !== 'current') {
      return {
        ok: false,
        reason: 'Mission state is not proven current. Reconnect and resync before submitting.',
      };
    }
    const mission = this.missions.get(missionId);
    if (mission === undefined) {
      return { ok: false, reason: 'Mission is not present in the current server snapshot.' };
    }
    if (mission.canonical !== canonical) {
      return { ok: false, reason: 'Mission instrument does not match the requested order.' };
    }
    if (!submitStages.has(mission.stage)) {
      return {
        ok: false,
        reason: `Mission stage ${mission.stage} does not permit a new order.`,
      };
    }
    return { ok: true, mission };
  }
}
