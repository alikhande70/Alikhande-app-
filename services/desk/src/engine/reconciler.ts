import { createHash } from 'node:crypto';
import * as D from '@keel/core';
import { reconcile } from '@keel/core';
import type {
  Divergence,
  LocalOrderView,
  LocalPositionView,
  VenueOrderView,
  VenuePositionView,
} from '@keel/core';
import type { Logger } from 'pino';
import type { BrokerPort } from '../broker/port.js';
import { recordOrderEvent } from './record.js';
import type { Ledger } from '../ledger/ledger.js';
import type { Projector } from '../ledger/projections.js';
import type { Clock } from '../sim/clock.js';
import type { DeskState } from './state.js';

/**
 * Continuous reconciliation.
 *
 * Runs on a timer rather than only on events, because the failure it exists to
 * catch is exactly the case where the event path is broken — and a broken event
 * path cannot tell you it is broken.
 *
 * Divergences are identified by a stable hash so the same disagreement seen on
 * fifty consecutive passes is one open item, not fifty alerts. That matters: an
 * alerting system that cries wolf is one the operator learns to dismiss, and
 * this is the alert they must never dismiss.
 */

export interface ReconcilerDeps {
  readonly ledger: Ledger;
  readonly projector: Projector;
  readonly state: DeskState;
  readonly broker: BrokerPort;
  readonly clock: Clock;
  readonly log: Logger;
  readonly onDivergence: (d: Divergence, id: string, isNew: boolean) => void;
  readonly onAnomaly?: (intentId: string, anomaly: import('@keel/core').Anomaly) => void;
  /** Grace period before an in-flight order counts as missing at the venue. */
  readonly settlementGraceMs?: number;
  readonly intervalMs?: number;
}

export interface ReconcileRun {
  readonly at: number;
  readonly clean: boolean;
  readonly opened: number;
  readonly resolved: number;
  readonly divergences: readonly Divergence[];
  /** Set when the run could not complete — never confused with "clean". */
  readonly failed?: string;
}

/** Stable identity for a divergence, so repeat detections do not multiply. */
export function divergenceId(d: Divergence): string {
  const subject = d.positionId ?? d.intentId ?? d.venueOrderId ?? d.canonical ?? '-';
  return createHash('sha256').update(`${d.kind} ${subject}`).digest('hex').slice(0, 16);
}

export class Reconciler {
  private readonly open = new Map<string, Divergence>();
  private cancelTimer: (() => void) | undefined;
  private running = false;

  constructor(private readonly deps: ReconcilerDeps) {}

  start(): void {
    const interval = this.deps.intervalMs ?? 10_000;
    this.cancelTimer = this.deps.clock.setInterval(() => {
      void this.runOnce();
    }, interval);
  }

  stop(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  get openDivergences(): readonly Divergence[] {
    return [...this.open.values()];
  }

  /**
   * One reconciliation pass.
   *
   * A pass that cannot reach the broker reports `failed`, never `clean`. The
   * distinction matters: "nothing is wrong" and "I could not check" must never
   * render the same way.
   */
  async runOnce(): Promise<ReconcileRun> {
    if (this.running) {
      return {
        at: this.deps.clock.now(),
        clean: false,
        opened: 0,
        resolved: 0,
        divergences: [],
        failed: 'a pass is already running',
      };
    }
    this.running = true;
    try {
      return await this.pass();
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<ReconcileRun> {
    const { ledger, projector, state, broker, clock, log } = this.deps;
    const at = clock.now();

    if (!broker.isConnected()) {
      return {
        at,
        clean: false,
        opened: 0,
        resolved: 0,
        divergences: [],
        failed: 'broker not connected; nothing could be compared',
      };
    }

    let venuePositions: VenuePositionView[];
    let venueOrders: VenueOrderView[];
    let venueAccount: { balance: D.Dec; equity: D.Dec; marginUsed: D.Dec };
    try {
      const [positions, orders, account] = await Promise.all([
        broker.getPositions(),
        broker.getOpenOrders(),
        broker.getAccount(),
      ]);
      venuePositions = positions.map((p) => ({
        positionId: p.positionId,
        canonical: p.canonical,
        side: p.side,
        volume: p.volume,
        entryPrice: p.entryPrice,
        foreign: p.clientOrderId === undefined,
        ...(p.stopPrice !== undefined ? { stopPrice: p.stopPrice } : {}),
        ...(p.takeProfitPrice !== undefined ? { takeProfitPrice: p.takeProfitPrice } : {}),
      }));
      venueOrders = orders.map((o) => ({
        venueOrderId: o.venueOrderId,
        canonical: o.canonical,
        state: o.state,
        requestedQty: o.requestedQty,
        filledQty: o.filledQty,
        ...(o.clientOrderId !== undefined ? { clientOrderId: o.clientOrderId } : {}),
      }));
      venueAccount = {
        balance: account.balance,
        equity: account.equity,
        marginUsed: account.marginUsed,
      };
      // Record the venue's account view; it is the authoritative one.
      ledger.append({
        kind: 'account.observed',
        currency: account.currency,
        balance: D.Decimal.toString(account.balance),
        equity: D.Decimal.toString(account.equity),
        marginUsed: D.Decimal.toString(account.marginUsed),
        marginFree: D.Decimal.toString(account.marginFree),
        asOf: account.asOf,
        source: 'broker',
      });
      projector.catchUp();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.warn({ err: detail }, 'reconciliation could not read venue state');
      return { at, clean: false, opened: 0, resolved: 0, divergences: [], failed: detail };
    }

    const localOrders: LocalOrderView[] = state
      .ordersInState(['SUBMITTED', 'UNKNOWN', 'WORKING', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED'])
      .map((row) => {
        const venueOrderId = row.venue_order_id as string | null;
        return {
          intentId: row.intent_id as string,
          canonical: row.canonical as string,
          state: row.state as LocalOrderView['state'],
          requestedQty: D.dec(row.requested_qty as string),
          filledQty: D.dec(row.filled_qty as string),
          lastEventAt: row.last_event_at as number,
          ...(venueOrderId !== null ? { venueOrderId } : {}),
        };
      });

    const localPositions: LocalPositionView[] = state.openPositions().map((p) => ({
      positionId: p.positionId,
      canonical: p.canonical,
      side: p.side,
      volume: p.volume,
      entryPrice: p.entryPrice,
      ...(p.stopPrice !== undefined ? { stopPrice: p.stopPrice } : {}),
      ...(p.takeProfitPrice !== undefined ? { takeProfitPrice: p.takeProfitPrice } : {}),
    }));

    const localAccount = state.getAccount();

    const result = reconcile({
      localOrders,
      venueOrders,
      localPositions,
      venuePositions,
      now: at,
      settlementGraceMs: this.deps.settlementGraceMs ?? 15_000,
      moneyTolerance: D.dec('0.01'),
      ...(localAccount !== undefined
        ? {
            localAccount: {
              balance: localAccount.balance,
              equity: localAccount.equity,
              marginUsed: localAccount.marginUsed,
            },
            venueAccount,
          }
        : {}),
    });

    // Adopt the venue's view where it is authoritative. Only order state is
    // adopted automatically: positions the venue holds that we do not know
    // about are surfaced for the operator to adopt deliberately, because
    // silently absorbing them would hide a genuine surprise.
    for (const d of result.divergences) {
      if (d.action !== 'adopt-venue') continue;
      if (d.intentId === undefined) continue;
      const match = venueOrders.find(
        (o) => o.venueOrderId === d.venueOrderId || o.clientOrderId === d.intentId,
      );
      if (match === undefined) continue;
      recordOrderEvent(
        {
          ledger,
          projector,
          log,
          ...(this.deps.onAnomaly !== undefined ? { onAnomaly: this.deps.onAnomaly } : {}),
        },
        d.intentId,
        { type: 'venue.observed', at, venueState: match.state, filledQty: match.filledQty },
      );
    }
    projector.catchUp();

    const seen = new Set<string>();
    let opened = 0;
    for (const d of result.divergences) {
      const id = divergenceId(d);
      seen.add(id);
      const isNew = !this.open.has(id);
      this.open.set(id, d);
      if (isNew) {
        opened += 1;
        ledger.append({
          kind: 'divergence.opened',
          divergenceId: id,
          divergence: d as unknown as Record<string, unknown>,
          at,
        });
      }
      this.deps.onDivergence(d, id, isNew);
    }

    let resolved = 0;
    for (const id of [...this.open.keys()]) {
      if (seen.has(id)) continue;
      this.open.delete(id);
      resolved += 1;
      ledger.append({
        kind: 'divergence.resolved',
        divergenceId: id,
        how: 'no longer observed',
        at,
      });
    }

    ledger.append({
      kind: 'reconcile.completed',
      checkedAt: at,
      divergences: result.divergences.length,
      clean: result.clean,
    });
    projector.catchUp();

    if (!result.clean) {
      log.warn(
        { count: result.divergences.length, kinds: result.divergences.map((d) => d.kind) },
        'reconciliation found divergences',
      );
    }

    return { at, clean: result.clean, opened, resolved, divergences: result.divergences };
  }
}
