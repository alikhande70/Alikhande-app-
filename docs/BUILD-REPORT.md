# Build report — `gpt/trading-brain-build`

This file records implementation that actually exists on the branch. ADRs describe the intended architecture; this report deliberately separates repository verification from Windows/MetaEditor/MT5/LiteFinance verification.

## Current state — 2026-08-27

The repository-level MT5 foundation is substantially built and fail-closed. Real broker execution remains deliberately disabled because `OrderSend`/`OrderSendAsync` are absent. Work is now on **ADR-0018 — Trade Mission**, which must become the durable data spine before any Trading Brain, memory, or evaluation implementation is allowed to influence the product.

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

## ADR-0018 Trade Mission — durable runtime spine in progress

The Mission layer is intentionally **above** execution truth. It may reference order intents and broker positions, but it never replaces the order ledger or fabricates broker state.

Implemented:

- Mission stages: `OBSERVED`, `CANDIDATE`, `PLANNED`, `ARMED`, `EXECUTING`, `MANAGING`, `CLOSED`, `ABANDONED`, `REVIEWED`.
- Mission origins include scanner, Brain observation, Android/Desktop operator action, manual MT5, pending activation and unknown external origin.
- Every Mission fact is stored on the existing append-only hash-chained ledger; there is no second mutable source of truth.
- Durable Mission events: `mission.observed`, `mission.snapshotSealed`, `mission.stageChanged`, `mission.intentLinked`, `mission.positionLinked`, `mission.actionRecorded`, `mission.reviewed`.
- `MissionObservation` stores market **valid time** (`observedAt`) while the ledger supplies transaction/recorded time, establishing the bitemporal spine.
- Scan configuration version is stamped on observations so later statistics can remain cohort-aware.
- `DecisionSnapshot` explicitly records both `known` and `missing` information and is immutable once sealed.
- A planned mission cannot exist without a sealed Decision Snapshot.
- An untraded/rejected setup cannot be abandoned without preserving a Decision Snapshot; rejected setups therefore remain evaluation data rather than disappearing.
- Execution stage requires a linked order intent, while Mission itself never writes execution/order truth.
- External/manual MT5 positions can be adopted directly into `MANAGING` with no fabricated Decision Snapshot; this structurally prevents them from being credited to a Brain version.
- Mission reviews store decision assessment separately from optional outcome/counterfactual evidence.
- Lifecycle actions have stable action ids so client replay is idempotent.
- Reducer replay validates state transitions itself; malformed direct ledger histories cannot bypass service-layer transition rules.
- `MissionRuntime` is assembled in the real Desk process rather than remaining a library-only aggregate.
- Broker `position` events flow through durable venue `clientOrderId → intent.created → mission.intentLinked` identity before an internal Mission can claim ownership. Symbol/side/volume/time similarity is never used for ownership.
- A broker position whose ownership chain cannot be proven is deterministically adopted as `external:unknown`; no Decision Snapshot or Brain attribution is fabricated.
- Broker `positionClosed` events close only the Mission with the matching durable `mission.positionLinked` fact; unknown closes do not invent a Mission.
- Position/close Mission updates publish a `missions` realtime topic sourced by ledger replay.
- `GET /missions?limit=` exposes bounded newest-first durable Mission state, and `/state` includes the same Mission snapshot for reconnect/bootstrap clients.
- Scanner ingestion is now a real authenticated server command: `POST /scans`. Observed, candidate and rejected scans become durable Mission data; rejected scans must include the point-in-time Decision Snapshot and rejection reason.
- Candidate planning is now a real authenticated command: `POST /missions/:missionId/plan`. The HTTP trust boundary reconstructs optional snapshot fields explicitly so immutable domain records never confuse an absent value with a present `undefined` value.
- Mission-bound order submission is now a real authenticated command: `POST /missions/:missionId/orders`.
- Mission-bound submission flows through `MissionExecutionCoordinator`, which durably records the Mission ownership claim before calling `ExecutionSupervisor`, links only a real durable `intent.created`, and repairs the narrow crash gap via `recoverPendingLinks()` before Mission commands are served.
- Canonical contradictions between Mission and order fail closed with `MISSION_CONFLICT`; ownership is never inferred from symbol/volume/time similarity.
- Scan, plan and mission-bound order commands are classified as mutating commands by the existing signed request + command-nonce anti-replay layer.
- HTTP regression coverage exercises `Scan → CANDIDATE → immutable DecisionSnapshot → PLANNED → ARMED → durable Intent link` and verifies the recorded `scan → plan → authorise → submit` action chain.
- A dedicated lifecycle integration test now closes and replays both evaluation populations: `Scan → Mission → Decision Snapshot → Intent → broker Position → broker Close → Review`, and `Scan → rejected/ABANDONED → Review`. Both rebuild identically from the immutable ledger after constructing a fresh runtime, and the ledger hash chain is re-verified.
- The lifecycle test itself exercised the causal-time guard: an initial rejected-scan fixture accidentally placed its Decision Snapshot after the rejection time and was correctly refused as future knowledge. The fixture was corrected; the guard was not weakened.
- Android request signing recognizes `/scans`, `/missions/:id/plan` and `/missions/:id/orders` as command-nonce/biometric-protected paths, matching the Desk's security boundary.
- Android's gap-aware store now consumes the `missions` realtime topic. Mission snapshots/deltas merge only by durable `missionId`; reconnect preserves last-known rows but marks the topic incomplete until resynchronized.
- Android Trade order entry now requires a complete Mission topic plus a durable `PLANNED` or `ARMED` Mission for the canonical instrument, and passes the exact `missionId` into the Ticket. It no longer opens an unattributed internal ticket.
- The mobile Ticket's placeholder local-success path has been removed. It cannot display a successful handoff without a successful authenticated Desk response.
- Mobile preview now calls the Desk's real side-effect-free `/orders/preview` path with the same order shape used by submission; no client-side sizing is promoted to execution truth.
- Mobile submission calls only `/missions/:missionId/orders`; the legacy `/orders` route is never used by the new Ticket transport. A missing Mission or missing authenticated Desk runtime binding blocks the commit locally without claiming anything was sent.
- Command timeout or a Desk response whose broker result remains ambiguous is rendered as **unknown**, not failed or sent. The same stable intent id is retained so the operator is not encouraged to resend an unknowable order as a new intent.
- Regression tests cover Mission-store reconnect semantics, Mission-only ticket routing, missing Mission fail-closed behavior, timeout/unknown rendering and exact preview request shape.

Current Mission implementation is still **PARTIAL**, but the previously identified false-success mobile path is closed. The durable/server-side spine covers scan ingestion, rejected setups, planning, explicit Mission-bound intent ownership, broker position/close observation, review-domain transitions and replay; Android now consumes Mission state and its new Trade/Ticket flow is Mission-bound and truthful.

Remaining exit work is now narrower:

- the app shell/pairing bootstrap still needs to install the authenticated `DeskClient` and `DeskSocket` runtime binding used by the Ticket and subscribe that socket to Mission state; until that exists, the Ticket deliberately fails closed with "Desk transport unavailable";
- the compatibility `/orders` endpoint still permits a legacy order without a Mission and must not be retired until all real client/bootstrap paths have migrated;
- Windows/Desktop order-entry flows still need explicit Mission identity;
- operator abandon/review lifecycle commands still need the authenticated client-facing surface where required.

Trading Brain work remains blocked until these ADR-0018 exit criteria are met.

## Current repository verification

- MT5/TestClock foundation commit `699d35eb7acca968c44e1de3276d6ad798f7e231`: GitHub Actions `verify` **PASS**.
- Mission HTTP/server spine earlier heads: GitHub Actions `verify` **PASS**.
- Full traded/rejected Mission lifecycle replay head `eb0066ceec31d4cb4b2ecfdda876e55b42dadc0e`: GitHub Actions `verify` **PASS**.
- Android Mission command authorization code head `96094b9eed8a65268272320924f25a8a6d2ed8a4`: GitHub Actions `verify` **PASS**.
- Mission-bound Android store/Trade/Ticket exact code head `c814fea26fe2de1fc522528b1784a1412e9265f5`: GitHub Actions `verify` **PASS** (formatting, typecheck and tests).
- This documentation commit requires its own exact-head CI result before being called green.

Repository CI proves TypeScript/static/test behavior only. It does **not** prove MQL compilation, Android device behavior, pairing/runtime bootstrap, or target-terminal behavior.

## External verification boundary — still NOT VERIFIED

The following require the Windows/device environment and remain explicitly unverified:

- MetaEditor compilation of `KeelAgent.mq5` and included `.mqh` files;
- EA attach/runtime behavior inside the real MT5 terminal;
- actual `TimeGMT`, `TimeTradeServer`, `SymbolSelect`, file/spool and flush behavior on the target terminal build;
- actual `OrderCheck` and `OrderCalcMargin` behavior on LiteFinance Demo;
- exact LiteFinance symbol aliases, filling modes and account position model;
- EA/host/terminal restart and reconnect against real broker state;
- end-to-end App → Desk → execution host → EA → MT5 → LiteFinance → reconciliation;
- physical Android pairing/bootstrap and socket lifecycle;
- any `OrderSend` behavior, because sending is deliberately not implemented yet.

No real-money execution is enabled or claimed.

## Verification ladder

| Stage | Status | Evidence / remaining work |
| --- | --- | --- |
| Architecture ADR-0015–0022 | **DONE** | Accepted architecture and design critique exist. |
| Repository MT5 foundation | **SUBSTANTIALLY DONE** | Instrument truth, request-specific Margin, recovery/reconcile hardening and runtime host wiring built; real terminal proof remains. |
| Repository lint/typecheck/tests | **PASS at latest code head** | `c814fea...` passed full `verify`; this documentation head requires its own result. |
| Simulation/chaos | **STRONG, NOT COMPLETE** | Duplicate/recovery/clock/partial-fill/margin paths covered; real EA restart boundary still external. |
| Trade Mission spine | **IN PROGRESS — MOBILE TRUTH PATH WIRED, BOOTSTRAP/DESKTOP OPEN** | Full traded/rejected lifecycle/replay is proven; Android store consumes Mission truth and new ticket submission is Mission-bound/fail-closed. Pairing/runtime client installation, desktop migration and legacy bypass retirement remain. |
| Trading Brain | **DESIGNED ONLY** | Must wait for Mission exit criteria. |
| Memory/Evaluation | **DESIGNED ONLY** | Must wait for Mission + deterministic Brain facts. |
| MetaEditor compile | **NOT VERIFIED** | Requires Windows. |
| Real MT5 terminal | **NOT VERIFIED** | Requires target terminal. |
| LiteFinance Demo E2E | **NOT VERIFIED** | Requires stages above. |

## Next highest-priority sequence

1. Build the real Android app-shell/pairing bootstrap that restores/installs the authenticated `DeskClient`, starts `DeskSocket`, subscribes to `missions` with the other truth topics, and feeds socket snapshot/delta/gap/latency events into the store.
2. Add bootstrap/reconnect tests proving Mission state becomes complete only after a real snapshot/resync and that missing credentials/transport leave order entry fail-closed.
3. Migrate Windows/Desktop order-entry flows to explicit Mission identity and Mission-bound submission.
4. Add authenticated abandon/review lifecycle commands where operator workflows require them, preserving immutable Decision Snapshot/review rules.
5. Once every actual client path is migrated, fail closed or explicitly deprecate the compatibility `/orders` route so new internal orders cannot bypass Mission ownership.
6. Close ADR-0018 with client reconnect/replay tests proving the Mission spine remains identical after process reconstruction.
7. Only after ADR-0018 exit criteria are met, begin ADR-0019 deterministic/versioned Trading Brain.
8. Do not enable Demo `OrderSend` until Windows/MetaEditor/real MT5 read-only validation establishes the external execution foundation.
