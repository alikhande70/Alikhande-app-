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

## Amendment — `margin-unknown` is unwaivable

Added after an audit found the desk coercing an unavailable margin figure to
`0.00` before handing it to the governor. The free-margin rule then computed
`marginFree - 0`, which passes for any account with any free margin at all — so
a stale FX rate, a missing conversion path or an absent entry price silently
disabled the margin check rather than stopping the order.

`marginRequiredAccount` is now optional and **undefined means unknown, never
zero**. An unknown value raises `margin-unknown`, which blocks.

It is unwaivable because break-glass exists for judgement calls, and this is not
one. When margin is unknown there is no number for the operator to weigh against
their conviction; overriding it would waive a check that never ran, which is a
different and worse thing than overriding a check that ran and said no.

The correct repair is to obtain the real figure — on MT5 that means
`OrderCalcMargin` for the specific proposed request — not to assume a value.
