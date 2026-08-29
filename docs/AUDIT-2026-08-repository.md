# Independent repository audit — MT5 execution foundation

Audited `gpt/trading-brain-build` at `bfdf20e` as another team's work. Fixes are on
`claude/audit-2026-08`. No Windows, MetaEditor, MT5 terminal or LiteFinance access was
available, and nothing in this document claims otherwise.

---

## 1. Executive verdict

| Dimension | Score | Basis |
| --- | --- | --- |
| Architecture | **86** | ADR-0015/0016 are followed closely. Events-as-hints, reconciliation-as-truth, magic-as-identity and fail-closed validation are all implemented as designed. |
| Implementation quality | **78** | Strict parsers, decimal strings on every 64-bit boundary, loopback-only transport, timing-safe tokens. Marred by dead wiring and a formatting failure on the branch head. |
| Execution safety | **72** → **84** after fixes | Order-only evidence correctly refuses to prove a fill. Two duplicate/attribution defects were open; both now closed. |
| Recovery correctness | **65** → **82** after fixes | The clock-domain defect broke the arithmetic that all recovery depends on. |
| Test strength | **70** | Real negative tests and four genuine chaos scenarios. But three severe defects survived 365 green tests. |
| Maintainability | **80** | Small, single-purpose modules; good comments. Some duplicated evidence logic. |
| **Readiness for real MT5 validation** | **58** | Blocked less by defects than by the instrument path being unwired and `OrderSend` absent by design. |

**The single most important finding is not a bug.** All four defects I reported in my
previous session — three severe — were still present on this branch. My fixes lived on
`claude/mt5-execution-hardening` and were never merged. Parallel branches are silently
losing safety work.

---

## 2. P0 findings

### P0-1 · Duplicate execution reported as a clean fill — **FIXED**

**Where:** `services/desk/src/broker/mt5/observation.ts`, exact-magic branch.

`executionEvidence.length > 0` returned `confirmed` regardless of how many *distinct
executions* carried the magic. One intent legitimately produces several deals and a
position all sharing the magic, so an object count proves nothing.

**Failure scenario:** an ambiguous send is retried and both reach the venue. Reconcile
finds two positions with our magic. The adapter takes `matches[0]` and reports one clean
`FILLED` order. The operator sees half their real exposure, and the second position is
invisible until it moves the account.

**Why tests missed it:** every fixture contained exactly one execution. The fingerprint
path *did* group by position — so the code demonstrated it knew the rule, and applied it
only to the weaker evidence.

**Fix:** group by `positionId` before confirming; `duplicate` is now its own verdict, and
the adapter returns `indeterminate` naming the tickets rather than attributing one.

### P0-2 · Broker and desk clock domains mixed — **FIXED**

**Where:** `mt5/KeelAgent.mq5` (`TimeTradeServer()*1000`), consumed by
`observation.ts` fingerprint matching, history coverage, and `agent-session.ts` liveness.

The agent stamped everything in the broker's wall clock. LiteFinance runs GMT+2/+3. The
desk stamps its ledger in UTC. Every comparison between them measured a timezone offset
instead of elapsed time.

**Failure scenario, server ahead of UTC (the LiteFinance case):** `historyFrom` is ~3h
ahead of the required window, so coverage never satisfies and **no ambiguous send is ever
resolvable** — every one escalates forever. **Server behind UTC:** coverage passes
trivially while the fingerprint still cannot match, so the system can conclude **false
absence** for an order that exists, which is the one outcome that permits a duplicate.

**Why tests missed it:** the test helper defaulted `at = Date.now()`, so every fixture was
accidentally in the desk's own domain. The bug is invisible unless a fixture is
deliberately offset.

**Fix:** the agent now sends `TimeGMT()` with `serverMillis` and `serverUtcOffsetSec`
alongside. `clock-domain.ts` rejects any reading that cannot be UTC — tolerance is 5
minutes, far below the smallest real timezone offset, so broker-local time can never pass.

### P0-3 · A dead agent read as live for the timezone offset — **FIXED**

**Where:** `agent-session.ts` `isLive()`.

`now - heartbeat.at <= staleMs` with a heartbeat stamped 3h ahead gives a *negative* age,
which passes trivially. The agent could be dead for three hours and still report live,
so commands would be accepted against a terminal that was not there.

ADR-0016's amendment requires agent absence to be actively detected. This silently
defeated it.

**Fix:** the clock guard disables the session outright (primary fix), and `Math.abs` on
the age is defence-in-depth. Verified by isolation: removing `Math.abs` alone changes
nothing while the guard stands; removing both fails three tests.

---

## 3. P1 findings

### P1-1 · Partial fills understated position size — **FIXED**

`adapter.ts` used `verdict.matches[0].volume` as `filledQty`. A position filled by two
deals reported 0.01 of 0.03. Now prefers the position aggregate, else sums deals with a
volume-weighted average price.

### P1-2 · Two venue symbols could collapse to one canonical — **FIXED**

`Mt5SymbolMap` enforces one-to-one only across *configured* aliases. An unconfigured
symbol falls back to the host-declared canonical, so a terminal carrying both `XAUUSD`
and `XAUUSD.x` — each declaring canonical `XAUUSD` — yields two specs with one identity.
Nothing deduplicated them, and `getQuote` resolves by **first match**, so sizing would
price one instrument off the other's book with the winner decided by array order.

`toInstrumentSpecs` now fails the whole batch on collision. A collision is a
configuration error for the operator to resolve, not something to pick a winner for.

### P1-3 · Retcodes 10040–10046 fell through to ambiguous — **FIXED**

`LIMIT_POSITIONS`, `REJECT_CANCEL`, `LONG_ONLY`, `SHORT_ONLY`, `CLOSE_ONLY`,
`FIFO_CLOSE`, `HEDGE_PROHIBITED` were absent. Safe direction, but each produced a
permanently unresolvable UNKNOWN for a request the server had definitively declined.
(Worth noting: my own recollection of these numbers was wrong — 10042 is `LONG_ONLY`,
not 10040. Checked against the MQL5 reference rather than asserted.)

### P1-4 · `instrumentFacts` is dead data — **FOUND, NOT FIXED**

`KeelSnapshot.mqh` emits `"instruments":[]` unconditionally and publishes real venue
facts under a separate `instrumentFacts` key. `snapshot-validation.ts` parses and
validates that key — and **nothing consumes it**. Meanwhile `getInstruments()` maps over
the always-empty `instruments`.

Against a real terminal the desk therefore has **no instrument specs at all**. This is
fail-closed (sizing cannot proceed) rather than dangerous, and `BUILD-REPORT.md` already
declares it at line 46. But the newest five commits built a parallel channel and did not
wire it, so the binding layer is currently binding nothing.

Not fixed here because the correct wiring depends on the margin decision below, and
guessing at it would be exactly the kind of shortcut this audit exists to prevent.

### P1-5 · `InstrumentSpec.marginRate` is not MT5 truth — **FOUND, NOT FIXED**

A single static scalar cannot express MT5 margin. Required margin is request-specific and
depends on order type, volume, price and the account's current state; MT5 exposes it
through `OrderCalcMargin`. The EA correctly refuses to synthesise one — but the desk-side
type still *requires* `marginRate`, so any future wiring is under pressure to invent a
value to satisfy the type.

**Recommended migration**, safest first:
1. Make `marginRate` optional on the MT5 path and have sizing **refuse** margin-sensitive
   decisions when it is absent, rather than defaulting.
2. Add a `calcMargin` command to the agent protocol returning `OrderCalcMargin` for a
   concrete proposed request.
3. Treat the result as a per-request fact carried on the decision, never cached as an
   instrument property.
4. Only then allow margin-aware sizing, and only when the value is fresh.

---

## 4. P2 findings

- **Branch head failed its own gate.** `pnpm verify` was red on `bfdf20e` from a Biome
  formatting error in `snapshot-validation.ts`. CI runs the same command, so the head was
  pushed red. Fixed.
- **Evidence logic is duplicated** between `evidence.ts` and `observation.ts` with subtly
  different rules — `evidence.ts` is currently unused by the adapter path. Divergence
  between two copies of the absence rule is a future correctness bug.
- **`g_seen_request_ids` grows without bound** in the EA with linear lookup. Fine at
  personal volume; worth a bounded structure before long uptimes.
- The `confirmed` evidence string counts objects, not executions, so it can read
  "2 execution object(s)" for one execution. Cosmetic but misleading in an audit trail.

---

## 5. False confidence audit

`BUILD-REPORT.md` is **more honest than expected** and I want to record that: it already
declares `instruments: []`, the margin-rate problem, and the unverified external stages.
It does not overclaim.

Two things could still mislead:

- Line 33 states the binding is "wired through instruments, positions, orders, quotes,
  order submission and recovery". True of the binding *code*, but the instruments source
  is always empty, so that surface is currently vacuous.
- 365 green tests read as strong coverage. Three severe defects survived them, all in the
  same blind spot: **fixtures that were accidentally in the desk's own clock domain and
  contained exactly one execution**.

---

## 6. Test gaps

Required before demo execution:

1. Fixtures with a **deliberate broker/UTC offset** on every time-comparing test.
2. Two-execution fixtures for every attribution path.
3. Partial-fill fixtures (multi-deal, one position) across snapshot, reconcile, recovery.
4. Red-team timelines not yet covered: restart between SENT and RESULT persistence with a
   real spool replay; pending-order activation with no client attached; manual MT5 trade
   whose symbol/side/volume match a live intent within the send window.
5. A property test asserting **no observation input can yield `negative` while any
   candidate carries the expected magic**.
6. Concurrency: two clients issuing the same mission, and a client disconnecting after
   command acceptance.

---

## 7. Next implementation sequence

1. **Merge safety work into one branch.** Nothing else matters while fixes are lost
   between branches.
2. Wire `instrumentFacts` → `instruments` and delete the dead key (P1-4).
3. Make `marginRate` optional and refuse margin-sensitive sizing without it (P1-5 step 1).
4. Unify `evidence.ts` and `observation.ts` on one absence rule.
5. Add `calcMargin` to the agent protocol.
6. EA snapshot/reconcile handlers returning real state.
7. Demo-only `OrderSend` behind the existing account gate, with the spool replay proven.
8. Chaos suite for the eight red-team timelines.

---

## 8. Windows / MT5 validation checklist

For the day desktop access returns. **None of this has been performed.**

- [ ] MetaEditor compiles `KeelAgent.mq5` with zero errors and zero warnings
- [ ] EA attaches to a chart; `Keel\` spool files are created
- [ ] Verify `TimeGMT()` vs `TimeTradeServer()` — record the actual LiteFinance offset
- [ ] Confirm the desk accepts the heartbeat (clock guard passes)
- [ ] Kill the EA; confirm the desk reports no-execution-path within the stale window
- [ ] LiteFinance Demo login; confirm `ACCOUNT_TRADE_MODE` reads `demo`
- [ ] Confirm a Real account is refused by the gate
- [ ] Record actual symbol names and suffixes; configure aliases explicitly
- [ ] Record `OrderCheck` output for a valid and an invalid request
- [ ] **Verify magic survives**: place one demo order, confirm `POSITION_MAGIC`,
      `DEAL_MAGIC` and history all carry it — and specifically through a pending-order
      activation
- [ ] Lost-response test: kill the socket between SENT and RESULT; confirm UNKNOWN then
      reconciliation
- [ ] EA restart mid-lifecycle; confirm spool replay and no duplicate send
- [ ] Host restart; terminal restart; reconnect
- [ ] Manual MT5 trade alongside; confirm it is reported and **not** attributed
- [ ] Cancel / modify / close paths
- [ ] Partial fill if reproducible
- [ ] Collect evidence: spool files, desk ledger, MT5 journal, screenshots

---

## 9. Final red-team verdict

**If I had to trust this with a Demo account today, what would stop me?**

Three things, in order.

**The instrument path is not connected.** `getInstruments()` returns empty against a real
terminal, so nothing can be sized. This is safe — it fails closed — but it means the
system cannot place a correctly-sized order at all. That alone ends the question.

**Margin is not modelled.** Until `OrderCalcMargin` exists per request, any
margin-sensitive sizing rests on a scalar MT5 does not actually provide.

**Nothing has met a compiler.** `KeelAgent.mq5` has never been through MetaEditor. The
`TimeGMT()` change I just made is asserted from documentation, not observed. An EA that
does not compile is not a safety property, it is a file.

What would *not* stop me is the execution-truth core. Ambiguity classification, absence
evidence, order-state handling and the command lifecycle are genuinely well built, and
after the six fixes here I believe the attribution logic is sound. The foundation is
trustworthy. What sits on top of it is not yet connected.
