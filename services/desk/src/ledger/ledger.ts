import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db, Statement } from 'better-sqlite3';
import { DURABLE_KINDS, streamOf } from './events.js';
import type { LedgerEvent, LedgerEventKind } from './events.js';
import { applyMigrations } from './schema.js';

/**
 * The append-only ledger.
 *
 * Writes are synchronous by design. `better-sqlite3` gives a real call-stack
 * guarantee that the row is committed when `append` returns, which is exactly
 * the guarantee the execution path needs before it touches the network. An
 * async driver would let an `await` interleave between "we decided to send" and
 * "we recorded that we decided to send", and that gap is where duplicate
 * executions live.
 *
 * Each row carries `hash = H(prev_hash || seq || ts || kind || stream || payload)`.
 * The chain makes out-of-band edits detectable: a journal you rely on for
 * self-review is worth little if it can be quietly rewritten.
 */

export const GENESIS_HASH = '0'.repeat(64);

export interface LedgerRow {
  readonly seq: number;
  readonly ts: number;
  readonly kind: LedgerEventKind;
  readonly stream: string;
  readonly event: LedgerEvent;
  readonly hash: string;
  readonly prevHash: string;
}

export interface LedgerOptions {
  /** `:memory:` for tests. */
  readonly path: string;
  /**
   * `FULL` fsyncs on every commit — the correct setting when an order intent
   * must survive a power cut. `NORMAL` is meaningfully faster and is only
   * appropriate for tests.
   */
  readonly synchronous?: 'FULL' | 'NORMAL' | 'OFF';
  readonly now?: () => number;
}

export class LedgerIntegrityError extends Error {
  constructor(
    message: string,
    readonly seq: number,
  ) {
    super(message);
    this.name = 'LedgerIntegrityError';
  }
}

function hashRow(
  prevHash: string,
  seq: number,
  ts: number,
  kind: string,
  stream: string,
  payload: string,
): string {
  return createHash('sha256')
    .update(prevHash)
    .update('\x00')
    .update(String(seq))
    .update('\x00')
    .update(String(ts))
    .update('\x00')
    .update(kind)
    .update('\x00')
    .update(stream)
    .update('\x00')
    .update(payload)
    .digest('hex');
}

export class Ledger {
  readonly db: Db;
  private readonly now: () => number;
  private readonly insertStmt: Statement;
  private readonly tailStmt: Statement;
  private lastHash: string;
  private lastSeq: number;

  constructor(opts: LedgerOptions) {
    this.now = opts.now ?? Date.now;
    if (opts.path !== ':memory:') mkdirSync(dirname(opts.path), { recursive: true });
    this.db = new Database(opts.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma(`synchronous = ${opts.synchronous ?? 'FULL'}`);
    this.db.pragma('foreign_keys = ON');
    // A busy timeout matters even single-writer: the WAL checkpointer can hold
    // a lock briefly, and a failed order write is not an acceptable outcome.
    this.db.pragma('busy_timeout = 5000');
    applyMigrations(this.db);

    this.insertStmt = this.db.prepare(
      `INSERT INTO ledger (ts, kind, stream, payload, prev_hash, hash)
       VALUES (@ts, @kind, @stream, @payload, @prevHash, @hash)`,
    );
    this.tailStmt = this.db.prepare('SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1');

    const tail = this.tailStmt.get() as { seq: number; hash: string } | undefined;
    this.lastSeq = tail?.seq ?? 0;
    this.lastHash = tail?.hash ?? GENESIS_HASH;
  }

  get head(): { seq: number; hash: string } {
    return { seq: this.lastSeq, hash: this.lastHash };
  }

  /**
   * Append an event. Returns once the row is committed to disk.
   *
   * The hash of row N depends on row N-1, so this is inherently serial. That is
   * a feature at single-operator volume and a hard ceiling at any other, which
   * is documented rather than papered over.
   */
  append(event: LedgerEvent, at?: number): LedgerRow {
    const ts = at ?? this.now();
    const stream = streamOf(event);
    let payload: string;
    try {
      payload = JSON.stringify(event);
    } catch (err) {
      // The usual cause is a `Dec` (which holds a bigint) reaching the ledger
      // instead of its decimal-string wire form. Say so, rather than surfacing
      // a bare "Do not know how to serialize a BigInt".
      throw new LedgerIntegrityError(
        `event '${event.kind}' is not JSON-serialisable (${String(err)}). ` +
          'Ledger payloads must use wire forms: decimal strings, never Dec values.',
        this.lastSeq + 1,
      );
    }
    const seq = this.lastSeq + 1;
    const prevHash = this.lastHash;
    const hash = hashRow(prevHash, seq, ts, event.kind, stream, payload);

    const info = this.insertStmt.run({ ts, kind: event.kind, stream, payload, prevHash, hash });
    const actualSeq = Number(info.lastInsertRowid);
    if (actualSeq !== seq) {
      // AUTOINCREMENT gave us a different sequence than we hashed. Recovering
      // silently would break the chain, so fail loudly instead.
      throw new LedgerIntegrityError(
        `sequence skew: hashed ${seq}, database assigned ${actualSeq}`,
        actualSeq,
      );
    }
    this.lastSeq = seq;
    this.lastHash = hash;
    return { seq, ts, kind: event.kind, stream, event, hash, prevHash };
  }

  /** Append several events atomically. Either all land or none do. */
  appendAll(events: readonly LedgerEvent[], at?: number): readonly LedgerRow[] {
    const tx = this.db.transaction((evs: readonly LedgerEvent[]) => {
      const rows: LedgerRow[] = [];
      for (const e of evs) rows.push(this.append(e, at));
      return rows;
    });
    return tx(events);
  }

  /** True when this event kind must be on disk before the next action. */
  static isDurable(kind: LedgerEventKind): boolean {
    return DURABLE_KINDS.has(kind);
  }

  read(fromSeq = 0, limit = 10_000): readonly LedgerRow[] {
    const rows = this.db
      .prepare('SELECT * FROM ledger WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(fromSeq, limit) as Array<{
      seq: number;
      ts: number;
      kind: string;
      stream: string;
      payload: string;
      prev_hash: string;
      hash: string;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      kind: r.kind as LedgerEventKind,
      stream: r.stream,
      event: JSON.parse(r.payload) as LedgerEvent,
      hash: r.hash,
      prevHash: r.prev_hash,
    }));
  }

  /** Every event for one aggregate, oldest first. */
  readStream(stream: string): readonly LedgerRow[] {
    const rows = this.db
      .prepare('SELECT * FROM ledger WHERE stream = ? ORDER BY seq')
      .all(stream) as Array<{
      seq: number;
      ts: number;
      kind: string;
      stream: string;
      payload: string;
      prev_hash: string;
      hash: string;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      kind: r.kind as LedgerEventKind,
      stream: r.stream,
      event: JSON.parse(r.payload) as LedgerEvent,
      hash: r.hash,
      prevHash: r.prev_hash,
    }));
  }

  /**
   * Walk the hash chain and prove nothing was altered or removed.
   *
   * Run at boot and on demand. It is the difference between "the history says"
   * and "the history is".
   */
  verifyChain(): { ok: true; rows: number } | { ok: false; failedAt: number; reason: string } {
    const stmt = this.db.prepare('SELECT seq, ts, kind, stream, payload, prev_hash, hash FROM ledger ORDER BY seq');
    let prev = GENESIS_HASH;
    let expectedSeq = 1;
    let count = 0;
    for (const raw of stmt.iterate() as Iterable<{
      seq: number;
      ts: number;
      kind: string;
      stream: string;
      payload: string;
      prev_hash: string;
      hash: string;
    }>) {
      if (raw.seq !== expectedSeq) {
        return {
          ok: false,
          failedAt: raw.seq,
          reason: `sequence gap: expected ${expectedSeq}, found ${raw.seq} (a row was deleted)`,
        };
      }
      if (raw.prev_hash !== prev) {
        return {
          ok: false,
          failedAt: raw.seq,
          reason: `broken chain: prev_hash ${raw.prev_hash} does not match previous row's hash ${prev}`,
        };
      }
      const recomputed = hashRow(prev, raw.seq, raw.ts, raw.kind, raw.stream, raw.payload);
      if (recomputed !== raw.hash) {
        return {
          ok: false,
          failedAt: raw.seq,
          reason: 'row content does not match its hash (the row was modified after it was written)',
        };
      }
      prev = raw.hash;
      expectedSeq += 1;
      count += 1;
    }
    return { ok: true, rows: count };
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** Atomic single-file backup. No external tooling, no partial copies. */
  backupTo(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    this.db.prepare('VACUUM INTO ?').run(path);
  }

  close(): void {
    this.db.close();
  }
}
