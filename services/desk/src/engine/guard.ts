import * as D from '@keel/core';
import { lastLocalTimeAtOrBefore } from '@keel/core';
import type { Logger } from 'pino';
import type { BrokerPort } from '../broker/port.js';
import type { Ledger } from '../ledger/ledger.js';
import type { Projector } from '../ledger/projections.js';
import type { Clock } from '../sim/clock.js';
import type { DeskState } from './state.js';

/**
 * The guard daemon.
 *
 * This is the component that has to work when the phone is off. It runs on the
 * desk, reacts to account updates rather than to requests, and can flatten and
 * lock out with no client connected — which is the entire reason the desk
 * exists as a separate always-on process (ADR-0001).
 *
 * Its three jobs:
 *
 * 1. Roll the trading day at the operator's configured boundary, so daily
 *    counters and the loss limit reset at the right local hour through DST.
 * 2. Watch the drawdown floor and the daily loss limit, and act *before* the
 *    account is gone rather than reporting afterwards.
 * 3. Flatten reliably. A flatten is not one attempt: it retries until the venue
 *    reports flat, because the moment it is needed is the moment the connection
 *    is worst.
 */

export type GuardTrigger = 'daily-loss-limit' | 'drawdown-breach' | 'manual';

export interface FlattenReport {
  readonly requestedAt: number;
  readonly trigger: GuardTrigger;
  readonly positionsTargeted: number;
  readonly positionsClosed: number;
  readonly attempts: number;
  readonly status: 'complete' | 'partial' | 'failed';
  readonly detail: string;
}

export interface GuardDeps {
  readonly ledger: Ledger;
  readonly projector: Projector;
  readonly state: DeskState;
  readonly broker: BrokerPort;
  readonly clock: Clock;
  readonly log: Logger;
  readonly onAlert: (a: {
    kind: 'risk' | 'drawdown' | 'execution';
    severity: 'info' | 'warning' | 'critical';
    title: string;
    body: string;
  }) => void;
  /** How often to evaluate, independent of incoming events. */
  readonly intervalMs?: number;
  /** Attempts before a flatten is reported as failed. */
  readonly maxFlattenAttempts?: number;
}

export class Guard {
  private cancelTimer: (() => void) | undefined;
  private flattening = false;
  /** Warnings already issued this day, so the operator is told once per day, not on every tick. */
  private readonly warned = new Set<string>();

  constructor(private readonly deps: GuardDeps) {}

  start(): void {
    this.cancelTimer = this.deps.clock.setInterval(() => {
      void this.evaluate();
    }, this.deps.intervalMs ?? 5_000);
  }

  stop(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  private currentDayStart(): number {
    const policy = this.deps.state.policy;
    return lastLocalTimeAtOrBefore(
      this.deps.clock.now(),
      policy.dayBoundaryTimeZone,
      policy.dayBoundaryLocalTime,
    );
  }

  /**
   * One evaluation. Safe to call from a timer, from an account event, or by
   * hand — it is idempotent with respect to actions already taken.
   */
  async evaluate(): Promise<void> {
    const { ledger, projector, state, clock, log } = this.deps;
    const account = state.getAccount();
    if (account === undefined) return;

    this.rollDayIfNeeded(account.balance);

    // --- Drawdown ----------------------------------------------------------
    const reading = state.refreshDrawdown(account);
    ledger.append({
      kind: 'drawdown.updated',
      highWater: D.Decimal.toString(reading.state.highWater),
      floor: D.Decimal.toString(reading.state.floor),
      currentDayStart: reading.state.currentDayStart,
      dayHigh: D.Decimal.toString(reading.state.dayHigh),
      breached: reading.state.breached,
      status: reading.status,
      at: clock.now(),
      ...(reading.state.breachedAt !== undefined ? { breachedAt: reading.state.breachedAt } : {}),
    });
    projector.catchUp();

    if (reading.justBreached) {
      const config = state.policy.drawdown;
      ledger.append({
        kind: 'drawdown.breached',
        floor: D.Decimal.toString(reading.state.floor),
        observed: D.Decimal.toString(
          config.basis === 'equity' ? account.equity : account.balance,
        ),
        at: clock.now(),
      });
      projector.catchUp();
      log.error({ floor: D.Decimal.toString(reading.state.floor) }, 'drawdown breached');
      this.deps.onAlert({
        kind: 'drawdown',
        severity: 'critical',
        title: 'Drawdown breached',
        body: reading.explain,
      });
      if (config.breachAction === 'soft') {
        await this.flatten('drawdown-breach', 'drawdown floor breached');
        this.lockout(this.msUntilNextDay(), 'drawdown breached');
      } else {
        // A hard breach ends the account; flattening is the venue's business,
        // not ours. Lock out so nothing else is sent into a dead account.
        this.lockout(this.msUntilNextDay(), 'drawdown breached (hard)');
      }
      return;
    }

    if (reading.status === 'warning' && !this.warned.has('drawdown')) {
      this.warned.add('drawdown');
      this.deps.onAlert({
        kind: 'drawdown',
        severity: 'warning',
        title: 'Drawdown buffer running low',
        body: reading.explain,
      });
    }

    // --- Daily loss --------------------------------------------------------
    const day = state.dayStats();
    const loss = D.Decimal.sub(day.dayOpenBalance, account.equity);
    if (D.Decimal.lte(day.dayOpenBalance, D.Decimal.ZERO)) return;
    const lossPct = D.Decimal.div(loss, day.dayOpenBalance, 6, 'half-even');
    const limit = state.policy.maxDailyLossPct;

    if (D.Decimal.gt(loss, D.Decimal.ZERO) && D.Decimal.gte(lossPct, limit)) {
      if (state.lockout() === undefined) {
        log.error(
          { lossPct: D.Decimal.toString(lossPct), limit: D.Decimal.toString(limit) },
          'daily loss limit reached',
        );
        this.deps.onAlert({
          kind: 'risk',
          severity: 'critical',
          title: 'Daily loss limit reached',
          body:
            `Down ${D.Decimal.toString(loss)} ${account.currency} today, at or past your ` +
            `${D.Decimal.toString(D.Decimal.mul(limit, D.dec(100)))}% limit. ` +
            'Positions have been closed and entries are locked until the next trading day.',
        });
        await this.flatten('daily-loss-limit', 'daily loss limit reached');
        this.lockout(this.msUntilNextDay(), 'daily loss limit reached');
      }
      return;
    }

    const used = D.Decimal.div(lossPct, limit, 4, 'half-even');
    if (
      D.Decimal.gt(loss, D.Decimal.ZERO) &&
      D.Decimal.gte(used, D.dec('0.75')) &&
      !this.warned.has('daily-loss')
    ) {
      this.warned.add('daily-loss');
      this.deps.onAlert({
        kind: 'risk',
        severity: 'warning',
        title: 'Approaching the daily loss limit',
        body:
          `Down ${D.Decimal.toString(loss)} ${account.currency} today — ` +
          `${D.Decimal.toString(D.Decimal.mul(used, D.dec(100)))}% of the daily budget used.`,
      });
    }
  }

  private rollDayIfNeeded(balance: D.Dec): void {
    const dayStart = this.currentDayStart();
    // Compare against durable state, never a field in memory. See
    // DeskState.persistedDayStart for why this distinction is load-bearing.
    if (dayStart <= this.deps.state.persistedDayStart()) return;
    this.warned.clear();
    this.deps.ledger.append({
      kind: 'day.rolled',
      dayStart,
      openBalance: D.Decimal.toString(balance),
    });
    // A new day releases a lockout that was imposed for that day's limits.
    const lock = this.deps.state.lockout();
    if (lock !== undefined && lock.until <= this.deps.clock.now()) {
      this.deps.ledger.append({
        kind: 'guard.released',
        reason: 'new trading day',
        at: this.deps.clock.now(),
      });
    }
    this.deps.projector.catchUp();
    this.deps.log.info({ dayStart }, 'trading day rolled');
  }

  private msUntilNextDay(): number {
    const policy = this.deps.state.policy;
    const now = this.deps.clock.now();
    const start = lastLocalTimeAtOrBefore(now, policy.dayBoundaryTimeZone, policy.dayBoundaryLocalTime);
    const next = start + 86_400_000;
    return Math.max(60_000, next - now);
  }

  lockout(durationMs: number, reason: string): void {
    const until = this.deps.clock.now() + durationMs;
    this.deps.ledger.append({
      kind: 'guard.lockout',
      until,
      reason,
      at: this.deps.clock.now(),
    });
    this.deps.projector.catchUp();
    this.deps.log.warn({ until, reason }, 'trading locked out');
  }

  release(reason: string): void {
    this.deps.ledger.append({ kind: 'guard.released', reason, at: this.deps.clock.now() });
    this.deps.projector.catchUp();
  }

  /**
   * Close ONE position, and confirm it against the venue.
   *
   * Deliberately separate from `flatten`. An earlier version of the HTTP
   * surface routed "close this position" to `flatten`, so closing a single
   * position would have closed the entire book — the operator taps one row and
   * loses everything. Found in audit. The two operations have different blast
   * radii and must not share an implementation.
   */
  async closeOne(positionId: string, reason: string): Promise<FlattenReport> {
    const { ledger, projector, broker, clock, log } = this.deps;
    const requestedAt = clock.now();

    if (!broker.isConnected()) {
      return {
        requestedAt,
        trigger: 'manual',
        positionsTargeted: 1,
        positionsClosed: 0,
        attempts: 0,
        status: 'failed',
        detail: 'broker not connected; nothing was sent',
      };
    }

    ledger.append({
      kind: 'guard.flattenRequested',
      reason: `close single position: ${reason}`,
      positions: [positionId],
      at: requestedAt,
    });
    projector.catchUp();

    const maxAttempts = this.deps.maxFlattenAttempts ?? 4;
    let lastDetail = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let stillOpen: boolean;
      try {
        stillOpen = (await broker.getPositions()).some((p) => p.positionId === positionId);
      } catch (err) {
        lastDetail = err instanceof Error ? err.message : String(err);
        await clock.sleep(backoffMs(attempt));
        continue;
      }
      if (!stillOpen) {
        return {
          requestedAt,
          trigger: 'manual',
          positionsTargeted: 1,
          positionsClosed: 1,
          attempts: attempt,
          status: 'complete',
          detail: 'venue no longer reports this position',
        };
      }

      try {
        const result = await broker.closePosition(positionId, undefined, `close-${positionId}`);
        if (result.outcome === 'ambiguous') {
          // Not counted as done, and not counted as failed. The next pass
          // re-reads from the venue, which settles it.
          log.warn({ positionId }, 'close outcome unknown; re-checking');
        } else if (result.outcome === 'rejected') {
          lastDetail = result.reason;
        }
      } catch (err) {
        lastDetail = err instanceof Error ? err.message : String(err);
      }
      await clock.sleep(backoffMs(attempt));
    }

    let remains = true;
    try {
      remains = (await broker.getPositions()).some((p) => p.positionId === positionId);
    } catch {
      remains = true;
    }
    if (!remains) {
      return {
        requestedAt,
        trigger: 'manual',
        positionsTargeted: 1,
        positionsClosed: 1,
        attempts: maxAttempts,
        status: 'complete',
        detail: 'venue no longer reports this position',
      };
    }
    this.deps.onAlert({
      kind: 'execution',
      severity: 'critical',
      title: 'Position could not be closed',
      body: `${positionId} is still open after ${maxAttempts} attempts. ${lastDetail}. Check the broker terminal now.`,
    });
    return {
      requestedAt,
      trigger: 'manual',
      positionsTargeted: 1,
      positionsClosed: 0,
      attempts: maxAttempts,
      status: 'partial',
      detail: `still open: ${lastDetail || 'no reason given by the venue'}`,
    };
  }

  /**
   * Close everything, and keep trying until the venue says flat.
   *
   * One attempt is not a flatten. The moment this runs is the moment the
   * connection is least reliable, so it retries with backoff and reports
   * honestly if it could not finish — a partially flattened account that the
   * operator believes is flat is worse than one they know is not.
   */
  async flatten(trigger: GuardTrigger, reason: string): Promise<FlattenReport> {
    const { ledger, projector, broker, clock, log } = this.deps;
    const requestedAt = clock.now();

    if (this.flattening) {
      return {
        requestedAt,
        trigger,
        positionsTargeted: 0,
        positionsClosed: 0,
        attempts: 0,
        status: 'partial',
        detail: 'a flatten is already in progress',
      };
    }
    this.flattening = true;

    const maxAttempts = this.deps.maxFlattenAttempts ?? 6;
    let attempts = 0;
    let closed = 0;
    let targeted = 0;
    let lastDetail = '';

    try {
      for (attempts = 1; attempts <= maxAttempts; attempts++) {
        if (!broker.isConnected()) {
          lastDetail = 'broker not connected';
          await clock.sleep(backoffMs(attempts));
          continue;
        }

        let positions: Awaited<ReturnType<BrokerPort['getPositions']>>;
        try {
          positions = await broker.getPositions();
        } catch (err) {
          lastDetail = `could not read positions: ${err instanceof Error ? err.message : String(err)}`;
          await clock.sleep(backoffMs(attempts));
          continue;
        }

        if (attempts === 1) {
          targeted = positions.length;
          ledger.append({
            kind: 'guard.flattenRequested',
            reason,
            positions: positions.map((p) => p.positionId),
            at: clock.now(),
          });
          projector.catchUp();
        }

        if (positions.length === 0) {
          lastDetail = 'venue reports flat';
          break;
        }

        for (const p of positions) {
          try {
            const result = await broker.closePosition(
              p.positionId,
              undefined,
              `flat-${p.positionId}`,
            );
            if (result.outcome === 'acked') closed += 1;
            else if (result.outcome === 'ambiguous') {
              // Do not count it, and do not assume it failed. The next pass
              // re-reads positions from the venue, which settles the question.
              log.warn({ positionId: p.positionId }, 'close outcome unknown; will re-check');
            }
          } catch (err) {
            log.warn(
              { positionId: p.positionId, err: err instanceof Error ? err.message : String(err) },
              'close threw; will re-check',
            );
          }
        }
        await clock.sleep(backoffMs(attempts));
      }

      // The venue is the authority on whether we are flat, not our count.
      let remaining = -1;
      try {
        remaining = broker.isConnected() ? (await broker.getPositions()).length : -1;
      } catch {
        remaining = -1;
      }

      const status: FlattenReport['status'] =
        remaining === 0 ? 'complete' : remaining < 0 ? 'failed' : 'partial';

      if (status !== 'complete') {
        this.deps.onAlert({
          kind: 'execution',
          severity: 'critical',
          title: status === 'failed' ? 'Flatten could not be confirmed' : 'Flatten incomplete',
          body:
            status === 'failed'
              ? `Could not reach the broker to confirm. ${lastDetail}. Check the broker terminal now.`
              : `${remaining} position(s) still open after ${attempts} attempts. Check the broker terminal now.`,
        });
      }

      return {
        requestedAt,
        trigger,
        positionsTargeted: targeted,
        positionsClosed: closed,
        attempts,
        status,
        detail:
          status === 'complete'
            ? 'venue reports flat'
            : status === 'failed'
              ? `could not confirm: ${lastDetail}`
              : `${remaining} position(s) remain`,
      };
    } finally {
      this.flattening = false;
    }
  }
}

/** Exponential backoff with a ceiling. */
function backoffMs(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** (attempt - 1));
}
