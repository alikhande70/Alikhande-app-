import type { OrderRecord } from '@keel/core';
import * as D from '@keel/core';
import { applyOrderEvent, newOrderRecord } from '@keel/core';
import type { Database as Db } from 'better-sqlite3';
import type { LedgerEvent } from './events.js';
import { fromWireOrderEvent } from './events.js';
import type { Ledger, LedgerRow } from './ledger.js';
import { PROJECTION_TABLES } from './schema.js';

/**
 * Projections: queryable views derived purely from the ledger.
 *
 * The invariant this file exists to keep is that **the ledger is sufficient**.
 * Every projection can be dropped and rebuilt from events alone, and
 * `verifyAgainstRebuild` proves it — which continuously tests that no state has
 * quietly leaked into a table without a corresponding fact behind it.
 */

const WATERMARK = 'projection.watermark';

export class Projector {
  private readonly db: Db;

  constructor(private readonly ledger: Ledger) {
    this.db = ledger.db;
  }

  get watermark(): number {
    return Number(this.ledger.getMeta(WATERMARK) ?? '0');
  }

  /** Bring projections up to date with the ledger. Idempotent. */
  catchUp(batch = 5_000): number {
    let applied = 0;
    for (;;) {
      const rows = this.ledger.read(this.watermark, batch);
      if (rows.length === 0) break;
      const tx = this.db.transaction((rs: readonly LedgerRow[]) => {
        for (const r of rs) this.applyRow(r);
        this.ledger.setMeta(WATERMARK, String(rs[rs.length - 1]?.seq ?? this.watermark));
      });
      tx(rows);
      applied += rows.length;
      if (rows.length < batch) break;
    }
    return applied;
  }

  /** Drop every projection and replay the whole ledger. */
  rebuild(): number {
    const tx = this.db.transaction(() => {
      for (const table of PROJECTION_TABLES) this.db.exec(`DELETE FROM ${table}`);
      this.ledger.setMeta(WATERMARK, '0');
    });
    tx();
    return this.catchUp();
  }

  /**
   * Rebuild into a scratch database and compare, without disturbing live state.
   * A mismatch means code has written to a projection without an event behind
   * it — the one failure mode that would make the ledger not authoritative.
   */
  verifyAgainstRebuild(): { ok: true } | { ok: false; table: string; detail: string } {
    const live = new Map<string, string>();
    for (const table of PROJECTION_TABLES) live.set(table, this.fingerprint(table));

    const savedWatermark = this.watermark;
    const savedRows = new Map<string, unknown[]>();
    for (const table of PROJECTION_TABLES) {
      savedRows.set(table, this.db.prepare(`SELECT * FROM ${table}`).all());
    }

    this.rebuild();
    const mismatches: Array<{ table: string; detail: string }> = [];
    for (const table of PROJECTION_TABLES) {
      const after = this.fingerprint(table);
      if (after !== live.get(table)) {
        mismatches.push({
          table,
          detail: `fingerprint ${live.get(table)} before rebuild, ${after} after`,
        });
      }
    }

    // Restore whatever was there, so a verification never destroys live state.
    const restore = this.db.transaction(() => {
      for (const table of PROJECTION_TABLES) {
        this.db.exec(`DELETE FROM ${table}`);
        const rows = savedRows.get(table) ?? [];
        for (const row of rows) {
          const cols = Object.keys(row as Record<string, unknown>);
          const placeholders = cols.map((c) => `@${c}`).join(', ');
          this.db
            .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`)
            .run(row as Record<string, unknown>);
        }
      }
      this.ledger.setMeta(WATERMARK, String(savedWatermark));
    });
    restore();

    const first = mismatches[0];
    return first === undefined ? { ok: true } : { ok: false, ...first };
  }

  private fingerprint(table: string): string {
    const rows = this.db.prepare(`SELECT * FROM ${table}`).all();
    const normalised = rows
      .map((r) => JSON.stringify(r, Object.keys(r as Record<string, unknown>).sort()))
      .sort()
      .join('|');
    return `${rows.length}:${hashString(normalised)}`;
  }

  private applyRow(row: LedgerRow): void {
    const e = row.event;
    switch (e.kind) {
      case 'intent.created':
        this.onIntentCreated(e, row.ts);
        break;
      case 'order.event':
        this.onOrderEvent(e);
        break;
      case 'position.observed':
        this.onPositionObserved(e);
        break;
      case 'position.closed':
        this.db
          .prepare('UPDATE positions SET closed_at = ?, as_of = ? WHERE position_id = ?')
          .run(e.closedAt, e.closedAt, e.positionId);
        break;
      case 'account.observed':
        this.db
          .prepare(
            `INSERT INTO account_state (id, currency, balance, equity, margin_used, margin_free, as_of, source)
             VALUES (1, @currency, @balance, @equity, @marginUsed, @marginFree, @asOf, @source)
             ON CONFLICT(id) DO UPDATE SET
               currency=excluded.currency, balance=excluded.balance, equity=excluded.equity,
               margin_used=excluded.margin_used, margin_free=excluded.margin_free,
               as_of=excluded.as_of, source=excluded.source`,
          )
          .run(e);
        break;
      case 'instrument.observed':
        this.db
          .prepare(
            `INSERT INTO instruments (canonical, spec, as_of) VALUES (?, ?, ?)
             ON CONFLICT(canonical) DO UPDATE SET spec=excluded.spec, as_of=excluded.as_of`,
          )
          .run(e.canonical, JSON.stringify(e.spec), e.asOf);
        break;
      case 'policy.updated':
        this.db
          .prepare(
            `INSERT INTO policy_versions (version, policy, applied_at) VALUES (?, ?, ?)
             ON CONFLICT(version) DO UPDATE SET policy=excluded.policy, applied_at=excluded.applied_at`,
          )
          .run(e.version, JSON.stringify(e.policy), e.appliedAt);
        break;
      case 'drawdown.updated':
        this.upsertRiskState({
          high_water: e.highWater,
          floor: e.floor,
          current_day_start: e.currentDayStart,
          day_high: e.dayHigh,
          breached: e.breached ? 1 : 0,
          breached_at: e.breachedAt ?? null,
          last_updated_at: e.at,
        });
        break;
      case 'drawdown.breachCleared':
        this.upsertRiskState({ breached: 0, breached_at: null, last_updated_at: e.at });
        break;
      case 'day.rolled':
        this.upsertRiskState({
          day_open_balance: e.openBalance,
          current_day_start: e.dayStart,
          trades_today: 0,
          consecutive_losses: 0,
          last_loss_at: null,
          last_updated_at: e.dayStart,
        });
        break;
      case 'guard.lockout':
        this.upsertRiskState({
          lockout_until: e.until,
          lockout_reason: e.reason,
          last_updated_at: e.at,
        });
        break;
      case 'guard.released':
        this.upsertRiskState({ lockout_until: null, lockout_reason: null, last_updated_at: e.at });
        break;
      case 'divergence.opened':
        this.onDivergenceOpened(e);
        break;
      case 'divergence.acknowledged':
        this.db
          .prepare('UPDATE divergences SET acknowledged_at = ? WHERE divergence_id = ?')
          .run(e.at, e.divergenceId);
        break;
      case 'divergence.resolved':
        this.db
          .prepare('UPDATE divergences SET resolved_at = ? WHERE divergence_id = ?')
          .run(e.at, e.divergenceId);
        break;
      case 'journal.opened':
        this.onJournalOpened(e);
        break;
      case 'journal.closed':
        this.db
          .prepare(
            `UPDATE journal SET closed_at=?, exit_price=?, net_pnl=?, costs=?, r_multiple=?
             WHERE trade_id=?`,
          )
          .run(e.closedAt, e.exitPrice, e.netPnl, e.costs, e.r, e.tradeId);
        this.bumpTradeCounters(e.netPnl, e.closedAt);
        break;
      case 'journal.noted':
        this.db
          .prepare('UPDATE journal SET post_trade_note=?, tags=? WHERE trade_id=?')
          .run(e.postTradeNote, JSON.stringify(e.tags), e.tradeId);
        break;
      case 'alert.raised':
        this.onAlertRaised(e);
        break;
      case 'alert.acknowledged':
        this.db
          .prepare('UPDATE alerts SET acknowledged_at=? WHERE alert_id=?')
          .run(e.at, e.alertId);
        break;
      case 'alert.pushDispatched':
        this.db
          .prepare('UPDATE alerts SET push_dispatched_at=? WHERE alert_id=?')
          .run(e.at, e.alertId);
        break;
      case 'alert.pushAcknowledged':
        this.db
          .prepare('UPDATE alerts SET push_acknowledged_at=? WHERE alert_id=?')
          .run(e.at, e.alertId);
        break;
      // Mission state is currently folded directly from its hash-chained stream.
      // The high-volume list projection arrives only when the Mission HTTP/query
      // surface needs it; these facts still advance the projector watermark so a
      // rebuild remains complete and deterministic.
      case 'mission.observed':
      case 'mission.snapshotSealed':
      case 'mission.stageChanged':
      case 'mission.intentLinked':
      case 'mission.positionLinked':
      case 'mission.actionRecorded':
      case 'mission.reviewed':
      // Events that are recorded for forensics but project no mutable state.
      // Holdout access is intentionally read directly from its authoritative
      // hash-chained stream so an eventually-caught-up projection can never
      // permit a second peek.
      case 'evaluation.holdoutOpened':
      case 'desk.started':
      case 'desk.stopping':
      case 'broker.connected':
      case 'broker.disconnected':
      case 'intent.refused':
      case 'override.used':
      case 'order.anomaly':
      case 'drawdown.breached':
      case 'guard.flattenRequested':
      case 'reconcile.completed':
        break;
      default: {
        const exhaustive: never = e;
        throw new Error(`projector: unhandled event ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private onIntentCreated(e: Extract<LedgerEvent, { kind: 'intent.created' }>, ts: number): void {
    const i = e.intent;
    this.db
      .prepare(
        `INSERT INTO orders (
           intent_id, canonical, symbol, side, kind, time_in_force, requested_qty, filled_qty,
           limit_price, stop_price, attached_stop, attached_tp, state, resolution_attempts,
           applied_fill_ids, created_at, last_event_at)
         VALUES (@intentId, @canonical, @symbol, @side, @kind, @tif, @qty, '0',
                 @limitPrice, @stopPrice, @attachedStop, @attachedTp, 'PENDING_SUBMIT', 0,
                 '[]', @ts, @ts)
         ON CONFLICT(intent_id) DO NOTHING`,
      )
      .run({
        intentId: i.intentId,
        canonical: i.canonical,
        symbol: i.symbol,
        side: i.side,
        kind: i.kind,
        tif: i.timeInForce,
        qty: i.volume,
        limitPrice: i.limitPrice ?? null,
        stopPrice: i.stopPrice ?? null,
        attachedStop: i.attachedStop ?? null,
        attachedTp: i.attachedTakeProfit ?? null,
        ts,
      });
  }

  private onOrderEvent(e: Extract<LedgerEvent, { kind: 'order.event' }>): void {
    const current = this.loadOrderRecord(e.intentId);
    if (current === undefined) return; // no intent row; nothing to project onto
    const result = applyOrderEvent(current, fromWireOrderEvent(e.event));
    if (!result.ok) return; // refusals are already recorded as anomalies
    const r = result.record;
    this.db
      .prepare(
        `UPDATE orders SET
           venue_order_id = @venueOrderId,
           filled_qty = @filledQty,
           avg_fill_price = @avgFillPrice,
           state = @state,
           reason = @reason,
           knowledge_stale_since = @staleSince,
           resolution_attempts = @attempts,
           applied_fill_ids = @fillIds,
           last_event_at = @lastEventAt
         WHERE intent_id = @intentId`,
      )
      .run({
        intentId: r.intentId,
        venueOrderId: r.venueOrderId ?? null,
        filledQty: D.Decimal.toString(r.filledQty),
        avgFillPrice: r.avgFillPrice === undefined ? null : D.Decimal.toString(r.avgFillPrice),
        state: r.state,
        reason: r.reason ?? null,
        staleSince: r.knowledgeStaleSince ?? null,
        attempts: r.resolutionAttempts,
        fillIds: JSON.stringify(r.appliedFillIds),
        lastEventAt: r.lastEventAt,
      });
  }

  loadOrderRecord(intentId: string): OrderRecord | undefined {
    const row = this.db.prepare('SELECT * FROM orders WHERE intent_id = ?').get(intentId) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    const base = newOrderRecord(
      intentId,
      D.dec(row.requested_qty as string),
      row.created_at as number,
    );
    const avg = row.avg_fill_price as string | null;
    const venueOrderId = row.venue_order_id as string | null;
    const reason = row.reason as string | null;
    const staleSince = row.knowledge_stale_since as number | null;
    return {
      ...base,
      state: row.state as OrderRecord['state'],
      filledQty: D.dec(row.filled_qty as string),
      appliedFillIds: JSON.parse(row.applied_fill_ids as string) as string[],
      lastEventAt: row.last_event_at as number,
      resolutionAttempts: row.resolution_attempts as number,
      ...(venueOrderId !== null ? { venueOrderId } : {}),
      ...(avg !== null ? { avgFillPrice: D.dec(avg) } : {}),
      ...(reason !== null ? { reason } : {}),
      ...(staleSince !== null ? { knowledgeStaleSince: staleSince } : {}),
    };
  }

  private onPositionObserved(e: Extract<LedgerEvent, { kind: 'position.observed' }>): void {
    this.db
      .prepare(
        `INSERT INTO positions (
           position_id, canonical, symbol, side, volume, entry_price, stop_price, take_profit,
           opened_at, intent_id, foreign_origin, as_of)
         VALUES (@positionId, @canonical, @symbol, @side, @volume, @entryPrice, @stopPrice,
                 @takeProfitPrice, @openedAt, @intentId, @foreign, @asOf)
         ON CONFLICT(position_id) DO UPDATE SET
           volume=excluded.volume, entry_price=excluded.entry_price,
           stop_price=excluded.stop_price, take_profit=excluded.take_profit,
           as_of=excluded.as_of, closed_at=NULL`,
      )
      .run({
        positionId: e.positionId,
        canonical: e.canonical,
        symbol: e.symbol,
        side: e.side,
        volume: e.volume,
        entryPrice: e.entryPrice,
        stopPrice: e.stopPrice ?? null,
        takeProfitPrice: e.takeProfitPrice ?? null,
        openedAt: e.openedAt,
        intentId: e.intentId ?? null,
        foreign: e.foreign ? 1 : 0,
        asOf: e.asOf,
      });
  }

  private onDivergenceOpened(e: Extract<LedgerEvent, { kind: 'divergence.opened' }>): void {
    const d = e.divergence as Record<string, string | undefined>;
    this.db
      .prepare(
        `INSERT INTO divergences (
           divergence_id, kind, severity, action, canonical, intent_id, venue_order_id,
           position_id, local_view, venue_view, detail, first_seen_at, last_seen_at)
         VALUES (@id, @kind, @severity, @action, @canonical, @intentId, @venueOrderId,
                 @positionId, @local, @venue, @detail, @at, @at)
         ON CONFLICT(divergence_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .run({
        id: e.divergenceId,
        kind: d.kind ?? 'UNKNOWN',
        severity: d.severity ?? 'warning',
        action: d.action ?? 'none',
        canonical: d.canonical ?? null,
        intentId: d.intentId ?? null,
        venueOrderId: d.venueOrderId ?? null,
        positionId: d.positionId ?? null,
        local: d.local ?? '',
        venue: d.venue ?? '',
        detail: d.detail ?? '',
        at: e.at,
      });
  }

  private onJournalOpened(e: Extract<LedgerEvent, { kind: 'journal.opened' }>): void {
    const j = e.entry as Record<string, unknown>;
    this.db
      .prepare(
        `INSERT INTO journal (
           trade_id, intent_id, canonical, side, opened_at, volume, entry_price, stop_price,
           take_profit, risk_account, pre_trade_note, tags, context)
         VALUES (@tradeId, @intentId, @canonical, @side, @openedAt, @volume, @entryPrice,
                 @stopPrice, @takeProfit, @riskAccount, @preTradeNote, @tags, @context)
         ON CONFLICT(trade_id) DO NOTHING`,
      )
      .run({
        tradeId: e.tradeId,
        intentId: (j.intentId as string | undefined) ?? null,
        canonical: j.canonical as string,
        side: j.side as string,
        openedAt: j.openedAt as number,
        volume: j.volume as string,
        entryPrice: j.entryPrice as string,
        stopPrice: j.stopPrice as string,
        takeProfit: (j.takeProfitPrice as string | undefined) ?? null,
        riskAccount: j.riskAccount as string,
        preTradeNote: (j.preTradeNote as string | undefined) ?? '',
        tags: JSON.stringify(j.tags ?? []),
        context: JSON.stringify(j.context ?? {}),
      });
    this.bumpOpenCounter(j.openedAt as number);
  }

  private onAlertRaised(e: Extract<LedgerEvent, { kind: 'alert.raised' }>): void {
    const a = e.alert as Record<string, unknown>;
    this.db
      .prepare(
        `INSERT INTO alerts (alert_id, kind, severity, title, body, route, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(alert_id) DO NOTHING`,
      )
      .run(
        e.alertId,
        a.kind as string,
        a.severity as string,
        a.title as string,
        a.body as string,
        (a.route as string | undefined) ?? null,
        a.createdAt as number,
      );
  }

  private bumpOpenCounter(at: number): void {
    this.ensureRiskRow(at);
    this.db
      .prepare(
        'UPDATE risk_state SET trades_today = trades_today + 1, last_updated_at = ? WHERE id = 1',
      )
      .run(at);
  }

  private bumpTradeCounters(netPnl: string, at: number): void {
    this.ensureRiskRow(at);
    const loss = D.Decimal.lt(D.dec(netPnl), D.Decimal.ZERO);
    if (loss) {
      this.db
        .prepare(
          'UPDATE risk_state SET consecutive_losses = consecutive_losses + 1, last_loss_at = ?, last_updated_at = ? WHERE id = 1',
        )
        .run(at, at);
    } else {
      this.db
        .prepare('UPDATE risk_state SET consecutive_losses = 0, last_updated_at = ? WHERE id = 1')
        .run(at);
    }
  }

  private ensureRiskRow(at: number): void {
    this.db
      .prepare(
        `INSERT INTO risk_state (id, high_water, floor, current_day_start, day_high,
                                 day_open_balance, last_updated_at)
         VALUES (1, '0', '0', 0, '0', '0', ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(at);
  }

  private upsertRiskState(fields: Record<string, string | number | null>): void {
    this.ensureRiskRow(Number(fields.last_updated_at ?? 0));
    const sets = Object.keys(fields)
      .map((k) => `${k} = @${k}`)
      .join(', ');
    this.db.prepare(`UPDATE risk_state SET ${sets} WHERE id = 1`).run(fields);
  }
}

function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export type { LedgerEvent };
