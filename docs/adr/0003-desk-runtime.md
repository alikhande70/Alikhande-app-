# ADR-0003 — Desk runtime: Node 22 + TypeScript + Fastify

**Status:** Accepted

## Context
The desk is I/O-bound (broker sockets, market data, WS fanout to one client), must share a
domain model with the mobile app, and is operated by one person who will occasionally have
to debug it at 2am.

## Options
1. **Node 22 + TypeScript.**
2. **Go.** Better concurrency primitives and a single static binary; loses type sharing
   with the app and forces a second implementation of the domain model.
3. **Rust.** Strongest correctness story; disproportionate build/iteration cost for an
   I/O-bound single-user service.
4. **Python.** Best broker/quant library ecosystem; worst of the four for long-running
   concurrent correctness and for sharing types with a TS client.

## Decision
Node 22 LTS, TypeScript in `strict` mode, Fastify 5.

## Rationale
- The decisive factor is **one domain model, one language, zero translation layer**
  between the risk rules the server enforces and the risk explanations the app renders.
- Single-user load is trivial (one WS client, a handful of instruments). Throughput is a
  non-issue; correctness and debuggability are the whole game.
- Node's single-threaded event loop is an *asset* here: the execution supervisor's
  critical sections are naturally serialised without locks, provided no `await` splits an
  invariant (enforced by design and by test).
- Fastify over Express: schema-first validation, meaningfully better lifecycle hooks,
  first-class TypeScript.

## Consequences
- CPU-heavy analytics must not block the loop. Analytics run on demand over SQLite and are
  bounded; if they grow, they move to a worker thread.
- `bigint` used for all money/price arithmetic (ADR-0005) since JS numbers are unsafe here.
