# ADR-0004 — Persistence: SQLite (WAL) with an append-only event ledger + projections

**Status:** Accepted

## Context
The system must survive `SIGKILL` at any instruction without losing an order intent or
double-sending one, must support forensic reconstruction ("what did we know at 14:32:05?"),
and is operated by one person who should not have to run a database cluster.

## Options
1. **Postgres.** Excellent, but an extra service to operate and back up for one user.
2. **SQLite in WAL mode.**
3. **Plain JSON/flat files.** No transactions, no crash-safety guarantees worth the name.
4. **Full event-sourcing framework.** Overweight for the domain size.

## Decision
SQLite with `journal_mode=WAL` and `synchronous=FULL` on the ledger path. A hand-rolled,
minimal event-sourced core:

- `ledger` — append-only, monotonic `seq`, immutable, every state-changing fact.
- Projections (`orders`, `positions`, `account_snapshots`, `risk_state`, …) rebuilt purely
  from `ledger`, and **rebuildable from scratch at boot** as a self-check.

## Rationale
- `synchronous=FULL` gives a durability guarantee at the exact moment we need one: the
  order intent is on disk before a byte goes to the broker.
- A rebuildable projection is a *continuously tested* invariant: if the projection can be
  regenerated and matches, the ledger is authoritative and the code is consistent.
- SQLite's single-writer model matches the desk's single-writer reality and removes an
  entire class of race conditions.
- Backup is `VACUUM INTO` — one file, atomic, no external tooling.

## Consequences
- Writes are serialised. Fine at single-operator volume; measured in the perf suite.
- Schema migrations must be forward-only and event-compatible; old events must always
  remain replayable. Enforced by a replay test over recorded fixtures.
