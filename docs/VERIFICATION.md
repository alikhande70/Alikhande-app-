# Verification status

> This document is the honesty boundary for the repository. It records what has actually been implemented and exercised. Architecture intent is not counted as delivery, source-level tests are not a substitute for MetaEditor compilation, and nothing is described as broker-verified before it has run against the real target environment.

**Last updated:** 2026-08-26 on `gpt/trading-brain-build` after the demo-only MT5 `OrderCheck` preflight was wired and CI passed at `035b239f28d5f6a256c632f12598d3f613a8163a`.

## Verification vocabulary

| Level | Meaning |
| --- | --- |
| **Implemented** | Code exists and passes the repository's static/type checks where those tools apply. |
| **Unit tested** | Behaviour is asserted off-network. |
| **Property tested** | Invariants are asserted across generated inputs. |
| **Integration tested** | Real assembly boundaries are exercised against simulated dependencies. |
| **Chaos tested** | Seeded failure/restart/duplication scenarios are exercised. |
| **Real terminal tested** | MQL5 compiled and exercised in a real MetaTrader 5 terminal. |
| **Broker demo verified** | Exercised against LiteFinance demo through the real MT5 terminal. |
| **End-to-end verified** | Android/Desktop → desk/core → MT5 → broker → reconciliation verified as one path. |
| **Not verified / externally blocked** | Written or designed, but the required environment/evidence is unavailable. |

## Trading core (`packages/core`)

Core deterministic arithmetic, sizing, risk, order-state and reconciliation remain covered by unit/property tests. Important invariants include exact decimal handling, monotonic filled quantity, terminal-state safety, idempotent fills, FX conversion freshness, position sizing, portfolio/risk gates and reconciliation of externally-created exposure.

## Desk service (`services/desk`)

The desk has integration/chaos coverage for its append-only ledger, projections, execution supervisor, unknown-outcome resolver, reconciler, guard daemon, paper venue, authenticated HTTP/WebSocket surface and mobile signing contract. Its central execution rule remains: **a transport failure is ambiguity, never evidence of rejection, and one negative lookup is never enough to prove an order absent.**

## Market data

Crypto.com public market-data paths have previously been exercised live from the build environment. Aggregation, staleness, divergence and synthetic paths have unit coverage. This does **not** validate LiteFinance prices or MT5 execution behaviour.

## Broker adapters

| Adapter | Current status | Evidence / limit |
| --- | --- | --- |
| `PaperBroker` | Chaos tested | Simulation substrate for execution/recovery tests. |
| **LiteFinance / MT5** | **Implementation in progress; unit/source-safety tested** | Production target. Adapter, host contract, authenticated local agent bridge, idempotency/recovery evidence logic, command validation, lifecycle model, durable receipt and demo-only `OrderCheck` preflight now exist. No `OrderSend` path exists yet. MQL5 has not been compiled in MetaEditor here. |
| OANDA v20 | Integration tested reference adapter | Not the production venue. Retained as reference/control code; no claim that it validates MT5. |
| MetaApi | Rejected | Third-party credential custody is outside the selected production architecture. |

## MT5 verification ladder

Nothing may be described as broker-verified before stage 7.

| # | Stage | Status |
| --- | --- | --- |
| 1 | Architecture reviewed | **Done** — ADR-0015/0016/0017 plus adversarial design review. |
| 2 | Implementation complete | **In progress** — adapter + host wire contract + authenticated EA bridge + command validation + durable `RECEIVED` + demo-only place-order preflight/`CHECKED`/`RESULT` exist. Still missing demo send, authoritative snapshot/reconcile, lifecycle spool replay/watermarks, cancel/modify/close execution and final host assembly. |
| 3 | Unit tested | **In progress** — TypeScript logic and repository source-safety contracts pass CI. MQL5 runtime behaviour is not established by these tests. |
| 4 | Integration tested | **Not complete** — desk/socket pieces have simulated tests, but the complete EA ↔ desk execution path has not been exercised with a compiled EA. |
| 5 | Failure / chaos tested | **Not complete** — desk recovery logic has chaos coverage; EA crash boundaries and spool recovery still need compiled/runtime testing. |
| 6 | Real MT5 terminal tested | **Not started / externally blocked here** — requires MetaEditor + Windows MT5. |
| 7 | LiteFinance demo account tested | **Not started / externally blocked here**. |
| 8 | Restart / reconnect recovery tested | **Not started against real MT5/LiteFinance**. |
| 9 | End-to-end Android + Desktop → core → MT5 → broker → reconciliation | **Not started**. |

### MT5 implementation that is currently real code

- `services/desk/src/broker/mt5/identity.ts`: stable client intent → MT5 magic identity support.
- `retcodes.ts`: immediate MT5 result classification without treating submission as fill proof.
- `evidence.ts`: evidence-based reconciliation; weak fingerprint matches remain indeterminate.
- `host-types.ts` / `host-client.ts`: exact-decimal and 64-bit-safe host contract.
- `adapter.ts`: `BrokerPort` implementation around the host; real accounts fail closed by default.
- `agent-protocol.ts`, `agent-session.ts`, `agent-server.ts`: authenticated loopback agent transport with framing, sequence handling and disconnect ambiguity.
- `command-validation.ts`: strict desk-side command schema validation.
- `command-lifecycle.ts`: reference `RECEIVED → CHECKED → SENT → RESULT` recovery semantics.
- `mt5/KeelAgent.mq5`: EA bridge, heartbeat, transaction observation, command receive, durable receipt and demo-only command gates.
- `mt5/KeelOrderCheck.mqh`: independent EA-side place-order parsing, request construction, filling-mode selection and `OrderCheck` preflight. A passed check is deliberately returned as **execution not enabled**, not as an acknowledgement/fill.

### Current hard safety boundaries

1. **No `OrderSend` or `OrderSendAsync` exists in the EA.** The new preflight cannot place a trade.
2. Place-order preflight requires an MT5 **demo** account plus connected/trade-enabled terminal state.
3. The raw command is durably flushed before the EA advances to preflight.
4. `CHECKED` and terminal `RESULT` records are durably appended for the place-order preflight path.
5. A replayed request id is not executed again; it requires reconciliation.
6. Snapshot/reconcile are still returned as unavailable rather than fabricating empty account truth.
7. `maxSlippage` is currently rejected by the EA because the wire request has no explicit reference-price semantics. Silently ignoring it or mapping it to MT5 deviation would create a false risk guarantee.
8. Passing `OrderCheck` is **not** treated as proof that a later order will execute.

### What is verified in this build environment

Repository Verify completed successfully for commit `035b239f28d5f6a256c632f12598d3f613a8163a`. The source-safety test asserts that:

- command receive is bounded;
- durable receipt precedes the place-order preflight;
- the preflight is demo-gated;
- `OrderCheck` is wired;
- `CHECKED`/`RESULT` journal markers exist;
- unsupported slippage semantics are rejected explicitly;
- no `OrderSend`/`OrderSendAsync` has appeared;
- snapshot/reconcile are not faked.

This establishes the repository contract. It does **not** establish that MQL5 compiles or behaves correctly in MetaTrader.

### External facts still unverified

Only a real LiteFinance demo environment can settle:

- exact symbol names/suffixes;
- account hedging vs netting mode;
- permitted filling modes per instrument;
- server timezone/DST behaviour;
- pending-order/magic preservation behaviour;
- broker-specific minimum distances, freezes and execution retcodes;
- actual `OrderCheck`, `OrderSend` and `OnTradeTransaction` sequences under LiteFinance;
- disconnect/restart behaviour of the real terminal.

## Mobile application

Signing, realtime state, HTTP retry semantics, store safety and chart geometry have automated coverage. The Android UI has not been validated here on a physical device/simulator, and the native secure-enclave bridge remains an external implementation/verification item.

## Defects found by independent audit of the MT5 path

Reviewed as another team's work. The foundation held up — identity derivation,
the command lifecycle, and the refusal to treat `OrderSend` as proof of fill are
all correct. Five defects were not, and every fix below has a regression test
that was verified to fail without it.

| Defect | Consequence had it shipped | Severity |
| --- | --- | --- |
| `inspectMt5Observation` returned `confirmed` for any number of exact-magic matches | One intent legitimately produces an order, deals and a position all sharing the magic, so only the count of *distinct executions* is meaningful. The fingerprint path grouped by position before deciding; the exact-magic path did not — so the weaker evidence was the better guarded, and a duplicate execution surfaced as one clean fill with the second position stranded | **Severe** |
| Agent emitted `TimeTradeServer()*1000` where the desk expected UTC | Broker-local time (GMT+2/+3 for LiteFinance) compared against UTC ledger stamps in fingerprint matching, history coverage and submit timestamps. A server *ahead* of UTC makes history never cover the send window, so no ambiguous send is ever resolvable; a server *behind* UTC makes coverage pass trivially and permits **false absence** for an order that exists | **Severe** |
| `isLive()` used `now - at <= staleMs` | A heartbeat stamped three hours ahead gives a *negative* age that passes the staleness test trivially, so a dead agent read as live for the length of the broker's timezone offset. ADR-0016 requires agent absence to be actively detected; this silently defeated it | **Severe** |
| Recovery used `matches[0].volume` as filled quantity | A position filled by two deals reported 0.01 of 0.03 — a third of the risk actually held | High |
| Retcodes 10040–10046 absent from classification | LIMIT_POSITIONS, REJECT_CANCEL, LONG_ONLY, SHORT_ONLY, CLOSE_ONLY, FIFO_CLOSE and HEDGE_PROHIBITED fell through to ambiguous: safe, but a permanently unresolvable UNKNOWN for a request the server had definitively declined | Medium |

The pattern is worth noting. Three of the five are the same mistake in different
places: **a value crossing a boundary carried an assumption the other side did
not share** — that a match count means an execution count, that a timestamp is
UTC, that a difference is positive. None would have been caught by a test that
only exercised the happy path, and all five typechecked.

`clock-domain.ts` exists specifically so the second and third cannot return
quietly: any agent reading that cannot be UTC now fails a test rather than
corrupting recovery months later.

---

## Known gaps — current priority order

1. **MQL5 has not been compiled in MetaEditor.** Source inspection and CI cannot close this gap.
2. **No broker-side send path exists yet.** This is deliberate until `SENT` can be persisted immediately before the irreversible call and recovery semantics are complete.
3. **Authoritative EA snapshot/reconcile is not implemented.** Active positions/orders plus relevant history must be read from MT5; empty data must never be manufactured on failure.
4. **EA event/command spool replay and acknowledgement/watermarking are incomplete.** A restart must not lose evidence or replay side effects.
5. **Cancel/modify/close remain disabled in the EA.**
6. **LiteFinance demo has not been exercised.** No production-readiness or broker-verification claim is allowed.
7. **Mobile/Desktop visual/runtime validation remains incomplete.**
8. **Trading Mission and intelligence implementation follows only after the MT5 truth path reaches the agreed gate.** ADR-0018–0022 are accepted design, not delivered intelligence features yet.

## Next verification gate

The next implementation gate is not “turn on trading”. It is:

1. make `SENT` a durable EA record immediately before an eventual broker call;
2. add a demo-only `OrderSend` boundary whose immediate return is classified but never treated as fill truth;
3. reconcile the result from authoritative MT5 orders/deals/positions/history;
4. add restart/disconnect tests around every lifecycle boundary;
5. only then compile in MetaEditor and proceed to a real MT5/LiteFinance demo terminal.

Until those gates pass, the system remains **development/demo-only and not broker-verified**.
