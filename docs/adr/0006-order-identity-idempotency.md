# ADR-0006 — Order identity: client-generated intent IDs and end-to-end idempotency

**Status:** Accepted

## Context
The dangerous scenario is: operator taps confirm → request in flight → network drops →
app retries → **two positions**. Or: request succeeds at the broker, response lost, app
shows "failed", operator retries. Both are duplicate-execution paths.

## Decision
1. The **app** generates an `intentId` (UUIDv7) when the operator opens the ticket. It is
   stable across retries of that same human decision.
2. The desk treats `POST /orders` as idempotent on `intentId`: an intent already in the
   ledger returns the *existing* outcome, never a new submission.
3. The desk derives a deterministic broker-visible `clientOrderId` from the `intentId`
   so the order can be found at the broker even if our response was lost.
4. Intent is written to the ledger with state `PENDING_SUBMIT` and `fsync`ed **before**
   the broker call. If the process dies mid-call, boot recovery finds it.
5. A broker call that times out or errors ambiguously moves the intent to
   **`UNKNOWN`** — never `FAILED`. `UNKNOWN` triggers active resolution: search the
   broker by `clientOrderId`, over a bounded schedule, before any conclusion is drawn.

## Rejected
- *Server-generated IDs.* The retry then carries no stable identity and the server cannot
  deduplicate the human decision.
- *Treat timeout as failure.* This is the single most common cause of duplicate retail
  execution and is explicitly forbidden by the brief.
- *Treat HTTP 200 as filled.* Acknowledgement is not execution. Fill state comes only from
  broker fill events or a broker query, never from the submit response's absence of error.

## Consequences
- Every broker adapter must implement `findByClientOrderId`. An adapter that cannot is
  documented as **unsafe for automatic retry** and its retries are disabled at the port.
- `UNKNOWN` is a rendered UI state with its own visual treatment; it is never collapsed
  into a spinner or an error toast.
