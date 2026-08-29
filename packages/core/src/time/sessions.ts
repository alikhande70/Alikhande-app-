import { fromWallClock, toWallClock } from './zone.js';

/**
 * Trading sessions and the calendar features that actually move price.
 *
 * Sessions are defined in their own local time so DST is handled by the zone
 * database rather than by remembering that London and New York shift on
 * different weekends — a three-week window each spring in which every
 * hardcoded UTC session table is wrong.
 */

export type SessionId = 'sydney' | 'tokyo' | 'london' | 'newyork';

export interface SessionDef {
  readonly id: SessionId;
  readonly label: string;
  readonly timeZone: string;
  /** Local open, `HH:MM`. */
  readonly open: string;
  /** Local close, `HH:MM`. May be before `open` only for overnight sessions. */
  readonly close: string;
}

export const SESSIONS: readonly SessionDef[] = [
  { id: 'sydney', label: 'Sydney', timeZone: 'Australia/Sydney', open: '08:00', close: '17:00' },
  { id: 'tokyo', label: 'Tokyo', timeZone: 'Asia/Tokyo', open: '09:00', close: '18:00' },
  { id: 'london', label: 'London', timeZone: 'Europe/London', open: '08:00', close: '16:30' },
  { id: 'newyork', label: 'New York', timeZone: 'America/New_York', open: '08:00', close: '17:00' },
];

export interface SessionWindow {
  readonly id: SessionId;
  readonly label: string;
  readonly startUtc: number;
  readonly endUtc: number;
}

function windowFor(def: SessionDef, at: number, dayOffset = 0): SessionWindow {
  const w = toWallClock(at + dayOffset * 86_400_000, def.timeZone);
  const [oh, om] = def.open.split(':').map(Number) as [number, number];
  const [ch, cm] = def.close.split(':').map(Number) as [number, number];
  const startUtc = fromWallClock(def.timeZone, w.year, w.month, w.day, oh, om);
  let endUtc = fromWallClock(def.timeZone, w.year, w.month, w.day, ch, cm);
  if (endUtc <= startUtc) endUtc += 86_400_000; // overnight session
  return { id: def.id, label: def.label, startUtc, endUtc };
}

/** Whether the venue is open at all: FX trades Sunday 17:00 ET to Friday 17:00 ET. */
export function isForexOpen(at: number): boolean {
  const ny = toWallClock(at, 'America/New_York');
  if (ny.weekday === 6) return false; // Saturday
  if (ny.weekday === 0) return ny.hour >= 17; // Sunday, after the open
  if (ny.weekday === 5) return ny.hour < 17; // Friday, before the close
  return true;
}

/**
 * Sessions active at `at`, considering yesterday's windows for overnight spans.
 *
 * Gated on the venue actually being open: a Saturday afternoon sits inside
 * London's 08:00-16:30 clock window, but no FX session is running. Pass
 * `marketOpen: true` explicitly for a 24/7 venue such as crypto.
 */
export function activeSessions(at: number, marketOpen = isForexOpen(at)): readonly SessionWindow[] {
  if (!marketOpen) return [];
  const out: SessionWindow[] = [];
  for (const def of SESSIONS) {
    for (const offset of [-1, 0]) {
      const w = windowFor(def, at, offset);
      if (at >= w.startUtc && at < w.endUtc) {
        out.push(w);
        break;
      }
    }
  }
  return out;
}

/** The next window for a session that is not currently active. */
export function nextSessionWindow(id: SessionId, at: number): SessionWindow {
  const def = SESSIONS.find((s) => s.id === id);
  if (def === undefined) throw new Error(`unknown session ${id}`);
  for (const offset of [0, 1, 2]) {
    const w = windowFor(def, at, offset);
    if (w.startUtc > at) return w;
  }
  return windowFor(def, at, 3);
}

/**
 * The London/New York overlap, when the majority of daily FX and gold range is
 * produced. Computed rather than hardcoded, because it is 4 hours for most of
 * the year and 3 hours during the spring DST mismatch.
 */
export function londonNewYorkOverlap(at: number): { startUtc: number; endUtc: number } | undefined {
  const active = activeSessions(at, true);
  const ldn = active.find((s) => s.id === 'london') ?? windowFor(SESSIONS[2] as SessionDef, at);
  const nyc = active.find((s) => s.id === 'newyork') ?? windowFor(SESSIONS[3] as SessionDef, at);
  const start = Math.max(ldn.startUtc, nyc.startUtc);
  const end = Math.min(ldn.endUtc, nyc.endUtc);
  return end > start ? { startUtc: start, endUtc: end } : undefined;
}

/**
 * The daily rollover window, when spreads widen sharply and swap is charged.
 * Anchored to the broker's own server midnight, since that — not UTC midnight —
 * is when a retail MT5 venue rolls.
 */
export function rolloverWindow(
  at: number,
  serverTimeZone: string,
  minutesEitherSide = 5,
): { startUtc: number; endUtc: number; isInside: boolean } {
  const w = toWallClock(at, serverTimeZone);
  const midnight = fromWallClock(serverTimeZone, w.year, w.month, w.day, 0, 0);
  const candidates = [midnight, midnight + 86_400_000];
  let nearest = candidates[0] as number;
  for (const c of candidates) {
    if (Math.abs(c - at) < Math.abs(nearest - at)) nearest = c;
  }
  const pad = minutesEitherSide * 60_000;
  return {
    startUtc: nearest - pad,
    endUtc: nearest + pad,
    isInside: at >= nearest - pad && at <= nearest + pad,
  };
}

/**
 * FX charges three days of swap on Wednesday rollover, to cover the weekend
 * value date. Holding a negative-carry position through it costs 3x.
 */
export function isTripleSwapRollover(at: number, serverTimeZone: string): boolean {
  const roll = rolloverWindow(at, serverTimeZone);
  if (!roll.isInside) return false;
  // The charge applies at the rollover that *starts* Thursday's value date.
  const w = toWallClock(roll.startUtc + 6 * 60_000, serverTimeZone);
  return w.weekday === 4; // Thursday server date
}

export interface SessionContext {
  readonly at: number;
  readonly marketOpen: boolean;
  readonly active: readonly SessionId[];
  readonly inOverlap: boolean;
  readonly inRollover: boolean;
  readonly tripleSwap: boolean;
  /** Minutes until the next session opens, when none is active. */
  readonly minutesToNextOpen?: number;
}

/** One call for everything the risk governor and the journal need about time. */
export function sessionContext(at: number, serverTimeZone: string): SessionContext {
  const marketOpen = isForexOpen(at);
  const active = activeSessions(at, marketOpen);
  const overlap = londonNewYorkOverlap(at);
  const roll = rolloverWindow(at, serverTimeZone);
  const base = {
    at,
    marketOpen,
    active: active.map((s) => s.id),
    inOverlap: marketOpen && overlap !== undefined && at >= overlap.startUtc && at < overlap.endUtc,
    inRollover: roll.isInside,
    tripleSwap: isTripleSwapRollover(at, serverTimeZone),
  };
  if (active.length > 0) return base;
  const next = SESSIONS.map((s) => nextSessionWindow(s.id, at)).reduce((a, b) =>
    a.startUtc <= b.startUtc ? a : b,
  );
  return { ...base, minutesToNextOpen: Math.round((next.startUtc - at) / 60_000) };
}
