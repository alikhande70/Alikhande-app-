# Build report — `gpt/trading-brain-build`

This file records implementation that actually exists on the branch. ADRs describe intended architecture; this report separates repository verification from Windows/MetaEditor/MT5/LiteFinance and physical-device verification.

## Current state — 2026-08-27

The repository-level MT5 foundation is substantially built and fail-closed. Real broker execution remains deliberately disabled because `OrderSend`/`OrderSendAsync` are absent.

Work remains on **ADR-0018 — Trade Mission**. The durable Mission spine, Mission-bound Android trading path, authenticated realtime path, first-time pairing controller/screen, pairing metadata persistence, and operator abandon/review command surface now exist in repository code. Trading Brain, memory and evaluation remain blocked by the ADR-0018 exit gate.

The largest remaining ADR-0018 product gap is now the Windows/Desktop Mission-bound client path and retirement of the compatibility `/orders` bypass. Physical-device/native-key proof also remains external.

The preserved branch `claude/personal-trading-app-atm6e1` remains outside this workstream and must not be modified.

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
- Durable agent event spool replay exists for undelivered hints; reconciliation remains authoritative truth.
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
- Mission origins cover scanner/Brain observations, Android/Desktop operator actions, manual MT5, pending activation and unknown external origin.
- Mission facts use the existing append-only hash-chained ledger; there is no second mutable truth store.
- Bitemporal observation spine: market valid time is stored separately from ledger transaction/recorded time.
- Scan configuration version is stamped so statistics can remain cohort-aware.
- Immutable `DecisionSnapshot` records both `known` and `missing` information at decision time.
- Planned missions require a sealed snapshot; rejected/untraded setups cannot disappear without preserving point-in-time evidence.
- Execution stage requires a linked order intent; Mission never writes broker/order truth.
- External/manual MT5 positions enter `MANAGING` without a fabricated Decision Snapshot or Brain attribution.
- Reviews keep decision assessment separate from optional outcome/counterfactual evidence.
- Lifecycle actions have stable action ids for idempotent replay.
- Reducer replay validates transitions; malformed direct ledger histories cannot bypass service-layer rules.
- `MissionRuntime` is assembled in the real Desk process.
- Internal position ownership is proven only through durable `clientOrderId → intent.created → mission.intentLinked` identity. Symbol/side/volume/time similarity is never ownership evidence.
- Unowned broker positions are deterministically adopted as `external:unknown`.
- Broker close events close only a Mission with a matching durable position link.
- `missions` is a realtime topic sourced from durable Mission state.
- `GET /missions?limit=` and `/state` expose bounded/reconnectable Mission state.
- Authenticated commands exist for scan ingestion, planning, Mission-bound order submission, abandonment and review.
- `MissionExecutionCoordinator` records Mission ownership before calling `ExecutionSupervisor`, links only a durable `intent.created`, and repairs the crash gap via startup recovery.
- Canonical contradictions fail closed with `MISSION_CONFLICT`.
- Untraded `OBSERVED`/`CANDIDATE` Missions cannot be abandoned without first sealing point-in-time evidence.
- Review payload validation rejects malformed/duplicate evidence references before mutating Mission review state.
- Review is immutable after first acceptance; a second review cannot overwrite the original with hindsight.
- Lifecycle integration tests cover both populations through reconstruction:
  `Scan → Snapshot → Intent → Position → Close → Review`
  and
  `Scan → rejected/ABANDONED → Review`.
- Ledger hash-chain integrity is re-verified after reconstruction.

## Android Mission/trading path — implemented so far

- Android command signing recognizes scan/planning/abandon/review/Mission-order command paths and uses the Desk command-nonce boundary.
- Consequence-specific biometric prompts exist for Mission planning, abandon, review and Mission-bound order submission.
- Gap-aware mobile store consumes Mission snapshots/deltas by durable `missionId` and marks data incomplete after gaps until resync.
- Trade entry requires complete Mission truth and a durable `PLANNED` or `ARMED` Mission for the canonical instrument.
- Ticket receives and preserves the exact `missionId`; it no longer opens an unattributed internal ticket.
- Placeholder local success (`Handed to your desk`) was removed.
- Preview uses the real Desk side-effect-free preview path; client-side sizing is not promoted to execution truth.
- Submit uses only `/missions/:missionId/orders`; the new Ticket does not call legacy `/orders`.
- Missing Mission or missing authenticated Desk runtime blocks locally without claiming transmission.
- Timeout/ambiguous Desk results render as **UNKNOWN**, not failed or sent, and retain the stable intent id.
- Already-paired restore/bootstrap exists: persisted pairing metadata + existing signer → signed `DeskClient` + `DeskSocket` → realtime truth store.
- Restore fails closed when pairing metadata exists but the signing key is missing.
- Transport stop preserves last-known data as stale/incomplete evidence; explicit unpair may clear it.
- First-time Pair screen/controller now exists. It accepts only Desk address + enrolment code, delegates key creation to the installed `SecureSigner`, calls `/enrol`, persists non-secret Desk metadata, and starts the existing authenticated runtime.
- The Pair screen does **not** generate fallback key material and does not claim hardware-backed security. If no truthful signer runtime is installed, pairing is visibly blocked.
- Pairing failure behavior preserves a key if Desk may already have accepted it, preventing the phone from destroying the only private key for an enrolled device.
- Pairing metadata uses a versioned secure-store adapter; corrupt/unknown metadata fails closed rather than being treated as a fresh unpaired device.

## Realtime and command security — repository closed

- `/stream` requires a signed first-frame `hello` before a socket is admitted to `RealtimeHub`.
- The proof reuses enrolled-device verification, clock-skew guard, nonce replay protection and Ed25519 verification.
- Malformed, unsigned, replayed, stale or bad-signature hello attempts are refused before subscription.
- Android creates a fresh stream nonce/signature on every connection attempt using the current Desk clock offset.
- Mission mutations `plan`, `abandon`, `review` and `orders` are classified as commands on both Desk and Android, requiring a single-use command nonce; Android additionally requests biometric authorisation through its signer contract.
- Regression tests lock this command-path contract so newly added lifecycle surfaces cannot silently downgrade to ordinary signed reads.

## Current ADR-0018 gaps

ADR-0018 remains **IN PROGRESS**. Remaining work is now narrow:

1. **Native device-key implementation / physical-device proof** — repository abstractions/controller are present, but StrongBox/TEE/Keychain behavior and actual key persistence still require native implementation/target-device proof. No software fallback may be promoted as hardware-backed.
2. **Windows/Desktop Mission-bound client path** — the repository currently contains no Desktop app under `apps/`; a real Windows operator surface must consume server Mission truth and carry explicit `missionId` for order entry before the compatibility bypass can be retired.
3. **Legacy `/orders` retirement** — compatibility route still permits Mission-less internal order submission. It must remain only until every actual operator client is Mission-bound, then fail closed or be removed explicitly.
4. **Final ADR-0018 exit audit** — reconstruct/reconnect across actual Android + Windows client paths and confirm Mission state/ownership remains identical with no hidden local source of truth.

Trading Brain implementation remains blocked until these are resolved or explicitly re-scoped by an accepted ADR change.

## Current repository verification

- Request-specific MT5/TestClock foundation: full GitHub Actions `verify` PASS on prior foundation heads.
- Mission HTTP/server lifecycle/replay spine: repository PASS on prior Mission heads.
- First-time Pair screen/controller + fail-closed pairing runtime/persistence: repository code exists; physical native-key proof remains external.
- Operator abandon/review surface, immutable review behavior and lifecycle validation: exact code passed full `verify` at `e495c153d597b277474d5dfca4c47753e0fcd015`.
- Android/Desk Mission lifecycle command-nonce contract: exact code head `285a892c22af44a34b606f6427311b45cfff89f7` — GitHub Actions `verify` **PASS**.
- This documentation head requires its own exact-head CI result before being called green.

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
- physical Android native key provisioning/storage and first-time pairing behavior on the target device;
- physical Android background/resume socket behavior;
- Windows/Desktop operator-client behavior, because that client surface is not yet implemented;
- any `OrderSend` behavior, because sending is deliberately not implemented yet.

No real-money execution is enabled or claimed.

## Verification ladder

| Stage | Status | Evidence / remaining work |
| --- | --- | --- |
| Architecture ADR-0015–0022 | **DONE** | Accepted architecture and design review exist. |
| Repository MT5 foundation | **SUBSTANTIALLY DONE** | Instrument truth, request-specific Margin, recovery/reconcile hardening and execution-host wiring built; target-terminal proof remains. |
| Repository lint/typecheck/tests | **PASS at latest code head** | `285a892c...` passed full `verify`; this report head needs its own result. |
| Simulation/chaos | **STRONG, NOT COMPLETE** | Duplicate/recovery/clock/partial-fill/margin paths covered; real EA restart boundary remains external. |
| Trade Mission spine | **IN PROGRESS — SERVER + ANDROID MISSION PATH BUILT** | Durable lifecycle/replay, pairing/controller, Mission-bound mobile truth and operator lifecycle routes exist; Desktop migration + bypass retirement + final exit audit remain. |
| Android first-time pairing | **REPOSITORY BUILT / DEVICE PROOF BLOCKED** | Screen/controller/persistence exist and fail closed without a signer; native hardware-backed proof remains external. |
| Realtime + command authentication | **REPOSITORY DONE** | Signed stream admission and command-nonce protection for Mission mutations. |
| Trading Brain | **DESIGNED ONLY / BLOCKED** | Must wait for ADR-0018 exit criteria. |
| Memory/Evaluation | **DESIGNED ONLY / BLOCKED** | Must wait for Mission + deterministic Brain facts. |
| MetaEditor compile | **NOT VERIFIED** | Requires Windows. |
| Real MT5 terminal | **NOT VERIFIED** | Requires target terminal. |
| LiteFinance Demo E2E | **NOT VERIFIED** | Requires external stages above. |

## Next highest-priority sequence

1. Define and implement the Windows/Desktop operator client surface against the existing Desk Mission API. It must render server Mission truth and submit orders only through `/missions/:missionId/orders`; do not create a Desktop-local trading truth store.
2. Add Desktop reconnect/resync and failure tests, including UNKNOWN command outcomes and stale Mission state.
3. Once Android and Desktop actual order-entry paths are both Mission-bound, disable/remove the legacy Mission-less `POST /orders` path and add a regression test proving new internal orders require Mission ownership.
4. Perform the final independent ADR-0018 replay/reconnect/red-team audit across server + Android + Desktop paths.
5. Only after ADR-0018 exit criteria are met, begin ADR-0019 deterministic/versioned Trading Brain.
6. Keep native Android key behavior and MT5/LiteFinance terminal validation on the external verification ladder; do not invent repository-only proof for physical/runtime facts.
7. Do not enable Demo `OrderSend` until Windows/MetaEditor/real MT5 read-only validation establishes the external execution foundation.
