# Build report — `gpt/trading-brain-build`

This file records implementation that actually exists on the branch. ADRs describe intended architecture; this report separates repository verification from Windows/MetaEditor/MT5/LiteFinance and physical-device verification.

## Current state — 2026-08-27

The repository-level MT5 foundation is substantially built and fail-closed. Real broker execution remains deliberately disabled because `OrderSend`/`OrderSendAsync` are absent.

Work is on **ADR-0018 — Trade Mission**. The durable server-side Mission spine and the Mission-bound Android trade path exist. The already-paired Android restore/bootstrap path now installs the signed Desk client and realtime socket, and realtime subscription is authenticated before a client is admitted to the Desk hub. First-time pairing/native key provisioning and Desktop/Windows Mission migration remain before ADR-0018 can close.

Trading Brain, memory and evaluation remain blocked by the ADR-0018 exit gate.

The preserved branch `claude/personal-trading-app-atm6e1` remains outside this workstream.

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
- Configured tradable-symbol universe no longer depends on an existing position/order.
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

## Trade Mission — implemented durable spine

The Mission layer is above execution truth. It may reference order intents and broker positions, but it never replaces the order ledger or fabricates broker state.

Implemented:

- Mission stages: `OBSERVED`, `CANDIDATE`, `PLANNED`, `ARMED`, `EXECUTING`, `MANAGING`, `CLOSED`, `ABANDONED`, `REVIEWED`.
- Mission origins cover scanner, Brain observation, Android/Desktop operator action, manual MT5, pending activation and unknown external origin.
- Mission facts use the existing append-only hash-chained ledger; there is no second mutable truth store.
- Bitemporal observation spine: market valid time is stored separately from ledger transaction/recorded time.
- Scan configuration version is stamped so statistics can remain cohort-aware.
- Immutable `DecisionSnapshot` records both `known` and `missing` information at decision time.
- Planned missions require a sealed snapshot; rejected/untraded setups cannot disappear without preserving their point-in-time evidence.
- Execution stage requires a linked order intent; Mission never writes broker/order truth.
- External/manual MT5 positions enter `MANAGING` without a fabricated Decision Snapshot or Brain attribution.
- Reviews separate decision assessment from optional outcome/counterfactual evidence.
- Lifecycle actions have stable action ids for idempotent replay.
- Reducer replay validates transitions; malformed direct ledger histories cannot bypass service-layer rules.
- `MissionRuntime` is assembled in the real Desk process.
- Internal position ownership is proven only through durable `clientOrderId → intent.created → mission.intentLinked` identity. Symbol/side/volume/time similarity is never ownership evidence.
- Unowned broker positions are deterministically adopted as `external:unknown`.
- Broker close events close only a Mission with a matching durable position link.
- `missions` is a realtime topic sourced from durable Mission state.
- `GET /missions?limit=` and `/state` expose bounded/reconnectable Mission state.
- Authenticated commands exist for scan ingestion, planning and Mission-bound order submission.
- `MissionExecutionCoordinator` records Mission ownership before calling `ExecutionSupervisor`, links only a durable `intent.created`, and repairs the crash gap via startup recovery.
- Canonical contradictions fail closed with `MISSION_CONFLICT`.
- Lifecycle integration tests cover both populations through reconstruction:
  `Scan → Snapshot → Intent → Position → Close → Review`
  and
  `Scan → rejected/ABANDONED → Review`.
- Ledger hash-chain integrity is re-verified after reconstruction.

## Android Mission/trading path — implemented so far

- Android command signing recognizes scan/planning/Mission-order command paths and uses the Desk command-nonce boundary.
- Gap-aware mobile store consumes Mission snapshots/deltas by durable `missionId` and marks data incomplete after gaps until resync.
- Trade entry requires complete Mission truth and a durable `PLANNED` or `ARMED` Mission for the canonical instrument.
- Ticket receives and preserves the exact `missionId`; it no longer opens an unattributed internal ticket.
- Placeholder local success (`Handed to your desk`) was removed.
- Preview uses the real Desk side-effect-free preview path; client-side sizing is not promoted to execution truth.
- Submit uses only `/missions/:missionId/orders`; the new Ticket does not call legacy `/orders`.
- Missing Mission or missing authenticated Desk runtime blocks locally without claiming transmission.
- Timeout/ambiguous Desk results render as **UNKNOWN**, not failed or sent, and retain the stable intent id.
- Already-paired restore/bootstrap is implemented: persisted pairing metadata + existing secure signer → signed `DeskClient` + `DeskSocket` → realtime truth store.
- Restore fails closed when pairing metadata exists but the signing key is missing.
- Transport stop preserves last-known data as stale/incomplete evidence; explicit unpair may clear it.

## Realtime security — closed in repository code

A red-team review found that `/stream` was exempt from the HTTP pre-handler and previously admitted a WebSocket into `RealtimeHub` before proving device identity. That allowed an anonymous socket to request broker/Mission topics.

This is now closed:

- the first WebSocket frame must be a `hello` carrying a fresh signed read proof for canonical `GET /stream`;
- the proof reuses the existing enrolled-device verifier, timestamp skew guard, nonce replay protection and Ed25519 signature verification;
- the server does **not** call `RealtimeHub.connect()` until the proof succeeds;
- malformed, unsigned, replayed, stale or bad-signature hello attempts are refused before subscription;
- a second hello on an authenticated connection is rejected rather than blurring connection/resume identity;
- Android creates a fresh stream nonce/signature on every connection attempt using the current Desk clock offset;
- a late signing result from a dead/replaced socket cannot authenticate its replacement;
- E2E tests use an actual generated Ed25519 key, actual enrolment, signed WebSocket hello, topic snapshots and authenticated ping/pong.

Exact code head `6b945dc6ec8f384f9ed07073d5c501f9824ae5c4` passed the full GitHub Actions `verify` workflow after this change.

## Current ADR-0018 gaps

ADR-0018 remains **IN PROGRESS**. Remaining work is narrower:

1. **First-time Android pairing ceremony** — the repository has signer abstractions and already-paired restore, but no complete `pair` screen/controller that provisions the device key, submits `/enrol`, persists returned Desk metadata and then bootstraps runtime.
2. **Native device-key implementation / physical-device proof** — Enclave/Keychain abstractions require real platform crypto/storage integration and device verification; no fake software key should be promoted as hardware-backed.
3. **Windows/Desktop Mission-bound order entry** — Desktop paths must carry explicit Mission identity before the bypass can be retired.
4. **Operator abandon/review command surface** — authenticated client-facing lifecycle operations are still needed where the operator workflow requires them.
5. **Legacy `/orders` retirement** — compatibility route still permits Mission-less internal order submission. It must remain until real client migrations are complete, then fail closed/deprecate explicitly.
6. **Final ADR-0018 exit audit** — reconstruct/reconnect across actual client paths and confirm Mission state/ownership remains identical.

Trading Brain implementation remains blocked until these are resolved.

## Current repository verification

- Request-specific MT5/TestClock foundation: full GitHub Actions `verify` PASS on prior foundation heads.
- Mission HTTP/server and lifecycle/replay spine: full GitHub Actions `verify` PASS on prior Mission heads.
- Mission-bound Android Ticket/store/bootstrap: repository verification PASS on prior heads.
- Signed realtime security implementation + authenticated mobile/socket/E2E tests: exact code head `6b945dc6ec8f384f9ed07073d5c501f9824ae5c4` — GitHub Actions `verify` **PASS**.
- The documentation-only head after this report update requires its own exact-head CI result before being called green.

Repository CI proves static/type/test behavior only. It does **not** prove MQL compilation, physical Android secure-key behavior or target-terminal behavior.

## External verification boundary — still NOT VERIFIED

The following require Windows/device/terminal access and remain explicitly unverified:

- MetaEditor compilation of `KeelAgent.mq5` and included `.mqh` files;
- EA attach/runtime behavior inside the real MT5 terminal;
- actual `TimeGMT`, `TimeTradeServer`, `SymbolSelect`, file/spool and flush behavior on the target terminal build;
- actual `OrderCheck` and `OrderCalcMargin` behavior on LiteFinance Demo;
- exact LiteFinance symbol aliases, filling modes and account position model;
- EA/host/terminal restart and reconnect against real broker state;
- end-to-end App → Desk → execution host → EA → MT5 → LiteFinance → reconciliation;
- physical Android native key provisioning/storage and full first-time pairing ceremony;
- physical Android background/resume socket behavior;
- any `OrderSend` behavior, because sending is deliberately not implemented yet.

No real-money execution is enabled or claimed.

## Verification ladder

| Stage | Status | Evidence / remaining work |
| --- | --- | --- |
| Architecture ADR-0015–0022 | **DONE** | Accepted architecture and design review exist. |
| Repository MT5 foundation | **SUBSTANTIALLY DONE** | Instrument truth, request-specific Margin, recovery/reconcile hardening and execution-host wiring built; target-terminal proof remains. |
| Repository lint/typecheck/tests | **PASS at code head** | `6b945dc...` passed full `verify`; this report head needs its own result. |
| Simulation/chaos | **STRONG, NOT COMPLETE** | Duplicate/recovery/clock/partial-fill/margin paths covered; real EA restart boundary remains external. |
| Trade Mission spine | **IN PROGRESS — SERVER + ANDROID RESTORE/REALTIME WIRED** | Durable lifecycle/replay and Mission-bound mobile truth path exist; first pairing, Desktop migration, lifecycle surfaces and legacy bypass retirement remain. |
| Realtime client authentication | **REPOSITORY DONE** | Signed first-frame admission; anonymous socket never enters hub; E2E signed enrolment/socket tests pass. |
| Trading Brain | **DESIGNED ONLY / BLOCKED** | Must wait for ADR-0018 exit criteria. |
| Memory/Evaluation | **DESIGNED ONLY / BLOCKED** | Must wait for Mission + deterministic Brain facts. |
| MetaEditor compile | **NOT VERIFIED** | Requires Windows. |
| Real MT5 terminal | **NOT VERIFIED** | Requires target terminal. |
| LiteFinance Demo E2E | **NOT VERIFIED** | Requires external stages above. |

## Next highest-priority sequence

1. Build the repository-level first-time Android pairing controller/page around the existing `SecureSigner` abstraction: provision key → submit `/enrol` → persist non-secret Desk metadata → immediately call the existing restore/bootstrap path. Do not claim hardware-backed security until the native implementation proves it.
2. Add pairing failure/rollback tests: bad/expired enrolment code, duplicate submission, key created but enrolment failed, enrolment succeeded but metadata persistence failed, missing key on restore, and unpair cleanup.
3. Migrate Windows/Desktop order-entry flows to explicit Mission identity and Mission-bound submission.
4. Add authenticated abandon/review lifecycle commands where operator workflows require them, preserving immutable Decision Snapshot/review rules.
5. Once every actual client path is migrated, fail closed or explicitly deprecate the compatibility `/orders` route so new internal orders cannot bypass Mission ownership.
6. Close ADR-0018 with independent replay/reconnect/red-team review across server + Android + Desktop paths.
7. Only after ADR-0018 exit criteria are met, begin ADR-0019 deterministic/versioned Trading Brain.
8. Do not enable Demo `OrderSend` until Windows/MetaEditor/real MT5 read-only validation establishes the external execution foundation.
