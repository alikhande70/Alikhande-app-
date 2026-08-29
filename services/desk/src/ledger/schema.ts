import type { Database } from 'better-sqlite3';

/**
 * Schema for the desk's durable state.
 *
 * `ledger` is the system of record: append-only, hash-chained, never updated.
 * Everything else is a projection derived from it and can be dropped and
 * rebuilt. That division is what makes "what did we know at 14:32:05?" a
 * question with an answer.
 */

export const SCHEMA_VERSION = 1;

/**
 * Migrations are forward-only and must never rewrite `ledger` rows. Old events
 * stay replayable forever; a projection change is a projection rebuild, not a
 * history edit.
 */
export const MIGRATIONS: readonly { version: number; up: string }[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS ledger (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         INTEGER NOT NULL,
        kind       TEXT    NOT NULL,
        stream     TEXT    NOT NULL,
        payload    TEXT    NOT NULL,
        prev_hash  TEXT    NOT NULL,
        hash       TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_stream_idx ON ledger(stream, seq);
      CREATE INDEX IF NOT EXISTS ledger_kind_idx   ON ledger(kind, seq);
      CREATE INDEX IF NOT EXISTS ledger_ts_idx     ON ledger(ts);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Projections --------------------------------------------------------
      CREATE TABLE IF NOT EXISTS orders (
        intent_id           TEXT PRIMARY KEY,
        venue_order_id      TEXT,
        canonical           TEXT NOT NULL,
        symbol              TEXT NOT NULL,
        side                TEXT NOT NULL,
        kind                TEXT NOT NULL,
        time_in_force       TEXT NOT NULL,
        requested_qty       TEXT NOT NULL,
        filled_qty          TEXT NOT NULL,
        limit_price         TEXT,
        stop_price          TEXT,
        avg_fill_price      TEXT,
        attached_stop       TEXT,
        attached_tp         TEXT,
        state               TEXT NOT NULL,
        reason              TEXT,
        knowledge_stale_since INTEGER,
        resolution_attempts INTEGER NOT NULL DEFAULT 0,
        applied_fill_ids    TEXT NOT NULL DEFAULT '[]',
        created_at          INTEGER NOT NULL,
        last_event_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS orders_state_idx ON orders(state);

      CREATE TABLE IF NOT EXISTS positions (
        position_id     TEXT PRIMARY KEY,
        canonical       TEXT NOT NULL,
        symbol          TEXT NOT NULL,
        side            TEXT NOT NULL,
        volume          TEXT NOT NULL,
        entry_price     TEXT NOT NULL,
        stop_price      TEXT,
        take_profit     TEXT,
        risk_account    TEXT,
        opened_at       INTEGER NOT NULL,
        intent_id       TEXT,
        foreign_origin  INTEGER NOT NULL DEFAULT 0,
        closed_at       INTEGER,
        as_of           INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_state (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        currency      TEXT NOT NULL,
        balance       TEXT NOT NULL,
        equity        TEXT NOT NULL,
        margin_used   TEXT NOT NULL,
        margin_free   TEXT NOT NULL,
        as_of         INTEGER NOT NULL,
        source        TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS risk_state (
        id                  INTEGER PRIMARY KEY CHECK (id = 1),
        high_water          TEXT NOT NULL,
        floor               TEXT NOT NULL,
        current_day_start   INTEGER NOT NULL,
        day_high            TEXT NOT NULL,
        breached            INTEGER NOT NULL DEFAULT 0,
        breached_at         INTEGER,
        day_open_balance    TEXT NOT NULL,
        trades_today        INTEGER NOT NULL DEFAULT 0,
        consecutive_losses  INTEGER NOT NULL DEFAULT 0,
        last_loss_at        INTEGER,
        lockout_until       INTEGER,
        lockout_reason      TEXT,
        last_updated_at     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS divergences (
        divergence_id   TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        severity        TEXT NOT NULL,
        action          TEXT NOT NULL,
        canonical       TEXT,
        intent_id       TEXT,
        venue_order_id  TEXT,
        position_id     TEXT,
        local_view      TEXT NOT NULL,
        venue_view      TEXT NOT NULL,
        detail          TEXT NOT NULL,
        first_seen_at   INTEGER NOT NULL,
        last_seen_at    INTEGER NOT NULL,
        acknowledged_at INTEGER,
        resolved_at     INTEGER
      );
      CREATE INDEX IF NOT EXISTS divergences_open_idx ON divergences(resolved_at);

      CREATE TABLE IF NOT EXISTS journal (
        trade_id      TEXT PRIMARY KEY,
        intent_id     TEXT,
        canonical     TEXT NOT NULL,
        side          TEXT NOT NULL,
        opened_at     INTEGER NOT NULL,
        closed_at     INTEGER,
        volume        TEXT NOT NULL,
        entry_price   TEXT NOT NULL,
        exit_price    TEXT,
        stop_price    TEXT NOT NULL,
        take_profit   TEXT,
        risk_account  TEXT NOT NULL,
        net_pnl       TEXT,
        costs         TEXT,
        r_multiple    TEXT,
        pre_trade_note TEXT NOT NULL,
        post_trade_note TEXT,
        tags          TEXT NOT NULL DEFAULT '[]',
        context       TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS journal_opened_idx ON journal(opened_at);

      CREATE TABLE IF NOT EXISTS alerts (
        alert_id             TEXT PRIMARY KEY,
        kind                 TEXT NOT NULL,
        severity             TEXT NOT NULL,
        title                TEXT NOT NULL,
        body                 TEXT NOT NULL,
        route                TEXT,
        created_at           INTEGER NOT NULL,
        acknowledged_at      INTEGER,
        push_dispatched_at   INTEGER,
        push_acknowledged_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS alerts_created_idx ON alerts(created_at);

      CREATE TABLE IF NOT EXISTS instruments (
        canonical  TEXT PRIMARY KEY,
        spec       TEXT NOT NULL,
        as_of      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS policy_versions (
        version    INTEGER PRIMARY KEY,
        policy     TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bars (
        canonical  TEXT NOT NULL,
        timeframe  TEXT NOT NULL,
        t          INTEGER NOT NULL,
        o          TEXT NOT NULL,
        h          TEXT NOT NULL,
        l          TEXT NOT NULL,
        c          TEXT NOT NULL,
        v          TEXT NOT NULL,
        source     TEXT NOT NULL,
        PRIMARY KEY (canonical, timeframe, t)
      );
    `,
  },
];

/** Names of every projection table, for the rebuild-and-compare self check. */
export const PROJECTION_TABLES = [
  'orders',
  'positions',
  'account_state',
  'risk_state',
  'divergences',
  'journal',
  'alerts',
  'instruments',
  'policy_versions',
] as const;

export function applyMigrations(db: Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null;
  };
  const current = row.v ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
