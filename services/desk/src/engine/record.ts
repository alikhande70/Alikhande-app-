import type { Anomaly, OrderEvent } from '@keel/core';
import { applyOrderEvent } from '@keel/core';
import type { Logger } from 'pino';
import { toWireOrderEvent } from '../ledger/events.js';
import type { Ledger } from '../ledger/ledger.js';
import type { Projector } from '../ledger/projections.js';

/**
 * The single place an order event enters the system.
 *
 * This module exists because of a defect found in audit: the state machine
 * computed anomalies correctly — overfills, phantom resurrections, fills the
 * event path never delivered, absences contradicted by local evidence — and
 * every one of them was thrown away. `onAnomaly` was declared, wired at both
 * call sites, and never once invoked. The alert that would tell the operator
 * "your broker just contradicted us" could not fire.
 *
 * The lesson generalised: an event that reaches the ledger by more than one
 * route will eventually take the route that forgets something. So there is now
 * exactly one route, and it does all three jobs together — apply, record, and
 * escalate.
 */

export interface RecordDeps {
  readonly ledger: Ledger;
  readonly projector: Projector;
  readonly log: Logger;
  /** Called for every anomaly, so alerts and divergences can be raised. */
  readonly onAnomaly?: (intentId: string, anomaly: Anomaly) => void;
}

export interface RecordResult {
  readonly applied: boolean;
  readonly anomalies: readonly Anomaly[];
  /** Set when the state machine refused the event as an illegal local command. */
  readonly refusal?: string;
}

/**
 * Apply an order event, write it and any anomalies to the ledger, and escalate.
 *
 * Note the ordering: the event and its anomalies are appended in one atomic
 * batch. Recording a fill without the overfill anomaly that accompanies it
 * would leave a ledger that reads as normal.
 */
export function recordOrderEvent(
  deps: RecordDeps,
  intentId: string,
  event: OrderEvent,
): RecordResult {
  const { ledger, projector, log } = deps;

  projector.catchUp();
  const current = projector.loadOrderRecord(intentId);
  if (current === undefined) {
    // No intent row means nothing to apply this to. That is itself worth
    // knowing: it means a venue fact arrived for something we have no record
    // of creating.
    log.warn({ intentId, event: event.type }, 'order event for an unknown intent');
    return { applied: false, anomalies: [], refusal: 'no such intent' };
  }

  const outcome = applyOrderEvent(current, event);
  if (!outcome.ok) {
    log.warn({ intentId, event: event.type, refusal: outcome.refusal }, 'order event refused');
    return { applied: false, anomalies: [], refusal: outcome.refusal };
  }

  ledger.appendAll([
    { kind: 'order.event', intentId, event: toWireOrderEvent(event) },
    ...outcome.anomalies.map((anomaly) => ({ kind: 'order.anomaly' as const, intentId, anomaly })),
  ]);
  projector.catchUp();

  for (const anomaly of outcome.anomalies) {
    const level =
      anomaly.severity === 'critical' ? 'error' : anomaly.severity === 'warning' ? 'warn' : 'info';
    log[level]({ intentId, kind: anomaly.kind, detail: anomaly.detail }, 'order anomaly');
    deps.onAnomaly?.(intentId, anomaly);
  }

  return { applied: true, anomalies: outcome.anomalies };
}
