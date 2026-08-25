# Architecture

> How Keel is put together, and — more usefully — the failure model it is built
> around. Every structural decision here exists because of a specific way
> trading systems go wrong.

For *why* each choice was made over its alternatives, see [`adr/`](adr/).
For what has actually been verified, see [`VERIFICATION.md`](VERIFICATION.md).

---

## 1. The shape

```
┌─────────────────────────────────────────────────────────────────┐
│  PHONE                                                          │
│  A view and command surface. Never the system of record.        │
│                                                                 │
│  • signs every request with a device-bound key                  │
│  • holds sequence numbers per topic and detects its own gaps    │
│  • renders certainty and staleness as visual properties         │
│  • runs the identical risk evaluation for preview only          │
└────────────────────────┬────────────────────────────────────────┘
                         │  signed HTTP (commands) + one WebSocket
                         │  (sequenced snapshot/delta)
┌────────────────────────┴────────────────────────────────────────┐
│  DESK — always on, single tenant, the operator's own machine    │
│                                                                 │
│   HTTP/WS ──▶ Risk Governor ──▶ Execution Supervisor ──▶ Broker │
│                     ▲                    │                      │
│                     │                    ▼                      │
│   Guard daemon ◀────┴───── Ledger (append-only, hash-chained)   │
│        │                        │                               │
│        │                        ▼                               │
│        │                   Projections                          │
│        │                        ▲                               │
│        └── Reconciler ──────────┘                               │
│                 ▲                                               │
│                 └── continuous diff against the venue           │
└────────────────────────┬────────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
        Execution plane      Reference plane
        (broker quotes)      (independent feed)
```

The two things worth noticing:

- **Every path to the broker goes through the Risk Governor.** There is no
  handler that can reach an adapter without traversing it.
- **The Guard daemon has no arrow from the phone.** It reacts to account
  updates, not to requests, which is the entire reason the desk exists as a
  separate always-on process.

---

## 2. The order path, in order

This sequence is the most important thing in the system. Each step is where it
is for a reason.

```
1. Acquire the per-intent lock          two taps cannot race
2. Check idempotency in the ledger      a retry returns the first outcome
3. Evaluate risk                        server-side, unbypassable
4. Derive size from the venue spec      never trust a client-computed size
5. fsync the intent to the ledger       evidence exists before transmission
6. Transmit
7. Classify honestly                    a timeout is UNKNOWN, never REJECTED
```

**Step 5 before step 6** is the property that makes a power cut survivable. When
`append` returns, the intent is on disk. A process killed at any instruction
after that leaves evidence that something may be live at the venue, and boot
recovery finds it before accepting anything new.

**Step 1 exists because `await` is an interleaving point.** Node's loop
serialises synchronous code, but two concurrent submissions of the same intent
would otherwise both pass step 2 before either wrote its record — one human
decision, two orders.

**Step 7 is the difference between this system and most retail clients.** The
`BrokerSubmitResult` type has three cases, and `ambiguous` is the one that
matters: any timeout, socket error, 5xx or unparseable body produces it. There
is no code path from "no response" to "did not happen".

---

## 3. Truth, and how it is kept

### The ledger is the system of record

Append-only, hash-chained, never updated. Row *N*'s hash covers row *N-1*'s, so
a modified row or a deleted one is detectable — and *is* detected, at boot,
before anything else runs. A corrupted ledger is a refuse-to-start condition,
not a warning.

Everything else — orders, positions, account state, the journal — is a
projection derived from it, and `verifyAgainstRebuild` proves that by rebuilding
into scratch tables and comparing. That check catches the one failure that would
make the ledger non-authoritative: state written to a projection with no fact
behind it.

Payloads are decimal strings, never internal `Dec` values. Two reasons: JSON
cannot serialise a bigint at all, and `sqlite3 keel.db "select payload from
ledger"` needs to be readable at 2am.

### The venue is authoritative about its own book

The order state machine splits every event into two classes:

- **Local commands** (`submit.started`, `cancel.requested`, …) — things *we* do.
  Issuing one in the wrong state is our bug, so it is refused loudly.
- **Venue facts** (`fill`, `venue.observed`, `resolution.found`, …) — things the
  venue tells us. **These are never refused.** A refused venue fact is a lost
  venue fact, and a lost fill is a position the system believes does not exist.

When a venue fact contradicts local belief, the venue wins and a critical
anomaly is raised. Leaving a terminal state is structurally guaranteed to
escalate — the check lives in one place rather than in each branch, so no future
branch can forget it.

### Certainty is a separate axis from state

`WORKING` and `UNKNOWN` are states. `confirmed`, `in-flight`, `unknown` and
`local` are certainties. They are separate because "we think it's working" and
"the venue told us it's working" must never render identically.

A third distinction matters: **existence-unknown** versus **knowledge-stale**.
If a submit times out with no evidence the order arrived, its existence is
unknown. If a *fill* arrived and then the connection dropped, the order
certainly exists — only our knowledge is stale. Conflating them either
under-alarms or sends the operator chasing a phantom.

### Unknown outcomes are chased, not assumed

`UnknownResolver` searches the venue by client order id on a backoff schedule.
Two rules:

1. **A single "not found" is not evidence of absence.** Venue search indexes lag.
   Absence is concluded only after repeated negatives, properly separated in
   time, taken while the connection is healthy.
2. **It never gives up quietly.** If resolution cannot conclude, it escalates to
   the operator and keeps trying slowly. An unresolved order is potential live
   exposure.

### Reconciliation runs on a timer, not on events

Because the failure it exists to catch is precisely the case where the event
path is broken — and a broken event path cannot tell you it is broken.

A pass that cannot reach the venue reports `failed`, never `clean`. "Nothing is
wrong" and "I could not look" are different answers and must never render the
same way.

---

## 4. Risk

The governor evaluates ~20 pre-committed rules *together* rather than
short-circuiting, so the operator sees everything wrong at once instead of
discovering problems one refusal at a time under pressure. Each rule returns a
reason chain: `[rule, verdict, observed, limit, message]`.

Caps compose by **minimum**. When both a per-trade cap and a drawdown-buffer cap
apply, the tighter one wins — never the most recently evaluated.

A **break-glass override** exists, is never silent, and is written to the ledger
as its own event. It can waive rules that are matters of discipline. It cannot
waive the rules that exist because the system genuinely cannot compute a safe
answer: no broker connection, non-broker account figures, stale account state,
stale quote, drawdown breach or headroom, daily loss limit, duplicate intent.

Unbounded risk has no number. A position with no stop is not valued at its
margin, or at zero — the aggregate rule *refuses to compare* and says so, because
a total that reads as safe is worse than no total.

### The Guard daemon

Runs independently of any request. Rolls the trading day at the operator's local
boundary through DST, enforces the daily loss limit and the drawdown floor, and
flattens.

A flatten is not one attempt. It retries with backoff and **re-reads positions
from the venue**, because the venue is the authority on whether we are flat, not
our own count. An ambiguous close is never counted as done. When it cannot
confirm, it says so and tells the operator to check the terminal rather than
reassuring them.

The day boundary comes from durable state, never from a field in memory. An
earlier version tracked it in a field initialised to zero, so restarting the desk
mid-day rolled the day, reset the day-open balance to the already-reduced current
balance, and silently cleared the daily loss limit. **Restarting a process must
never widen a risk limit.**

---

## 5. Numbers

All money, prices, sizes and risk use scaled `bigint` arithmetic
(`packages/core/src/money/decimal.ts`). No implicit rounding anywhere: any
operation that cannot be exact demands an explicit target scale and rounding
mode, because rounding *direction* is a trading decision. Position size rounds
down so risk is never exceeded; a stop rounds outward so it is never tightened.

Floats are permitted in exactly two places, both documented at the boundary:
chart pixel geometry, and advisory indicator maths that never sizes an order.

There is a scale ceiling, and it earns its keep. Two accumulators — the running
average fill price and the spread moving average — derived their precision from
their own previous output, growing by two digits per update. Both overflowed and
threw in production paths. The chaos suite found them; the ceiling is what
turned silent unbounded growth into a loud failure. **An accumulator fed by its
own output must be re-bounded every step.**

---

## 6. Market data: two planes

- **Execution plane** — broker quotes. The only prices that may validate, size or
  price an order.
- **Reference plane** — an independent provider, for charts and context.

They are never mixed, and the plane travels with every value so the UI can render
them differently. A divergence monitor compares them: the failure it catches is a
broker feed that has frozen while the socket stays open, which is invisible to
any check that only asks "are we connected?".

Freshness is checked before price, so a freeze is not misreported as a
dislocation — comparing a frozen price to a live one produces a number that
describes the freeze, not the market.

Staleness is classified in exactly one place, on the desk, and put on the wire.
The client never works it out itself: two implementations of "is this stale?"
eventually disagree, and the moment they do the app shows a live badge over a
dead price.

---

## 7. The wire

One WebSocket, sequenced per topic, snapshot plus delta, with resume.

The client asserts contiguity and forces a resnapshot on any gap. It never
interpolates. Without sequence numbers a client cannot distinguish a quiet market
from a dead socket — and those look identical right up until one of them costs
money.

Deltas for orders, positions and fills are strictly gap-free. Quotes may be
conflated for rendering, but conflation is applied by the caller, to quotes only,
never to anything that affects position state.

A client that cannot keep up is disconnected rather than buffered without limit:
unbounded buffering turns one slow phone into a desk that runs out of memory, and
the client's own resume logic makes reconnecting safe.

---

## 8. Security

No passwords, no registration, no reset flow. A reset flow is an attack surface
that exists only to serve users who forget passwords, and there is one user here
who will not.

The device holds a private key and signs every request over a canonical string
covering method, path, timestamp, nonce, body hash and command nonce. Commands
that can move money additionally consume a **single-use server nonce**, so a
captured request cannot be replayed even by someone who owns the transport.
Reads do not, so a flaky network never locks the operator out of *seeing* their
positions — only out of changing them.

A failed signature does not burn a nonce. Otherwise an attacker who cannot forge
anything could still lock the operator out by exhausting their nonces.

Two key types, with an honest difference: **ECDSA P-256** can be generated
non-extractably inside a Secure Enclave, and **Ed25519** cannot on iOS — it lives
in the Keychain, encrypted at rest but readable by the app process. The desk
records which it enrolled rather than assuming the stronger one.

The desk binds to loopback and refuses to start on a wider interface without an
explicit opt-in *and* TLS. A startup failure, not a warning: a warning in a log
nobody reads is how it ends up running that way for months.

---

## 9. Failure model

What the system is built to survive, and how:

| Failure | Response |
| --- | --- |
| Network drops mid-submit | `UNKNOWN`, resolver chases it, client told not to resend |
| Process killed mid-submit | Intent already fsynced; boot recovery resumes resolution |
| Duplicate request | Idempotent on intent id; per-intent lock serialises concurrent ones |
| Double tap, new intent id | Duplicate-intent rule blocks materially identical orders in a window |
| Broker rejects | Recorded as a fact; nothing opened |
| Partial fill | Accumulated; state reflects it; averages stay bounded |
| Fill event dropped | Reconciliation finds it and raises `MISSED_FILL_EVENTS` |
| Fill event duplicated | Ignored by fill id |
| Fill after cancel | Applied — it is real money — and escalated |
| Venue contradicts us | Venue wins, critical anomaly raised |
| Broker feed freezes, socket alive | Divergence monitor and staleness budgets catch it |
| Manual trade from the broker terminal | Recorded as foreign; if opened while the desk was down, surfaced as adoptable |
| Position with no stop | Critical divergence, top of the home screen, blocks new entries |
| Desk restarts mid-day | Day boundary read from durable state; limits unchanged |
| Ledger tampered with | Hash chain detects it; desk refuses to start |
| Socket gap | Client resnapshots; topic marked incomplete; trading disabled meanwhile |
| Phone clock wrong | Data age computed against the desk's clock via measured offset |

---

## 10. Layout

```
packages/contracts   Wire schemas (zod). Imported by both sides, so a protocol
                     change is a compile error rather than a runtime surprise.
packages/core        Pure domain. No network, no clock, no filesystem — every
                     input explicit, including `now`. This is what lets the
                     client run the identical risk evaluation and the chaos
                     suite replay a trading day deterministically.
services/desk        The always-on service.
apps/mobile          Expo / React Native client.
```
