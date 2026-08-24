# ADR-0009 — Risk enforcement lives on the desk, not the client

**Status:** Accepted

## Context
Client-side risk checks are advisory. They can be bypassed by a modified client, a race,
or simply by the app being closed. The brief ranks risk control above usability and
performance.

## Decision
The **Risk Governor** runs on the desk, in the order path, and is the only way to reach a
broker adapter. There is no code path from an HTTP handler to a broker that does not
traverse it. The client runs an identical *preview* evaluation (shared `@keel/core` code)
purely to render feedback early — the preview is never trusted for authorisation.

Additionally, a **Guard daemon** runs independently of any request: it evaluates drawdown
state on every account update and can auto-flatten and lock out with no client connected.

## Rationale
- The kill switch must work while the operator sleeps. That is only true if it is a server
  loop reacting to account events.
- Sharing the rule implementation (not just the rule *values*) between preview and
  enforcement means the phone's explanation always matches the server's decision. Two
  implementations would drift, and the operator would learn to distrust the preview.
- Enforcement returns a **reason chain** (`[rule, verdict, observed, limit]`) rather than a
  boolean, so a refusal is always explainable and auditable after the fact.

## Consequences
- Slightly higher order latency (one extra evaluation, sub-millisecond in practice).
- Rule configuration changes are themselves ledger events — the system can always answer
  "what were my limits when I placed that trade?", which matters for honest review.
- A "break glass" override exists, is **never silent**, requires re-authentication, is
  scoped to one intent, and is written to the ledger as a first-class event.
