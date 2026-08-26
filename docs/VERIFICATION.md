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

**Total: 216 tests, plus the 14-scenario chaos suite and 12 live network tests.**
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
| **LiteFinance / MT5** | **Level 1 of 9 — architecture reviewed only** | The production target. Designed in ADR-0015/0016 and adversarially reviewed; **no code exists yet**. See the ladder below. |
| OANDA v20 | **Integration tested, not live verified** · *reference adapter* | 86 tests against a scripted v20. No request has ever reached `api-fxpractice.oanda.com`. No longer the production venue — retained as the independent FX/metals price plane and as the control case for `BrokerPort`. |
| MetaApi / MT5 cloud | **Rejected, not planned** | Rejected in ADR-0016 on credential custody: it requires handing a third party the keys to the account. |

### The MT5 verification ladder

The MT5 path does not use the honesty levels above. Mocks are not sufficient for a
venue whose documented behaviour includes dropping events, so it progresses through
nine explicit stages, and **nothing may be described as broker-verified before stage 7**.

| # | Stage | Status |
| --- | --- | --- |
| 1 | Architecture reviewed | **Done** — ADR-0015/0016/0017, adversarially reviewed in `DESIGN-REVIEW-mt5.md` |
| 2 | Implementation complete | Not started |
| 3 | Unit tested | Not started |
| 4 | Integration tested | Not started |
| 5 | Failure / chaos tested | Not started |
| 6 | Real MT5 terminal tested | Not started |
| 7 | LiteFinance **demo** account tested | Not started |
| 8 | Restart / reconnect recovery tested | Not started |
| 9 | End-to-end Android + Desktop → core → MT5 → broker → reconciliation | Not started |

Two constraints on this environment, stated because they bound what can ever be
claimed from here:

- **MQL5 cannot be compiled in this environment.** The agent will be written
  conservatively against well-established APIs, and it must be compiled in MetaEditor
  by the operator. It may not be called working until it has been.
- **There is no MT5 terminal and no LiteFinance account here.** Stages 6 through 9 are
  the operator's, on demo, and no amount of local testing substitutes for them.

Assumptions that only stage 7 can settle, recorded now so they are not quietly
forgotten:

- Whether LiteFinance preserves `magic` through pending-order activation. Field reports
  say some brokers zero it. The fingerprint fallback in ADR-0015 exists because of this
  and is itself unverified.
- The exact symbol names and suffixes on the account (`XAUUSD` vs `XAUUSD.m` vs other).
- The broker's server/UTC offset and its DST rule.
- Which filling modes the account's symbols actually permit.
- Whether the account is netting or hedging.

---

### What the OANDA adapter has actually been tested against

A stub that replays v20 response *shapes* — not the venue. That distinction is
the whole point of this document, so it is worth being precise about what the 86
tests do and do not establish.

**Established, because the logic is pure and the inputs are exact:**

| Behaviour | Evidence |
| --- | --- |
| A timeout, socket error, 429 or any 5xx becomes `ambiguous`, never `rejected` | Asserted for each status individually |
| A 2xx whose body cannot be parsed becomes `ambiguous` | The order may have filled; the response cannot say |
| A partial fill is read as a fill, not as the cancellation beside it | An IOC order returns both; reading the cancel first would report a live position as rejected |
| A non-404 lookup failure is never evidence of absence | Asserted for 400/401/403/405/422 — see the defects below |
| The client id goes on both the order and the trade | Read back off the wire in the test |
| Nanosecond RFC3339 timestamps parse to the venue's own millisecond | And an unparseable one throws rather than substituting the local clock |
| Volume, price and units survive as exact decimals | Every v20 number is a string, parsed with `dec()` |
| A dropped stream replays what it missed via `sinceid` | And does not replay the anchor transaction |
| The stream reports "connected" only once it has genuinely reopened | Regression test, see defects below |

**Not established — only the live suite can establish it:**

- That OANDA's `ClientID` accepts our `k-` prefixed base32 ids unchanged. The
  character set is undocumented. If the hyphen is rejected, every order fails at
  submission — loudly, and before anything executes, but it fails.
- That a filled market order's id is reliably addressable at `/trades/@id`. The
  two-place lookup is built on this. It is documented behaviour, but documented
  is not observed.
- That the stub's response shapes match what the venue actually sends. They were
  written from OANDA's published documentation — the same source that would be
  wrong in the same way.
- Anything about latency, rate limiting, or behaviour under a real disconnection.

### Running the live suite

`services/desk/src/broker/oanda/oanda.live.test.ts` exists to close that gap. It
needs an OANDA practice account, which is free:

```sh
KEEL_OANDA_TOKEN=... KEEL_OANDA_ACCOUNT_ID=101-004-XXXXXXX-001 \\
  pnpm --filter @keel/desk test:live
```

That runs the read paths — connect, account, instruments, pricing, and a lookup
for an id that was never sent, which must return positive evidence of absence.
Adding `KEEL_OANDA_LIVE_EXECUTION=true` also opens and closes a **one-unit**
EUR/USD position with an attached stop, then asserts the client id is
addressable afterwards. One unit is about a dollar of notional: enough to prove
the round trip, not enough to be a position.

The suite refuses to run against the live environment at all.

**Nothing here may be upgraded to "live verified" until that suite has been run
and passed.** It was written in an environment with no OANDA credentials, so the
author could not run it.

### Defects found while building this adapter

All three were found by reading the code adversarially after it had passed its
first tests — not by the tests themselves.

| Defect | Consequence had it shipped |
| --- | --- |
| `findByClientOrderId` treated any definite HTTP status as evidence of absence | A rotated token returns 401 on every lookup. The resolver would have concluded every in-flight order was never placed — and because this adapter declares retry safe, the engine would have been free to re-send all of them. |
| A lookup that found the order but failed to map it fell through and reported absence | The venue plainly has the order. Failing to parse it is our defect, and it would have been reported as the order not existing. |
| The stream announced "reconnected" after the backoff sleep, before reopening | The desk would report itself connected while it was not, and catch-up ran before the subscription existed — leaving a window in which a fill could be missed entirely. |

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
| Self-review | OANDA `findByClientOrderId` read any definite HTTP status as evidence of absence, so a rotated token would report every in-flight order as never placed | Severe |
| Self-review | An OANDA order that was found but could not be mapped fell through and was reported absent | Severe |
| Self-review | The OANDA stream announced "reconnected" before it had reopened, and caught up before subscribing | Moderate |
| Self-review | `test:live` and `test:chaos` used an unquoted `src/**/*` glob, which the shell expands to a single directory level — so the OANDA live suite existed but the documented command never ran it | Moderate |
| Architecture review | The reference price plane was Crypto.com, which cannot price XAUUSD or EURUSD — so the divergence monitor could never have fired for any instrument actually being traded. Latent since ADR-0013, independent of the venue change | Severe |

The pattern worth noting: **example-based tests found almost nothing.** Property
tests, randomized chaos, and reading the code adversarially found everything
severe. Four of the five audit findings were code that typechecked, read
correctly, and did the wrong thing.

The OANDA findings repeated the pattern exactly. All three arrived after the
adapter had passed its first forty tests, and all three came from re-reading it
looking for trouble rather than from anything the suite was already asserting.
Two of them turned on the same question — *what is this response actually
evidence of?* — which is the question this entire system is organised around,
and which was still easy to get wrong twice in one function.

## Known gaps, stated without hedging

1. **The production venue has no adapter at all.** LiteFinance/MT5 is stage 1 of
   9 — designed and reviewed, not written. The OANDA adapter is thoroughly
   tested but is no longer the production target, and a stub written from the
   same documentation as its adapter could not have disproved a misreading of
   that documentation anyway. This is the single largest gap and it is now
   larger than it was before the pivot, which the score in `BENCHMARK.md`
   reflects honestly (36 of 100 delivered against a design that targets 85).
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

1. The OANDA live suite run against a real practice account and passed —
   including the execution round trip — then a deliberate mid-submit
   disconnection to confirm the `UNKNOWN` path works against the real API, and
   not merely against a stub that shares my assumptions.
2. The mobile app built with EAS and run on the operator's own device, with the
   order ticket exercised end to end against the demo account.
3. A real push delivered to that device, and the delivery receipt confirmed.
4. The enclave signer implemented, or a conscious decision recorded to accept a
   Keychain-held key.
5. At least one full trading day run against demo, with the guard's daily-loss
   limit deliberately tripped to confirm it flattens and locks out unattended.
6. A ledger backup taken and **restored**, proving the recovery path.

Nothing in this repository claims any of those have happened.
