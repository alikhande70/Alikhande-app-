# Build report — `gpt/trading-brain-build`

This file records implementation that actually exists on the branch. ADRs describe the intended architecture; this report deliberately separates repository verification from Windows/MetaEditor/MT5/LiteFinance verification.

## Current state — 2026-08-27

The repository-level MT5 foundation is substantially built and fail-closed. Real broker execution remains deliberately disabled because `OrderSend`/`OrderSendAsync` are absent. Work has now begun on **ADR-0018 — Trade Mission**, which must become the durable data spine before any Trading Brain, memory, or evaluation implementation is allowed to influence the product.

The preserved branch `claude/personal-trading-app-atm6e1` is untouched.

## MT5 execution foundation — implemented and repository-verified

- Versioned loopback protocol between the Windows execution host and `KeelAgent.mq5`.
- Authenticated agent sessions, heartbeat/liveness checks, bounded UTF-8 framing, event ordering protection and stale-agent epoch handling.
- MT5 64-bit identifiers remain decimal strings across JavaScript boundaries.
- Durable command lifecycle and recovery model: `RECEIVED → CHECKED → SENT → RESULT`, with post-`SENT` ambiguity requiring reconciliation rather than automatic retry.
- Demo-only `OrderCheck` preflight. Successful preflight is **not** execution evidence.
- `OrderSend` and `OrderSendAsync` remain absent.
- Strict fail-closed snapshot parsing and bounded authoritative snapshot/reconciliation scans.
- Reconciliation distinguishes orders, deals and positions; order-only evidence cannot prove a fill.
- Historical rejected/cancelled/expired orders cannot masquerade as execution.
- Multiple deals belonging to one position are aggregated correctly; multiple distinct executions under one intent are treated as contradiction/duplicate rather than collapsed.
- Explicit MT5 venue-symbol ↔ canonical mapping with collision rejection and no suffix-stripping/fuzzy identity guessing.
- Raw `instrumentFacts` are consumed by the binding layer; semantic metadata that MT5 cannot prove is supplied explicitly or the instrument is refused.
- Configured tradable-symbol universe no longer depends on having an already-open position/order.
- MT5 runtime is reachable through `KEEL_BROKER=mt5`.
- Adapter capabilities describe the current build rather than theoretical MT5 capabilities.
- Durable agent event spool replay is present for undelivered hints; reconciliation remains authoritative truth.
- Broker/desk clock-domain guard prevents broker-local wall-clock values from being mistaken for UTC elapsed time.
- Request-specific Margin path exists end-to-end in repository code:
  `ExecutionSupervisor → BrokerPort → MT5 adapter → HostClient → HTTP execution host → Agent → OrderCalcMargin`.
- Margin is tied to the specific proposal and validated for request identity/freshness. Missing, stale, malformed or unavailable margin is **BLOCK**, never zero, and cannot be waived by break-glass override.
- Real-account safety remains explicitly gated; no real-money execution is enabled or claimed.

## Important MT5 defects already closed

| Severity | Defect closed |
| --- | --- |
| P0 | Exact-magic reconciliation could collapse multiple distinct executions into one clean fill. |
| P0 | Broker-local and UTC clock domains were mixed, breaking absence/recovery reasoning. |
| P0 | Future-dated heartbeat could make a dead agent appear live. |
| P0 | Unknown margin could become `0.00`, silently disabling the free-margin check. |
| P0 | Evidence grouping could collide `positionId` and ticket namespaces. |
| P1 | Multi-deal partial fills could understate filled quantity. |
| P1 | Two venue symbols could collapse to one canonical and contaminate quote/sizing identity. |
| P1 | Definitive MT5 rejection retcodes 10040–10046 fell through to unresolvable UNKNOWN. |
| P1 | `instrumentFacts` existed as dead data while the runtime instrument source was empty. |
| P1 | MT5 adapter existed but was unreachable from normal Desk runtime configuration. |
| P1 | Execution capabilities were aspirational instead of truthful. |

Safety fixes were consolidated so they are not stranded on parallel branches.

## Test infrastructure regression closed

Making Margin request-specific turned order preparation into a deeper async chain. The virtual test clock previously yielded only two microtask turns before deciding no virtual task existed, so 40 execution/guard/chaos tests later timed out in wall-clock time even though the production logic was not deadlocked.

`TestClock.settle()` now gives bounded pure-microtask chains time to schedule their next virtual-clock operation, still fails explicitly if a promise is genuinely stalled, and preserves deterministic virtual-time ordering.

Exact commit `699d35eb7acca968c44e1de3276d6ad798f7e231` passed the full GitHub Actions `verify` workflow after this repair.

## ADR-0018 Trade Mission — first durable slice implemented

The Mission layer is intentionally **above** execution truth. It may reference order intents and broker positions, but it never replaces the order ledger or fabricates broker state.

Implemented:

- Mission stages: `OBSERVED`, `CANDIDATE`, `PLANNED`, `ARMED`, `EXECUTING`, `MANAGING`, `CLOSED`, `ABANDONED`, `REVIEWED`.
- Mission origins include Brain observation, Android/Desktop operator action, manual MT5, pending activation and unknown external origin.
- Every Mission fact is stored on the existing append-only hash-chained ledger; there is no second mutable source of truth.
- Durable Mission events:
  - `mission.observed`
  - `mission.snapshotSealed`
  - `mission.stageChanged`
  - `mission.intentLinked`
  - `mission.positionLinked`
  - `mission.actionRecorded`
  - `mission.reviewed`
- `MissionObservation` stores both market **valid time** (`observedAt`) and the ledger provides transaction/recorded time, establishing the first bitemporal spine.
- Scan configuration version is stamped on observations so later statistics can remain cohort-aware.
- `DecisionSnapshot` explicitly records both `known` and `missing` information and is immutable once sealed.
- A planned mission cannot exist without a sealed Decision Snapshot.
- An untraded/rejected setup cannot be abandoned without preserving a Decision Snapshot; rejected setups therefore remain evaluation data rather than disappearing.
- Execution stage requires a linked order intent, while Mission itself never writes execution/order truth.
- External/manual MT5 positions can be adopted directly into `MANAGING` with no fabricated Decision Snapshot; this structurally prevents them from being credited to a Brain version.
- Mission reviews store decision assessment separately from optional outcome/counterfactual evidence.
- Lifecycle actions have stable action ids so client replay is idempotent.
- Reducer replay validates state transitions itself; malformed direct ledger histories cannot bypass service-layer transition rules.
- Existing projection rebuild verification remains compatible with Mission ledger events.

Current Mission implementation is still **PARTIAL**: runtime wiring, automatic foreign-position adoption from broker events, server query/API surfaces, scan ingestion path, shared Android/Windows Mission UX, and order/position lifecycle auto-linking are not yet complete. Trading Brain work must remain blocked until this spine is wired through the real runtime.

## Current repository verification

- MT5/TestClock foundation commit `699d35e...`: GitHub Actions `verify` **PASS**.
- Current Mission exact head before this documentation update: `27f7802ba19c59a3f3cd8c8c7dae22abfc505e43`; GitHub Actions `verify` **PASS** (lint, typecheck and test).
- Documentation-only commit created after that verification must receive its own exact-head CI result before being called green.

Repository CI proves TypeScript/static/test behavior only. It does **not** prove MQL compilation or target-terminal behavior.

## External verification boundary — still NOT VERIFIED

The following require the Windows environment and remain explicitly unverified:

- MetaEditor compilation of `KeelAgent.mq5` and included `.mqh` files;
- EA attach/runtime behavior inside the real MT5 terminal;
- actual `TimeGMT`, `TimeTradeServer`, `SymbolSelect`, file/spool and flush behavior on the target terminal build;
- actual `OrderCheck` and `OrderCalcMargin` behavior on LiteFinance Demo;
- exact LiteFinance symbol aliases, filling modes and account position model;
- EA/host/terminal restart and reconnect against real broker state;
- end-to-end App → Desk → execution host → EA → MT5 → LiteFinance → reconciliation;
- any `OrderSend` behavior, because sending is deliberately not implemented yet.

No real-money execution is enabled or claimed.

## Verification ladder

| Stage | Status | Evidence / remaining work |
| --- | --- | --- |
| Architecture ADR-0015–0022 | **DONE** | Accepted architecture and design critique exist. |
| Repository MT5 foundation | **SUBSTANTIALLY DONE** | Instrument truth, request-specific Margin, recovery/reconcile hardening and runtime host wiring built; real terminal proof remains. |
| Repository lint/typecheck/tests | **PASS at last exact code head** | `27f7802...` passed full `verify`; current documentation head still needs its own CI run. |
| Simulation/chaos | **STRONG, NOT COMPLETE** | Duplicate/recovery/clock/partial-fill/margin paths covered; real EA restart boundary still external. |
| Trade Mission spine | **IN PROGRESS** | Durable domain/events/state machine/tests built; runtime/query/device wiring remains. |
| Trading Brain | **DESIGNED ONLY** | Must wait for Mission exit criteria. |
| Memory/Evaluation | **DESIGNED ONLY** | Must wait for Mission + deterministic Brain facts. |
| MetaEditor compile | **NOT VERIFIED** | Requires Windows. |
| Real MT5 terminal | **NOT VERIFIED** | Requires target terminal. |
| LiteFinance Demo E2E | **NOT VERIFIED** | Requires stages above. |

## Next highest-priority sequence

1. Make the Mission service part of the real Desk runtime rather than a library-only aggregate.
2. Automatically create/adopt Missions for foreign/manual MT5 positions without inventing a Decision Snapshot.
3. Add explicit Mission linkage to internal intents/positions while keeping execution truth independent of Mission success/failure.
4. Add server-side Mission query/API/realtime surfaces so Android and Windows observe the same authoritative Mission state.
5. Add a real scan-ingestion path so **every scan**, including low-score/rejected/non-executed setups, creates durable Mission evidence.
6. Add runtime lifecycle tests and restart/replay tests for those paths.
7. Only after ADR-0018 exit criteria are met, begin ADR-0019 deterministic/versioned Trading Brain.
8. Do not enable Demo `OrderSend` until Windows/MetaEditor/real MT5 read-only validation establishes the external execution foundation.
