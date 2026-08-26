/**
 * The MT5 / desk clock boundary.
 *
 * MT5 reports time in the *broker's* wall clock. LiteFinance, like most FX
 * brokers, runs GMT+2/+3. The desk stamps its ledger in real UTC. Everything
 * that compares the two — the ambiguous-send fingerprint window, the history
 * coverage check, the timestamp on a submit result — is only meaningful if both
 * sides are in the same domain.
 *
 * This was a live defect: the agent emitted `TimeTradeServer()*1000` as the
 * value the desk compared against UTC ledger timestamps. It fails in two
 * directions depending on a broker configuration detail nobody controls:
 *
 *   server ahead of UTC  -> history never covers the send window, the
 *                           fingerprint never matches, and no ambiguous send
 *                           can ever be resolved. Every one escalates forever.
 *   server behind UTC    -> coverage passes trivially while the fingerprint
 *                           still cannot match, so the system can conclude
 *                           **false absence** for an order that really exists.
 *
 * The agent now sends UTC. This module exists so that if it ever stops doing
 * so, the failure is immediate and loud instead of a slow corruption of
 * recovery. A renamed field or a reverted line should break a test here, not a
 * position reconciliation six months from now.
 */

export class Mt5ClockDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mt5ClockDomainError';
  }
}

/**
 * The widest believable gap between the agent's UTC stamp and the desk's own
 * clock. Generous enough for a slow host, an NTP correction and network delay;
 * far tighter than the smallest real timezone offset (30 minutes), so a
 * broker-local value can never pass as UTC.
 */
export const MAX_UTC_SKEW_MS = 5 * 60_000;

/** Offsets outside this range are not a timezone; they are a bug. */
export const MAX_SERVER_OFFSET_SEC = 14 * 3600;

export interface Mt5ClockReading {
  /** Agent's UTC epoch milliseconds. */
  readonly utcMillis: number;
  /** Agent's broker-local epoch milliseconds, for session reasoning only. */
  readonly serverMillis?: number;
  /** serverMillis - utcMillis, in seconds, as the agent computed it. */
  readonly serverUtcOffsetSec?: number;
}

export interface Mt5ClockVerdict {
  readonly skewMs: number;
  readonly offsetSec: number | undefined;
  readonly warnings: readonly string[];
}

/**
 * Check an agent time reading against the desk clock.
 *
 * Throws when the reading cannot be UTC. Returns warnings for conditions that
 * are suspicious but survivable, so the health layer can surface them without
 * blocking execution over a slow NTP sync.
 */
export function assertUtcClockDomain(reading: Mt5ClockReading, deskNowMs: number): Mt5ClockVerdict {
  if (!Number.isFinite(reading.utcMillis) || reading.utcMillis <= 0) {
    throw new Mt5ClockDomainError('MT5 agent reported a non-finite or non-positive UTC time');
  }

  const skewMs = reading.utcMillis - deskNowMs;
  if (Math.abs(skewMs) > MAX_UTC_SKEW_MS) {
    throw new Mt5ClockDomainError(
      `MT5 agent time is ${Math.round(skewMs / 1000)}s from the desk clock, beyond the ` +
        `${MAX_UTC_SKEW_MS / 1000}s tolerance. The agent is probably sending broker-local time ` +
        'rather than UTC; comparing it against desk timestamps would silently measure the ' +
        "broker's timezone offset instead of elapsed time.",
    );
  }

  const warnings: string[] = [];
  const offsetSec = reading.serverUtcOffsetSec;

  if (offsetSec !== undefined) {
    if (!Number.isFinite(offsetSec) || Math.abs(offsetSec) > MAX_SERVER_OFFSET_SEC) {
      throw new Mt5ClockDomainError(
        `MT5 agent reported a server/UTC offset of ${offsetSec}s, which is not a real timezone`,
      );
    }
    if (reading.serverMillis !== undefined) {
      // The agent computes the offset itself; verify it against the two stamps
      // rather than trusting a field that could drift from the values it describes.
      const impliedSec = Math.round((reading.serverMillis - reading.utcMillis) / 1000);
      if (Math.abs(impliedSec - offsetSec) > 2) {
        warnings.push(
          `reported server offset ${offsetSec}s disagrees with the ${impliedSec}s implied by the ` +
            'server and UTC stamps',
        );
      }
    }
  }

  return { skewMs, offsetSec, warnings };
}
