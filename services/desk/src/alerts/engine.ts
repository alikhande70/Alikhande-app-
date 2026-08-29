import { createHash, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Ledger } from '../ledger/ledger.js';
import type { Projector } from '../ledger/projections.js';
import type { Clock } from '../sim/clock.js';

/**
 * Alerts.
 *
 * The design constraint is not "deliver notifications" — it is "be worth
 * reading". An alerting system that fires on every reconciliation pass, or that
 * re-notifies about a condition the operator already knows about, trains them to
 * swipe it away. The one alert that must never be swiped away is a critical
 * divergence, so everything else has to earn its place.
 *
 * Three mechanisms enforce that:
 *
 * 1. **Deduplication by key.** The same condition is one alert until it clears.
 * 2. **Severity floor for push.** Info never wakes anyone.
 * 3. **Delivery receipts.** An undelivered critical alert is itself a problem,
 *    so dispatch and acknowledgement are recorded and can be queried.
 */

export type AlertKind =
  | 'price'
  | 'risk'
  | 'divergence'
  | 'execution'
  | 'drawdown'
  | 'connection'
  | 'session'
  | 'anomaly';

export type Severity = 'info' | 'warning' | 'critical';

export interface AlertInput {
  readonly kind: AlertKind;
  readonly severity: Severity;
  readonly title: string;
  readonly body: string;
  /** Deep link into the app. */
  readonly route?: string;
  /**
   * Stable identity for the underlying condition. Two raises with the same key
   * inside the dedupe window are one alert. Defaults to a hash of kind+title.
   */
  readonly dedupeKey?: string;
}

export interface Alert extends AlertInput {
  readonly alertId: string;
  readonly createdAt: number;
  readonly acknowledgedAt?: number;
  readonly pushDispatchedAt?: number;
  readonly pushAcknowledgedAt?: number;
}

/** Delivers a push to the operator's device. Implementations may fail; that is data. */
export interface PushSender {
  readonly name: string;
  send(alert: Alert): Promise<{ delivered: boolean; detail: string }>;
}

/** Used when no push transport is configured. Records the intent honestly. */
export class NullPushSender implements PushSender {
  readonly name = 'none';
  async send(): Promise<{ delivered: boolean; detail: string }> {
    return { delivered: false, detail: 'no push transport configured' };
  }
}

export interface AlertEngineOptions {
  readonly ledger: Ledger;
  readonly projector: Projector;
  readonly clock: Clock;
  readonly log: Logger;
  readonly push: PushSender;
  readonly onAlert?: (a: Alert) => void;
  /** Minimum severity that triggers a push. */
  readonly pushFloor?: Severity;
  /** Window in which a repeated key is treated as the same alert. */
  readonly dedupeWindowMs?: number;
  /** Cap on pushes per hour, so a flapping condition cannot spam. */
  readonly maxPushesPerHour?: number;
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { info: 0, warning: 1, critical: 2 };

export class AlertEngine {
  private readonly recent = new Map<string, { alertId: string; at: number }>();
  private readonly pushTimestamps: number[] = [];

  constructor(private readonly opts: AlertEngineOptions) {}

  /**
   * Raise an alert. Returns the existing one if this condition is already open.
   *
   * Deliberately synchronous up to the ledger write: an alert that exists only
   * in memory disappears on restart, and the restart is often caused by the
   * same problem the alert was about.
   */
  raise(input: AlertInput): Alert {
    const key = input.dedupeKey ?? defaultKey(input);
    const window = this.opts.dedupeWindowMs ?? 900_000;
    const now = this.opts.clock.now();

    const seen = this.recent.get(key);
    if (seen !== undefined && now - seen.at < window) {
      const existing = this.get(seen.alertId);
      if (existing !== undefined) return existing;
    }

    const alert: Alert = { ...input, alertId: randomUUID(), createdAt: now };
    this.opts.ledger.append({
      kind: 'alert.raised',
      alertId: alert.alertId,
      alert: {
        kind: alert.kind,
        severity: alert.severity,
        title: alert.title,
        body: alert.body,
        createdAt: alert.createdAt,
        ...(alert.route !== undefined ? { route: alert.route } : {}),
      },
    });
    this.opts.projector.catchUp();
    this.recent.set(key, { alertId: alert.alertId, at: now });

    this.opts.log[alert.severity === 'critical' ? 'error' : 'warn'](
      { kind: alert.kind, title: alert.title },
      'alert raised',
    );
    this.opts.onAlert?.(alert);

    if (this.shouldPush(alert)) void this.dispatchPush(alert);
    return alert;
  }

  private shouldPush(alert: Alert): boolean {
    const floor = this.opts.pushFloor ?? 'warning';
    if (SEVERITY_RANK[alert.severity] < SEVERITY_RANK[floor]) return false;

    // Rate limit, except for critical: a condition that can end the account is
    // worth the interruption even if something is flapping.
    if (alert.severity === 'critical') return true;
    const cutoff = this.opts.clock.now() - 3_600_000;
    while (this.pushTimestamps.length > 0 && (this.pushTimestamps[0] as number) < cutoff) {
      this.pushTimestamps.shift();
    }
    return this.pushTimestamps.length < (this.opts.maxPushesPerHour ?? 20);
  }

  private async dispatchPush(alert: Alert): Promise<void> {
    this.pushTimestamps.push(this.opts.clock.now());
    let result: { delivered: boolean; detail: string };
    try {
      result = await this.opts.push.send(alert);
    } catch (err) {
      result = {
        delivered: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (result.delivered) {
      this.opts.ledger.append({
        kind: 'alert.pushDispatched',
        alertId: alert.alertId,
        at: this.opts.clock.now(),
      });
      this.opts.projector.catchUp();
    } else {
      // A push that did not go out is not an error to swallow. It is recorded
      // so `undeliveredCritical` can find it and the operator can be told the
      // notification path itself is broken.
      this.opts.log.warn(
        { alertId: alert.alertId, transport: this.opts.push.name, detail: result.detail },
        'push not delivered',
      );
    }
  }

  acknowledge(alertId: string): void {
    this.opts.ledger.append({ kind: 'alert.acknowledged', alertId, at: this.opts.clock.now() });
    this.opts.projector.catchUp();
  }

  /** Record that the operator actually saw the push, not just that it was sent. */
  acknowledgePush(alertId: string): void {
    this.opts.ledger.append({ kind: 'alert.pushAcknowledged', alertId, at: this.opts.clock.now() });
    this.opts.projector.catchUp();
  }

  /** Clear a dedupe key so the condition can alert again if it recurs. */
  clear(key: string): void {
    this.recent.delete(key);
  }

  get(alertId: string): Alert | undefined {
    const row = this.opts.ledger.db
      .prepare('SELECT * FROM alerts WHERE alert_id = ?')
      .get(alertId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toAlert(row);
  }

  recentAlerts(limit = 50): readonly Alert[] {
    const rows = this.opts.ledger.db
      .prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(toAlert);
  }

  unacknowledged(): readonly Alert[] {
    const rows = this.opts.ledger.db
      .prepare('SELECT * FROM alerts WHERE acknowledged_at IS NULL ORDER BY created_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(toAlert);
  }

  /**
   * Critical alerts that were never pushed, or were pushed and never seen.
   *
   * Surfaced in the desk's health, because a notification path that has quietly
   * stopped working is indistinguishable from a quiet market — right up until
   * it isn't.
   */
  undeliveredCritical(olderThanMs = 300_000): readonly Alert[] {
    const cutoff = this.opts.clock.now() - olderThanMs;
    const rows = this.opts.ledger.db
      .prepare(
        `SELECT * FROM alerts
         WHERE severity = 'critical'
           AND created_at < ?
           AND (push_dispatched_at IS NULL OR push_acknowledged_at IS NULL)
           AND acknowledged_at IS NULL
         ORDER BY created_at DESC`,
      )
      .all(cutoff) as Array<Record<string, unknown>>;
    return rows.map(toAlert);
  }
}

function defaultKey(input: AlertInput): string {
  return createHash('sha256').update(`${input.kind}:${input.title}`).digest('hex').slice(0, 16);
}

function toAlert(row: Record<string, unknown>): Alert {
  const route = row.route as string | null;
  const ack = row.acknowledged_at as number | null;
  const dispatched = row.push_dispatched_at as number | null;
  const pushAck = row.push_acknowledged_at as number | null;
  return {
    alertId: row.alert_id as string,
    kind: row.kind as AlertKind,
    severity: row.severity as Severity,
    title: row.title as string,
    body: row.body as string,
    createdAt: row.created_at as number,
    ...(route !== null ? { route } : {}),
    ...(ack !== null ? { acknowledgedAt: ack } : {}),
    ...(dispatched !== null ? { pushDispatchedAt: dispatched } : {}),
    ...(pushAck !== null ? { pushAcknowledgedAt: pushAck } : {}),
  };
}
