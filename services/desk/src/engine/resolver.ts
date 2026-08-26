import type { OrderState } from '@keel/core';
import * as D from '@keel/core';
import type { Database as Db } from 'better-sqlite3';
import type { Logger } from 'pino';
import type { BrokerLookupContext, BrokerPort } from '../broker/port.js';
import type { OrderIntent } from '../ledger/events.js';
import type { Ledger } from '../ledger/ledger.js';
import type { Projector } from '../ledger/projections.js';
import type { Clock } from '../sim/clock.js';
import { recordOrderEvent } from './record.js';
import { clientOrderIdFor } from './supervisor.js';

/**
 * Resolution of unknown outcomes.
 *
 * When a submit produced no usable answer, this is the component that finds out
 * what actually happened. It exists because the alternative — assuming — is how
 * traders end up with two positions or an unhedged one.
 *
 * Two rules govern it:
 *
 * 1. **A single "not found" is not evidence of absence.** Venue search indexes
 *    lag. Absence is concluded only after repeated, separated, consistent
 *    negatives, taken while the connection is healthy.
 *
 * 2. **It never gives up quietly.** If resolution cannot conclude, it escalates
 *    to the operator and keeps trying at a low rate, because an unresolved
 *    order is potential live exposure.
 */

/** Backoff schedule in ms. Fast at first, then patient. */
const SCHEDULE = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000] as const;
const SLOW_INTERVAL_MS = 300_000;
/** Consecutive negatives required before absence is concluded. */
const ABSENCE_CONFIRMATIONS = 2;
/** Minimum spacing between the negatives that count toward absence. */
const ABSENCE_SPACING_MS = 3_000;
/** After this many attempts, wake the operator. */
const ESCALATE_AFTER = 5;

interface Job {
  readonly intentId: string;
  readonly clientOrderId: string;
  attempts: number;
  negatives: number;
  lastNegativeAt: number;
  escalated: boolean;
  cancel: (() => void) | undefined;
  stopped: boolean;
}

export interface ResolverDeps {
  readonly ledger: Ledger;
  readonly projector: Projector;
  readonly broker: BrokerPort;
  readonly clock: Clock;
  readonly log: Logger;
  readonly onEscalate: (intentId: string, attempts: number, detail: string) => void;
  readonly onResolved: (intentId: string, how: 'found' | 'absent') => void;
  readonly onAnomaly?: (intentId: string, anomaly: import('@keel/core').Anomaly) => void;
}

export class UnknownResolver {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly deps: ResolverDeps) {}

  /** The one route an order event takes into the ledger. See record.ts. */
  private record(intentId: string, event: import('@keel/core').OrderEvent): void {
    recordOrderEvent(
      {
        ledger: this.deps.ledger,
        projector: this.deps.projector,
        log: this.deps.log,
        ...(this.deps.onAnomaly !== undefined ? { onAnomaly: this.deps.onAnomaly } : {}),
      },
      intentId,
      event,
    );
  }

  get activeJobs(): number {
    return this.jobs.size;
  }

  /** Begin (or continue) resolving an intent whose outcome is unknown. */
  start(intentId: string, clientOrderId: string): void {
    if (this.jobs.has(intentId)) return;
    const job: Job = {
      intentId,
      clientOrderId,
      attempts: 0,
      negatives: 0,
      lastNegativeAt: 0,
      escalated: false,
      cancel: undefined,
      stopped: false,
    };
    this.jobs.set(intentId, job);
    this.schedule(job);
  }

  /** Resume every UNKNOWN order after a restart. Called at boot. */
  resumeAll(pending: readonly { intentId: string; clientOrderId: string }[]): void {
    for (const p of pending) this.start(p.intentId, p.clientOrderId);
  }

  stop(intentId: string): void {
    const job = this.jobs.get(intentId);
    if (job === undefined) return;
    job.stopped = true;
    job.cancel?.();
    this.jobs.delete(intentId);
  }

  stopAll(): void {
    for (const id of [...this.jobs.keys()]) this.stop(id);
  }

  private schedule(job: Job): void {
    const delay = SCHEDULE[job.attempts] ?? SLOW_INTERVAL_MS;
    job.cancel = this.deps.clock.setTimeout(() => {
      void this.attempt(job);
    }, delay);
  }

  private async attempt(job: Job): Promise<void> {
    if (job.stopped) return;
    const { projector, broker, clock, log } = this.deps;
    job.attempts += 1;

    // The order may have resolved itself while we waited: a fill arriving is
    // proof it reached the venue, and the state machine will have moved on.
    projector.catchUp();
    const record = projector.loadOrderRecord(job.intentId);
    if (record === undefined || record.state !== 'UNKNOWN') {
      log.info({ intentId: job.intentId, state: record?.state }, 'resolution no longer needed');
      this.stop(job.intentId);
      return;
    }

    if (!broker.isConnected()) {
      // Absence cannot be established without a connection. Wait.
      this.schedule(job);
      return;
    }

    let lookup: Awaited<ReturnType<BrokerPort['findByClientOrderId']>>;
    try {
      // Native-id venues can ignore the second argument. Emulated-id venues
      // such as MT5 need it to recover from a restart without relying on an
      // adapter cache that died with the old process.
      lookup = await broker.findByClientOrderId(
        job.clientOrderId,
        lookupContextForIntent(this.deps.ledger, job.intentId),
      );
    } catch (err) {
      lookup = {
        found: 'indeterminate',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    if (job.stopped) return;

    if (lookup.found === true) {
      const o = lookup.order;
      this.record(job.intentId, {
        type: 'resolution.found',
        at: clock.now(),
        venueOrderId: o.venueOrderId,
        venueState: o.state as OrderState,
        filledQty: o.filledQty,
        ...(o.avgFillPrice !== undefined ? { avgPrice: o.avgFillPrice } : {}),
      });
      log.info(
        { intentId: job.intentId, venueOrderId: o.venueOrderId, state: o.state },
        'unknown outcome resolved: the venue had it',
      );
      this.deps.onResolved(job.intentId, 'found');
      this.stop(job.intentId);
      return;
    }

    if (lookup.found === false) {
      const now = clock.now();
      // Only count a negative that is properly separated from the last one. Two
      // lookups in the same instant against the same lagging index are one
      // observation, not two.
      if (job.negatives === 0 || now - job.lastNegativeAt >= ABSENCE_SPACING_MS) {
        job.negatives += 1;
        job.lastNegativeAt = now;
      }
      if (job.negatives >= ABSENCE_CONFIRMATIONS) {
        this.record(job.intentId, {
          type: 'resolution.absent',
          at: now,
          evidence:
            `${job.negatives} consecutive negative lookups for ${job.clientOrderId}, ` +
            `at least ${ABSENCE_SPACING_MS}ms apart, on a healthy connection`,
        });
        log.info({ intentId: job.intentId }, 'unknown outcome resolved: the venue never had it');
        this.deps.onResolved(job.intentId, 'absent');
        this.stop(job.intentId);
        return;
      }
    } else {
      // Indeterminate: reset the absence count. Partial evidence is not evidence.
      job.negatives = 0;
    }

    if (job.attempts >= ESCALATE_AFTER && !job.escalated) {
      job.escalated = true;
      const detail =
        lookup.found === 'indeterminate'
          ? `broker could not answer: ${lookup.reason}`
          : `${job.negatives} negative lookup(s) so far; not yet enough to conclude absence`;
      this.deps.onEscalate(job.intentId, job.attempts, detail);
    }

    this.schedule(job);
  }
}

/**
 * Rebuild the evidence an emulated-id venue needs from durable facts only.
 *
 * The interval begins at `submit.started` (immediately before transport) and
 * ends at the latest persisted order event. For an ambiguous send that is the
 * timeout/socket-failure observation. A wider interval can create more fallback
 * candidates, which safely degrades to INDETERMINATE; a narrower interval could
 * exclude the actual execution and is therefore forbidden.
 */
export function lookupContextForIntent(
  ledger: Ledger,
  intentId: string,
): BrokerLookupContext | undefined {
  const intentRow = ledger.db
    .prepare("SELECT payload FROM ledger WHERE stream = ? AND kind = 'intent.created' LIMIT 1")
    .get(intentId) as { payload: string } | undefined;
  if (intentRow === undefined) return undefined;

  const parsed = JSON.parse(intentRow.payload) as { kind?: string; intent?: OrderIntent };
  const intent = parsed.intent;
  if (parsed.kind !== 'intent.created' || intent === undefined) return undefined;

  const eventRows = ledger.db
    .prepare("SELECT payload FROM ledger WHERE stream = ? AND kind = 'order.event' ORDER BY seq ASC")
    .all(intentId) as Array<{ payload: string }>;

  let sentNotBefore: number | undefined;
  let sentNotAfter: number | undefined;
  for (const row of eventRows) {
    const event = JSON.parse(row.payload) as { event?: { type?: string; at?: number } };
    const orderEvent = event.event;
    if (orderEvent === undefined || typeof orderEvent.at !== 'number') continue;
    if (orderEvent.type === 'submit.started' && sentNotBefore === undefined) {
      sentNotBefore = orderEvent.at;
    }
    if (sentNotBefore !== undefined && orderEvent.at >= sentNotBefore) {
      sentNotAfter = Math.max(sentNotAfter ?? sentNotBefore, orderEvent.at);
    }
  }

  if (sentNotBefore === undefined) return undefined;
  return {
    canonical: intent.canonical,
    symbol: intent.symbol,
    side: intent.side,
    volume: D.dec(intent.volume),
    sentNotBefore,
    sentNotAfter: sentNotAfter ?? sentNotBefore,
  };
}

/** Find every order that needs resolution after a restart. */
export function pendingResolutions(
  projector: Projector,
  db: Db,
): { intentId: string; clientOrderId: string }[] {
  projector.catchUp();
  const rows = db
    .prepare(
      "SELECT intent_id FROM orders WHERE state IN ('UNKNOWN', 'SUBMITTED', 'PENDING_SUBMIT')",
    )
    .all() as Array<{ intent_id: string }>;
  return rows.map((r) => ({
    intentId: r.intent_id,
    clientOrderId: clientOrderIdFor(r.intent_id),
  }));
}

export const RESOLVER_CONSTANTS = {
  SCHEDULE,
  ABSENCE_CONFIRMATIONS,
  ABSENCE_SPACING_MS,
  ESCALATE_AFTER,
  SLOW_INTERVAL_MS,
} as const;
