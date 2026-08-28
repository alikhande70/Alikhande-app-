# Build report — `gpt/trading-brain-build`

This report records what is actually implemented and verified on the branch. ADRs describe intended architecture; this file separates repository evidence from Windows/MetaEditor/MT5/LiteFinance and physical-device evidence.

## Current state — 2026-08-28

The repository-level MT5 execution foundation is substantially built and remains fail-closed. Real broker execution is deliberately not enabled or claimed. ADR-0018 — Trade Mission has a substantially closed repository ownership path, but its final independent audit/native runtime proof remains open.

A **non-integrated ADR-0019 foundation** now exists as `packages/brain`: a pure deterministic/versioned rubric evaluator with explicit insufficient-data handling. It has no clock, network, I/O, LLM dependency, Mission wiring or execution access. No further Brain runtime integration is permitted until the remaining ADR-0018 audit items are resolved.

The preserved branch `claude/personal-trading-app-atm6e1` remains outside this workstream and must not be modified.

## Repository MT5 foundation — implemented

- Loopback-only Windows execution host ↔ `KeelAgent.mq5` protocol with authenticated agent sessions.
- Durable command lifecycle and ambiguity handling; post-send uncertainty is reconciled rather than automatically retried.
- Strict snapshot/reconciliation parsing; broker/order truth is never inferred from UI state.
- MT5 64-bit identifiers stay decimal strings across JavaScript boundaries.
- Reconciliation distinguishes orders, deals and positions; order-only evidence cannot prove a fill.
- Historical rejected/cancelled/expired orders cannot masquerade as execution.
- Multi-deal fills aggregate correctly; multiple distinct executions under one intent are contradiction/duplicate evidence.
- Broker-local wall clock and UTC are separated and guarded.
- Explicit venue-symbol ↔ canonical mapping with collision rejection; no suffix-stripping/fuzzy identity guessing.
- `instrumentFacts` feed the binding layer; semantic metadata MT5 cannot prove must be configured explicitly or the instrument is refused.
- Tradable symbol universe is configured explicitly rather than inferred from current positions/orders.
- MT5 runtime is selectable with `KEEL_BROKER=mt5`.
- Adapter capabilities describe the current build, not theoretical MT5 capability.
- Durable event spool/replay exists for undelivered hints; reconciliation remains authoritative.
- Request-specific margin path exists in repository code:
  `ExecutionSupervisor → BrokerPort → MT5 adapter → HostClient → execution host → KeelAgent → OrderCalcMargin`.
- Margin is request-bound and freshness/fingerprint validated. Missing, stale, malformed or unavailable margin is **BLOCK**, never zero, and is not waivable.
- Real-account safety remains explicitly gated.

### Important safety defects already closed

| Severity | Defect |
| --- | --- |
| P0 | Multiple distinct executions under one magic could collapse into one clean fill. |
| P0 | Broker-local and UTC clock domains were mixed. |
| P0 | Future-dated heartbeat could make a dead agent appear live. |
| P0 | Unknown margin could become `0.00`. |
| P0 | Evidence grouping could collide identifier namespaces. |
| P1 | Partial multi-deal fills could understate size. |
| P1 | Venue-symbol collisions could contaminate canonical quote/sizing identity. |
| P1 | Definitive MT5 rejection retcodes could fall through to permanent UNKNOWN. |
| P1 | Instrument facts existed without an operational instrument path. |
| P1 | MT5 adapter existed but was unreachable from normal Desk runtime. |
| P1 | Capability reporting was aspirational rather than truthful. |

## Trade Mission spine — repository state

Mission is the durable aggregate above execution truth. It references intents and broker positions but never replaces broker/order truth.

Implemented:

- Mission stages: `OBSERVED → CANDIDATE → PLANNED → ARMED → EXECUTING → MANAGING → CLOSED/ABANDONED → REVIEWED`.
- Scanner, Brain observation, operator, manual/external MT5 and unknown-external origins are distinguished.
- Mission facts use the existing append-only hash-chained ledger; no second mutable truth database exists.
- Bitemporal market valid-time and ledger recorded-time are distinct.
- Scan configuration version is recorded for cohort-aware statistics.
- Immutable `DecisionSnapshot` records both what was **known** and what was **missing** at decision time.
- Rejected/untraded setups remain complete durable records rather than disappearing.
- Execution stage requires a linked order intent.
- External/manual MT5 positions enter Mission management without fabricated Brain attribution or Decision Snapshot.
- Reviews keep decision assessment separate from optional outcome/counterfactual evidence.
- Lifecycle action ids and reducer rules make replay idempotent and fail-closed.
- `MissionRuntime` is assembled in the real Desk process.
- Internal position ownership is proven only through durable identity (`clientOrderId → intent.created → mission.intentLinked`), never symbol/side/volume/time similarity.
- Unowned broker positions are deterministically adopted as `external:unknown`.
- Broker close events close only a durably linked Mission.
- `missions` is a realtime topic backed by durable Mission state.
- Bounded Mission state is exposed through `/state` and `GET /missions?limit=`.
- Authenticated command surfaces exist for scan ingestion, plan, Mission-bound order submission, abandon and review.
- `MissionExecutionCoordinator` records Mission ownership before order intent creation and repairs the crash gap on startup.
- Canonical contradictions fail closed.
- Review evidence is validated before mutation and first accepted review is immutable.
- Lifecycle reconstruction tests cover both executed and rejected populations:
  - `Scan → Snapshot → Intent → Position → Close → Review`
  - `Scan → rejected/ABANDONED → Review`
- Ledger hash-chain integrity is checked after reconstruction.
- The primary HTTP E2E harness creates a real candidate Scan, plans its Mission and submits only through `/missions/:missionId/orders`.
- Mission-less `POST /orders` is retired with deterministic `410 MISSION_REQUIRED` before the historical handler can reach `ExecutionSupervisor`.
- **Red-team hardening:** the 410 tombstone is installed even when `MissionRuntime` is absent. A dedicated regression test proves an isolated/legacy server configuration cannot resurrect direct Mission-less submission.

### Remaining repository audit note

The historical direct `POST /orders` handler still physically exists in `server.ts`, but an unconditional Mission-route pre-handler makes it unreachable and regression tests prove it cannot create an intent, including when `MissionRuntime` is absent. This dead compatibility code should still be removed when a safe source edit can be made, because deleting dangerous dead code is stronger than relying indefinitely on interception.

## Android path — repository state

- Mission mutation/order paths use the Desk command-nonce boundary and Android signer/biometric contract.
- Gap-aware store consumes Mission snapshots/deltas by durable `missionId`.
- Trade entry requires complete Mission truth and a `PLANNED`/`ARMED` Mission for the exact canonical instrument.
- Ticket preserves the exact `missionId`; local fake-success messaging was removed.
- Preview uses Desk preview; client-side sizing is not execution truth.
- Submit uses `/missions/:missionId/orders`; new Ticket does not use legacy `/orders`.
- Timeout/ambiguous command results render **UNKNOWN**, not failed/sent, and are never automatically retried.
- Already-paired bootstrap restores signed REST + realtime Desk truth.
- Pair screen/controller and versioned secure metadata persistence exist.
- Pairing remains visibly blocked without a truthful signer; no fallback key is promoted as hardware-backed.
- Native StrongBox/TEE/key persistence still requires actual device implementation/proof.

## Windows/Desktop path — repository state

The repository now has a platform-neutral Mission-bound Windows operator core, a hardened Mission realtime projection, a fail-closed native-signer adapter boundary and a headless application shell. It is **not yet a packaged/native Windows application**, and no repository test is treated as proof of Windows hardware-backed key protection.

Implemented:

- Signed Desktop Desk transport with the same request identity and command-nonce contract.
- Legacy Mission-less `POST /orders` is refused locally by Desktop transport before any network call, while the Desk independently tombstones the same path.
- Commands are never automatically retried; post-authorisation network uncertainty becomes **UNKNOWN**.
- `DesktopMissionOperator` sends only `/missions/:missionId/orders` with explicit `origin: operator:windows`.
- `DesktopMissionTruth` retains last-known rows after disconnect/gap but blocks consequential use until completeness is re-proven.
- Mission order entry requires the exact Mission, exact canonical and orderable stage (`PLANNED` or `ARMED`).
- MissionTruth is mandatory in `DesktopMissionOperator`; callers cannot construct an actionable operator that bypasses the stale-state gate.
- Authenticated Desktop realtime uses a fresh signed hello on each socket and refuses late auth proof from a replaced socket.
- Desktop realtime subscribes only to `missions`.
- Sequence gaps preserve old rows as incomplete and trigger a fresh snapshot request instead of applying an unproven delta.
- Server `resync` marks Mission rows incomplete until the immediately-following snapshot is validated.
- Desktop honours the Desk-advertised heartbeat interval and sends `ping` frames.
- Every Desktop reconnect requests a full Mission snapshot (`resume: {}`), deliberately preferring proof over resume bandwidth optimisation.
- Reconnect tests prove a pre-disconnect sequence cannot re-enable order entry; only a fresh server snapshot restores current truth.
- `WindowsProtectedSigner` implements the repository-side signer boundary over an opaque native Ed25519 key provider. Private key material never enters repository metadata.
- Persisted signer metadata is versioned and public-only (`keyName`, public key, protection class, creation time).
- Metadata-with-missing-key, orphan-native-key and malformed-metadata states fail closed instead of silently regenerating a new Desk identity.
- A native bridge report of hardware protection is recorded only as `hardware-backed-reported`; repository status remains `hardwareBackedVerified: false` until target-Windows evidence exists.
- Metadata persistence failure intentionally leaves an orphan key visible so later startup fails closed rather than guessing identity continuity.
- `WindowsMissionAppShell` composes the single existing Mission runtime for UI binding. It owns no mutable trading truth and exposes actions only while runtime Mission truth is proven current.
- App-shell regression coverage proves cached/last-known Mission rows remain displayable after stop/disconnect but cannot re-enable a network order; a fresh server snapshot is required.

Remaining Desktop work:

1. Implement the actual native Windows key-provider bridge and protected storage primitive behind `WindowsNativeEd25519Bridge`; prove behavior on target Windows and classify security truthfully.
2. Bind a packaged/native Windows UI to `WindowsMissionAppShell` without introducing a Desktop-local trading truth store.
3. Packaging and target-Windows runtime verification.

## Realtime and command security — repository state

- `/stream` admits a socket to `RealtimeHub` only after a signed first-frame hello is verified.
- Stream auth reuses enrolled-device verification, clock-skew protection, nonce replay protection and Ed25519 verification.
- Malformed, unsigned, replayed, stale or bad-signature hello attempts are refused before subscription.
- Mission mutations and Mission orders are consequential command paths requiring a single-use command nonce.
- Android additionally requests biometric authorisation through its signer contract.
- Desk reaps clients that stop heartbeating; both Android and Desktop have heartbeat paths in repository code.
- Mission-less `POST /orders` is retired at the server boundary with a deterministic non-ambiguous 410 response.
- The retirement guard no longer depends on MissionRuntime being present, closing a configuration-dependent bypass found during the ADR-0018 red-team audit.

## ADR-0019 Trading Brain foundation — repository state

A deliberately narrow foundation is now implemented in `packages/brain` and is **not wired into runtime execution**.

Implemented:

- Independent `@keel/brain` package boundary.
- Pure `evaluate(BrainVersion, FeatureVector, Context)` function with no clock, network, filesystem, broker, account, LLM or environment access.
- Explicit `brainVersion`, `featureSetVersion` and `rubricVersion` provenance in every output.
- Transparent weighted rubric over normalized explicit features.
- Deterministic machine-readable rationale codes rather than prose.
- Feature-set mismatch is rejected rather than silently compared across incompatible populations.
- Missing required features produce `insufficient-data` with an explicit sorted missing-feature list; values are never imputed.
- Malformed normalized features and invalid rubrics fail closed.
- Integer-basis-point rounding provides stable deterministic score representation.
- Regression tests prove byte-equivalent same-input output, wall-clock independence and score bounds over a deterministic grid of feature combinations.
- No LLM code exists in this package and no Brain output has a privileged execution path.

Not yet implemented/wired:

- Versioned point-in-time feature extraction from actual scan data.
- Brain → Mission candidate/planning integration.
- Champion/challenger registry or forward-only evaluation.
- LLM explanation edge.
- Memory/evaluation layers.

No further runtime integration should occur until the remaining ADR-0018 repository audit items are resolved.

## ADR-0018 exit status

ADR-0018 remains **IN PROGRESS**, but the repository-level Mission ownership path is substantially closed. Current remaining gaps are explicit:

1. **Dead compatibility removal** — remove the physically present historical direct `/orders` execution handler after confirming no fixture/tool requires it; the current unconditional tombstone and regression tests already prevent execution.
2. **Native device-key proof** — Android hardware-backed behavior and Windows native key-provider/protected persistence require target-device/runtime proof. Repository abstractions deliberately do not claim this evidence.
3. **Native Windows product completion** — package/bind the Windows UI to the existing single `WindowsMissionAppShell`; no local source of trading truth is permitted.
4. **Final independent audit continuation** — continue replay/reconnect/bypass inspection across server, Android and Desktop.

The pure Brain package may be developed in isolation, but Brain-to-Mission/runtime integration remains blocked until these repository exit items are closed. External Windows/MT5/device proofs remain on the verification ladder and must not be converted into repository claims.

## Verification ladder

| Stage | Status | Evidence / boundary |
| --- | --- | --- |
| Architecture ADR-0015–0022 | **DONE** | Accepted ADRs + `docs/BRAIN-DESIGN-REVIEW.md`. |
| Repository MT5 foundation | **SUBSTANTIALLY DONE** | Deterministic execution truth, instrument/margin/recovery wiring built; target-terminal proof remains external. |
| Repository lint/typecheck/tests | **PASS** | Exact code head `59fc311cb1213f6eee6402030c4f50731e284ab1` passed GitHub Actions `verify`, including the new `@keel/brain` package. This documentation commit requires its own exact-head run before being called green. |
| Simulation/chaos | **STRONG, NOT COMPLETE** | Duplicate/recovery/clock/partial-fill/margin and Mission replay paths covered; real terminal/device restart remains external. |
| Trade Mission spine | **IN PROGRESS — REPOSITORY OWNERSHIP PATH HARDENED** | Durable lifecycle + server/Android/Desktop Mission truth paths exist; config-dependent legacy-order bypass closed; dead-handler cleanup/native/runtime proof + final audit remain. |
| Android first-time pairing | **REPOSITORY BUILT / DEVICE PROOF BLOCKED** | Controller/screen/persistence fail closed without signer; hardware-backed proof external. |
| Windows Mission app shell | **REPOSITORY BUILT / NATIVE PACKAGING BLOCKED** | Single-runtime shell built; stale UI cannot submit; native bridge/packaging proof remains external. |
| Windows protected signer | **ADAPTER BUILT / TARGET PROOF BLOCKED** | Repository adapter preserves identity and keeps private key opaque; native provider implementation and Windows proof remain external. |
| Realtime + command authentication | **REPOSITORY DONE** | Signed stream admission, replay guard, command nonce; Desktop heartbeat/reconnect proof covered. |
| Trading Brain | **FOUNDATION BUILT / RUNTIME WIRING BLOCKED** | Pure deterministic/versioned evaluator exists and is green; no Mission/execution integration yet. |
| Memory/Evaluation | **DESIGNED ONLY / BLOCKED** | Must wait for Mission + deterministic/versioned Brain facts. |
| MetaEditor compile | **NOT VERIFIED** | Requires Windows/MetaEditor. |
| Real MT5 terminal | **NOT VERIFIED** | Requires target terminal. |
| LiteFinance Demo E2E | **NOT VERIFIED** | Requires external stages above. |

## External verification boundary — NOT VERIFIED

Repository CI does **not** prove:

- MetaEditor compilation of `KeelAgent.mq5` and included `.mqh` files;
- actual EA attach/runtime inside target MT5;
- target-terminal `TimeGMT`, `TimeTradeServer`, `SymbolSelect`, spool/file durability behavior;
- real `OrderCheck` / `OrderCalcMargin` behavior on LiteFinance Demo;
- actual LiteFinance symbol aliases, filling modes and account position model;
- EA/host/terminal restart and reconnect against real broker state;
- end-to-end App → Desk → host → EA → MT5 → LiteFinance → reconciliation;
- physical Android native key provisioning/storage and background/resume behavior;
- actual Windows native key provider, protected private-key persistence, hardware-backed classification, packaging and target-Windows runtime behavior;
- any real-money execution.

No real-money execution is enabled or claimed.

## Next highest-priority sequence

1. Continue the independent ADR-0018 red-team audit and safely remove the physically present dead direct `/orders` handler while preserving the deterministic 410 tombstone.
2. Implement/integrate the actual Windows native key-provider + protected persistence bridge; do not claim hardware-backed protection without target proof.
3. Bind/package the real Windows UI around the **single** `WindowsMissionAppShell` path and add restart/reconnect tests at that boundary.
4. Perform target Windows + physical-device verification and keep failures on the verification ladder rather than converting assumptions into facts.
5. After the repository ADR-0018 exit audit closes, wire the already-pure `@keel/brain` foundation into versioned point-in-time scan features and Trade Missions.
6. Then implement ADR-0021 evaluation and ADR-0020 memory in the accepted order, with ADR-0022 version/challenger rules and no automatic promotion.
7. Keep MT5/LiteFinance facts on the external verification ladder; do not substitute repository tests for physical/runtime proof.
