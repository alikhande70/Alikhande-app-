# Verification status

> This document exists so that nothing in this repository has to be taken on
> trust. For every component it states what was actually done, not what was
> intended. Where something is unverified it says so plainly, including where
> that is inconvenient.

**Last updated:** at the commit that added this file. Re-check `git log` for
anything newer.

## The levels, and what each one actually means

| Level | Means |
| --- | --- |
| **Implemented** | Code exists and typechecks. Nothing more is claimed. |
| **Unit tested** | Behaviour is asserted against a test, off any network. |
| **Property tested** | Invariants asserted across generated inputs, not just examples. |
| **Integration tested** | Exercised through the real assembly (real ledger, real socket, real HTTP), against a simulated venue. |
| **Chaos tested** | Survives randomized adversarial sessions with seeded, replayable failures. |
| **Live verified** | Exercised against the real external service, over the real network, from this build environment. |
| **Externally blocked** | Cannot be verified here. The reason is stated. |
| **Not verified** | Written but not exercised. Treat as unproven. |

A component listed at one level has also met the levels above it where they
apply. "Live verified" is the only level that involves a third party actually
responding.

---

## Trading core (`packages/core`)

| Component | Status | Evidence |
| --- | --- | --- |
| Decimal arithmetic | **Property tested** | 49 tests. Commutativity, associativity, distributivity, `toString` round-trip, quantize bounds — asserted over generated values, not examples. |
| Instrument specs & volume normalisation | Unit tested | Venue-precision output, minimum/maximum bounds, tick alignment, stops level. |
| FX conversion | Unit tested | Direct, inverse and bridged paths; per-hop staleness; refusal when no path exists. |
| Position sizing | Unit tested | Including the JPY-quoted case that exposes a 150× error if the quote currency is assumed to be the account currency. |
| Order state machine | **Property tested** | Filled quantity is monotonic under every generated event sequence; leaving a terminal state always raises a critical anomaly; fill ids never apply twice. |
| Risk governor | Unit tested | 35 tests across every rule, the override boundary, and cap composition. |
| Prop-firm drawdown models | Unit tested | Static, intraday-trailing, EOD-trailing; equity vs balance basis; lock-at-start; breach latching. |
| Session clock / DST | Unit tested | Spring-forward gap, autumn-back ambiguity, and a daily reset holding its local hour across a DST change. |
| Reconciliation | Unit tested | Every divergence kind, including positions opened outside the system and unprotected positions. |
| Performance analytics | Unit tested | R-multiples, expectancy, SQN, drawdown of the R curve, execution drift. |

**Total: 212 tests.** Run with `pnpm --filter @keel/core test`.

---

## Desk service (`services/desk`)

| Component | Status | Evidence |
| --- | --- | --- |
| Append-only ledger | Integration tested | Hash chain detects both a modified row and a deleted one. Atomic batch append. Non-JSON-safe payloads rejected with an explanation. |
| Projections | Integration tested | `verifyAgainstRebuild` proves projections are a pure function of the ledger, and catches state written without an event behind it. |
| Execution supervisor | **Chaos tested** | Idempotency under concurrent submits; a transport throw classified ambiguous; risk enforced before transmission; intent fsynced before the network call. |
| Unknown-outcome resolver | Integration tested | Resolves to found and to absent; refuses to conclude absence on a single negative or while disconnected; resumes after a restart. |
| Reconciler | Integration tested | Never reports "clean" when it could not reach the venue; stable divergence identity; adoption of venue order state. |
| Guard daemon | Integration tested | Daily-loss and drawdown enforcement with **no client connected**; flatten retries and reports honestly; a restart does not reset the day. |
| Paper venue | Integration tested | Used as the substrate for everything above. Models ambiguous-but-executed submits, dropped and duplicated fill events, partial fills, stops-level rejections. |
| HTTP + WebSocket surface | Integration tested | 10 end-to-end tests against the **real assembly over a real socket**: unsigned rejection, enrolment, signed reads, nonce-less command rejection, side-effect-free preview, order acceptance, deduplication, sequenced snapshot/resync handshake. |
| Authentication | Unit tested | 23 tests: tampered body, redirected path, replayed nonce, expired command nonce, nonce not burned by a failed signature, P-256 raw `r‖s` verification, curve rejection. |
| Alerts engine | Implemented, unit paths exercised via guard tests | Dedupe, severity floor, undelivered-critical surfacing. Not separately unit tested — see *Known gaps*. |
| Config validation | Unit tested via startup | Refuses to bind non-loopback without an explicit opt-in and TLS. |

**Total: 130 tests, plus the 14-scenario chaos suite and 6 live network tests.**
`pnpm --filter @keel/desk test` runs the first two (144); the live tests are
separate, because they need the network: `pnpm --filter @keel/desk test:live`.

---

## Market data (`services/desk/src/marketdata`)

| Component | Status | Evidence |
| --- | --- | --- |
| **Crypto.com public API** | **Live verified** | 6 tests against `api.crypto.com` and `stream.crypto.com` from this build environment: instruments list, candles parsing into exact decimals with OHLC ordering asserted, uncrossed ticker with the venue's own timestamp, HTTP failure surfaced rather than swallowed, WebSocket subscribe delivering ticks, and **51 seconds of sustained socket with heartbeat responses**. Run with `pnpm --filter @keel/desk test:live`. |
| Bar aggregation | Unit tested | UTC bucketing, partial-bar flagging, late-tick rejection, resampling refusal for non-multiples, gap detection, ATR. |
| Staleness classification | Unit tested | Source-timestamp based; future timestamps treated as clock skew; per-asset-class budgets. |
| Cross-plane divergence | Unit tested | Freshness checked before price, so a frozen feed is not misreported as a dislocation. |
| Synthetic provider | Unit tested | Deterministic per seed; produces a frozen feed that keeps the connection up. |
| Replay provider | Implemented | Deterministic by construction; used by no test yet. See *Known gaps*. |

---

## Broker adapters

| Adapter | Status | Why |
| --- | --- | --- |
| `PaperBroker` | Chaos tested | The default, and the substrate for every other test. |
| OANDA v20 | **Not implemented** | Planned against the `BrokerPort` interface. Not present in this build. |
| MetaApi / MT5 | **Not implemented** | Planned against the `BrokerPort` interface. Not present in this build. |

**This is the largest gap in the system and it is stated plainly.** The desk
runs today only against the paper venue. The `BrokerPort` interface and its
capability descriptor were designed for real adapters, and `main.ts` refuses to
start with `KEEL_BROKER=oanda` or `metaapi` rather than pretending. Two attempts
to build these adapters in parallel were cut short by a session limit before
producing code.

When they are written, note that **no adapter can be live-verified in this
environment**: OANDA practice returns 401 without a token, and MetaApi requires
a paid subscription. Live verification is the operator's first task, against a
demo account, before any real money.

---

## Mobile app (`apps/mobile`)

| Component | Status | Evidence |
| --- | --- | --- |
| Signing contract | **Integration tested** | The client's canonical string is asserted equal to the desk's own implementation, imported directly — and a client-produced signature is verified by the desk's `Authenticator`. Drift fails in CI, not mid-session. |
| Realtime client | Unit tested | 13 tests: gap refuses the delta and resnapshots, duplicate ignored, regression treated as a desk restart, topics independent, resume presents held sequences. |
| HTTP client | Unit tested | A timed-out command reports `outcomeUnknown`; a command that never left the phone reports "did not happen"; commands are never retried; reads are. |
| Store | Unit tested | 16 tests. Losing the socket keeps data but marks topics incomplete; `canTrade` refuses and explains; data age uses the desk clock. |
| Chart geometry | Unit tested | 25 tests: scales, visible range, nice ticks, risk bands, crosshair, stop snapping never tightening a stop. |
| **Screens and rendering** | **Not verified** | Typechecks under `strict` with `exactOptionalPropertyTypes`. **Never rendered on a device or simulator** — this build environment has neither. Layout, gesture feel, accessibility behaviour and performance are all unproven. |
| Secure Enclave signer | **Externally blocked** | `EnclaveSigner` is written against an `EnclaveBridge` interface; the native module it needs is not in this repository. The app falls back to a Keychain-held Ed25519 key, and the desk records it as software-only rather than claiming hardware protection. |
| Push notifications | **Not verified** | `ExpoPushSender` follows Expo's documented API and is written against an injectable transport. Sending a real push needs a token from a physical device. Nothing has been sent to the live service. |

**Total: 76 tests.** Run with `pnpm --filter @keel/mobile test`.

---

## Defects found after the first pass, and by what

Recorded because the *source* of each finding says something about which kinds
of testing were actually earning their keep.

| Found by | Defect | Severity |
| --- | --- | --- |
| Property test | `CONFIRMED_ABSENT` swallowed a later fill — a real position the system believed did not exist | Severe |
| Property test | `resolution.absent` downgraded a confirmed cancel | Moderate |
| Property test | `cancel.rejected` could un-fill a `FILLED` order | Moderate |
| Property test | Terminal-exit escalation was per-branch, so a new branch could forget it | Moderate |
| Integration test | `clientOrderIdFor` truncated the intent id; two intents could collide, and the second trade silently never happened | Severe |
| Integration test | An acknowledgement carrying fills was discarded | Moderate |
| Integration test | The guard tracked the day boundary in memory, so a mid-day restart cleared the daily loss limit | Severe |
| Chaos suite | Unbounded precision creep in two accumulators; both threw in production paths | Severe |
| Chaos suite | The paper venue opened a position per partial fill, masking the duplicate-position invariant | Moderate |
| Audit | The entire anomaly pipeline was dead — computed and discarded | Severe |
| Audit | `POST /positions/:id/close` flattened the whole book | Severe |
| Audit | `POST /orders/:id/cancel` sent nothing while reporting success | Severe |
| Audit | `Ledger.appendAll` corrupted its in-memory chain head on rollback | Severe |
| Audit | A stale FX rate reported a stopped position as having no stop | Moderate |
| Red team | Lockout was applied *after* flattening, leaving a window to open a new position | Severe |
| Red team | Flatten ignored resting orders, which could re-open exposure moments later | Severe |
| Red team | A phone with a skewed clock was locked out of everything, including reads | Moderate |

The pattern worth noting: **example-based tests found almost nothing.** Property
tests, randomized chaos, and reading the code adversarially found everything
severe. Four of the five audit findings were code that typechecked, read
correctly, and did the wrong thing.

## Known gaps, stated without hedging

1. **No real broker.** The single largest gap. Nothing in this system has ever
   sent an order to a real venue, demo or otherwise.
2. **The mobile UI has never been rendered.** Every screen is unproven as a
   visual and interactive artefact. The logic beneath them is tested; the
   pixels are not.
3. **The AI copilot is designed but not built.** ADR-0010 specifies grounding,
   citation validation and read-only tools. The endpoint exists and returns 503
   without an API key. No copilot code ships in this build.
4. **The alerts engine has no dedicated unit tests.** Its behaviour is exercised
   indirectly through the guard tests. Dedupe windows and rate limiting are not
   directly asserted.
5. **The replay provider is unexercised.** Written, typechecked, used by nothing.
6. **Journal capture is partially wired.** The ledger events and projections
   exist; the automatic context capture at fill time (spread, ATR, session,
   minutes to next event) is not yet populated by the execution path.
7. **No load or soak testing.** Single-operator volume makes this low risk, but
   it is untested rather than proven safe.
8. **The desk has never run for more than a test's duration.** Memory behaviour
   over days, WAL growth, and log rotation are unobserved.

## What would have to be true before real money

In order:

1. A broker adapter implemented and **live-verified against a demo account**,
   including a deliberate mid-submit disconnection to confirm the `UNKNOWN` path
   works against that venue's real API.
2. The mobile app built with EAS and run on the operator's own device, with the
   order ticket exercised end to end against the demo account.
3. A real push delivered to that device, and the delivery receipt confirmed.
4. The enclave signer implemented, or a conscious decision recorded to accept a
   Keychain-held key.
5. At least one full trading day run against demo, with the guard's daily-loss
   limit deliberately tripped to confirm it flattens and locks out unattended.
6. A ledger backup taken and **restored**, proving the recovery path.

Nothing in this repository claims any of those have happened.
