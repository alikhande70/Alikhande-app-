/**
 * Time-zone arithmetic without a dependency.
 *
 * Trading time is never UTC time. Sessions are defined in local wall-clock
 * terms ("London opens at 08:00"), prop-firm days reset at a local hour, and MT5
 * brokers stamp everything in a server time zone that shifts with DST. Getting
 * this wrong moves a daily-loss reset by an hour twice a year, which is exactly
 * when it matters.
 *
 * `Intl.DateTimeFormat` carries the IANA database in the runtime, so it is the
 * source of truth rather than a hand-maintained offset table.
 */

export interface WallClock {
  readonly year: number;
  /** 1-12. */
  readonly month: number;
  /** 1-31. */
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0 = Sunday. */
  readonly weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) return cached;
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  formatterCache.set(timeZone, f);
  return f;
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export class ZoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZoneError';
  }
}

/** Validate an IANA zone name eagerly, so config errors surface at load. */
export function assertValidTimeZone(timeZone: string): void {
  try {
    formatter(timeZone).format(0);
  } catch {
    throw new ZoneError(`unknown IANA time zone: ${timeZone}`);
  }
}

/** The local wall-clock reading in `timeZone` at the given instant. */
export function toWallClock(utcMs: number, timeZone: string): WallClock {
  const parts = formatter(timeZone).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const p = parts.find((x) => x.type === type);
    if (p === undefined) throw new ZoneError(`missing ${type} for zone ${timeZone}`);
    return p.value;
  };
  const weekdayName = get('weekday');
  const weekday = WEEKDAYS[weekdayName];
  if (weekday === undefined) throw new ZoneError(`unrecognised weekday ${weekdayName}`);
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday,
  };
}

/** Offset of `timeZone` from UTC at a given instant, in milliseconds. */
export function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const w = toWallClock(utcMs, timeZone);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // Instants are whole seconds here; keep the caller's sub-second component.
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The UTC instant of a local wall-clock time.
 *
 * DST makes this ambiguous twice a year. The policy is explicit rather than
 * accidental:
 * - **Spring forward** (the local time does not exist): return the instant the
 *   clock jumps to, so an 02:30 reset that is skipped still fires at 03:00.
 * - **Autumn back** (the local time happens twice): return the *first*
 *   occurrence, so a daily reset happens once, at the earlier instant.
 */
export function fromWallClock(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  // First approximation: treat the wall clock as if it were UTC, then correct
  // by the offset observed there. One more pass settles DST boundaries.
  let guess = target - zoneOffsetMs(target, timeZone);
  for (let i = 0; i < 3; i++) {
    const offset = zoneOffsetMs(guess, timeZone);
    const next = target - offset;
    if (next === guess) break;
    guess = next;
  }

  const check = toWallClock(guess, timeZone);
  const matches =
    check.year === year &&
    check.month === month &&
    check.day === day &&
    check.hour === hour &&
    check.minute === minute;

  if (!matches) {
    // The requested local time does not exist (spring-forward gap). Walk forward
    // to the first instant at or after it that does.
    const gapProbe = target - zoneOffsetMs(target - 3_600_000, timeZone);
    return Math.max(guess, gapProbe);
  }

  // Autumn-back: the same wall clock maps to two instants. Prefer the earlier.
  const earlier = guess - 3_600_000;
  const earlierWall = toWallClock(earlier, timeZone);
  if (
    earlierWall.year === year &&
    earlierWall.month === month &&
    earlierWall.day === day &&
    earlierWall.hour === hour &&
    earlierWall.minute === minute
  ) {
    return earlier;
  }
  return guess;
}

/** Parse `HH:MM`, rejecting anything else. Config errors must not be silent. */
export function parseHourMinute(hhmm: string): { hour: number; minute: number } {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (m === null) throw new ZoneError(`expected HH:MM, got ${JSON.stringify(hhmm)}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new ZoneError(`out-of-range time ${hhmm}`);
  return { hour, minute };
}

/**
 * The most recent occurrence of a local `HH:MM` at or before `at`.
 * Used for daily-loss and drawdown reset boundaries.
 */
export function lastLocalTimeAtOrBefore(at: number, timeZone: string, hhmm: string): number {
  const { hour, minute } = parseHourMinute(hhmm);
  const w = toWallClock(at, timeZone);
  const todays = fromWallClock(timeZone, w.year, w.month, w.day, hour, minute);
  if (todays <= at) return todays;
  const yesterday = new Date(Date.UTC(w.year, w.month - 1, w.day) - 86_400_000);
  return fromWallClock(
    timeZone,
    yesterday.getUTCFullYear(),
    yesterday.getUTCMonth() + 1,
    yesterday.getUTCDate(),
    hour,
    minute,
  );
}

/** The next occurrence of a local `HH:MM` strictly after `at`. */
export function nextLocalTimeAfter(at: number, timeZone: string, hhmm: string): number {
  const { hour, minute } = parseHourMinute(hhmm);
  const w = toWallClock(at, timeZone);
  const todays = fromWallClock(timeZone, w.year, w.month, w.day, hour, minute);
  if (todays > at) return todays;
  const tomorrow = new Date(Date.UTC(w.year, w.month - 1, w.day) + 86_400_000);
  return fromWallClock(
    timeZone,
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    hour,
    minute,
  );
}
