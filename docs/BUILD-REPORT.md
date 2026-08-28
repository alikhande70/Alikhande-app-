# Build report — `gpt/trading-brain-build`

This report records repository evidence separately from external Windows, MetaEditor, MT5, LiteFinance and physical-device evidence. ADRs describe the intended architecture; this file records only what is actually implemented or still blocked.

## Current state — 2026-08-28

The repository-level MT5 foundation is substantially built and remains fail-closed. Real-money execution is not enabled or claimed.

ADR-0018 — Trade Mission now has a hardened repository ownership path: scans, rejected setups, Mission lifecycle, Mission-bound intents, broker positions, external/manual positions, close/review and client realtime state are durable and reconstructable. The historical direct Mission-less `POST /orders` execution handler has now been physically removed from `server.ts`; the deterministic `410 MISSION_REQUIRED` tombstone remains, and a source-level regression test prevents direct handler reintroduction.

ADR-0019 has a non-integrated deterministic foundation in `packages/brain`. It now includes both the versioned pure scoring rubric and a pure bitemporal point-in-time feature extractor. Brain runtime/execution wiring remains intentionally absent.

The preserved branch `claude/personal-trading-app-atm6e1` is outside this workstream and must remain untouched.

## MT5 execution foundation — repository evidence

Implemented and covered by repository tests:

- Loopback Windows execution-host ↔ `KeelAgent.mq5` protocol with authenticated agent sessions.
- Durable command lifecycle, ambiguity handling and reconciliation rather than unsafe automatic retry.
- Strict distinction among MT5 orders, deals and positions.
- 64-bit broker identifiers kept as decimal strings across JavaScript boundaries.
- Partial-fill aggregation and duplicate/contradictory execution detection.
- Separate broker-local and UTC clock domains with freshness guards.
- Explicit venue-symbol ↔ canonical mapping with collision rejection; no fuzzy suffix guessing.
- Explicit tradable-symbol universe and instrument-facts binding.
- Runtime-selectable MT5 broker adapter with truthful capabilities.
- Durable event spool/replay while reconciliation remains authoritative.
- Request-specific margin path:
  `ExecutionSupervisor → BrokerPort → MT5 adapter → HostClient → execution host → KeelAgent → OrderCalcMargin`.
- Margin is fingerprint/freshness validated; missing, malformed, stale, mismatched or unavailable margin is **BLOCK**, never zero and never waivable.
- Real-account safety remains hard-gated.

Important previously closed defects include unknown-margin-to-zero, UTC/broker-time mixing, future heartbeat liveness, partial-fill understatement, venue-symbol collisions, duplicate execution collapse and incomplete MT5 rejection handling.

## ADR-0018 Trade Mission — repository evidence

Mission is the durable aggregate above execution truth; it references intents/positions but never replaces broker truth.

Implemented:

- Stages: `OBSERVED → CANDIDATE → PLANNED → ARMED → EXECUTING → MANAGING → CLOSED/ABANDONED → REVIEWED`.
- Distinct origins for scanner, Brain observation, operator and external/manual/unknown MT5 activity.
- Mission facts stored in the existing append-only hash-chained ledger; no second mutable truth database.
- Bitemporal valid-time and recorded-time separation.
- Scanner configuration version recorded for cohort-aware analysis.
- Immutable `DecisionSnapshot` records both what was known and what was missing at decision time.
- Rejected/untraded setups remain durable data.
- External/manual MT5 positions enter management without fabricated Brain attribution or fabricated decision snapshots.
- Internal position ownership is proven only through durable identity (`clientOrderId → intent.created → mission.intentLinked`), never symbol/side/volume/time similarity.
- `MissionExecutionCoordinator` records Mission ownership before order-intent creation and repairs the crash gap from durable facts after restart.
- Canonical contradictions fail closed.
- Broker close events close only durably linked Missions.
- Review keeps decision assessment separate from outcome/counterfactual evidence; accepted review is immutable.
- Replay/idempotency and ledger hash-chain reconstruction cover both executed and rejected populations.
- Realtime `missions` topic and bounded `/state` / `/missions` snapshots use durable Mission state.
- Authenticated command surfaces exist for scan ingestion, planning, Mission-bound order submission, abandon and review.
- Primary HTTP E2E uses `Scan → Mission → Decision Snapshot/Plan → /missions/:missionId/orders`.
- Mission-less `POST /orders` remains deterministically retired with `410 MISSION_REQUIRED`, including server fixtures without `MissionRuntime`.
- **Red-team hardening completed in this run:** the old direct `app.post('/orders') → ExecutionSupervisor.submit()` handler was physically deleted from `server.ts`.
- A source-level regression test now fails CI if a direct `POST /orders` handler is reintroduced; order creation remains delegated to Mission routes.

Repository-level remaining ADR-0018 work:

1. Continue independent replay/reconnect/bypass audit across Desk, Android and Desktop.
2. Keep native Android/Windows key claims external until target-device proof exists.
3. Bind/package the real Windows UI around the single `WindowsMissionAppShell` without creating Desktop-local trading truth.

## Android path — repository evidence

- Mission mutation/order paths use signed requests, command nonce and biometric signer contract.
- Gap-aware Mission store retains last-known state but blocks consequential use after a gap until resync.
- Trade entry requires a current `PLANNED`/`ARMED` Mission for the exact canonical instrument.
- Ticket preserves exact `missionId`; fake local success messaging was removed.
- Preview comes from Desk; client sizing is not execution truth.
- Submit uses `/missions/:missionId/orders` only.
- Timeout/ambiguous submit is **UNKNOWN**, never silently retried or reported as sent.
- Already-paired bootstrap restores signed REST + authenticated realtime.
- Pair controller/screen and versioned secure metadata persistence exist.
- StrongBox/TEE and native key persistence still require physical-device proof.

## Windows/Desktop path — repository evidence

- Signed Desktop transport uses the same identity/command-nonce contract.
- Desktop locally refuses Mission-less order submission before network access.
- `DesktopMissionOperator` can submit only through `/missions/:missionId/orders` and requires `DesktopMissionTruth`.
- Last-known Mission rows remain displayable after disconnect/gap but cannot authorize a new order.
- Fresh authenticated reconnect requests a full Mission snapshot before action is re-enabled.
- Heartbeat, sequence-gap and resync behavior have regression coverage.
- `WindowsProtectedSigner` uses an opaque native Ed25519-provider boundary; private key material is not stored in repository metadata.
- Missing-key/orphan-key/malformed-metadata states fail closed rather than silently regenerating identity.
- Hardware protection reported by a bridge is not promoted to `hardwareBackedVerified` without target-Windows evidence.
- `WindowsMissionAppShell` composes the single Mission runtime and owns no separate trading truth.

Still external/native:

- Actual Windows native key-provider + protected persistence implementation/proof.
- Packaged/native Windows UI binding and runtime verification.

## Realtime and command security — repository evidence

- `/stream` admits clients only after a signed first-frame hello.
- Stream auth reuses enrolled-device verification, clock-skew protection, nonce replay protection and Ed25519 verification.
- Malformed/unsigned/replayed/stale/bad-signature hello attempts are rejected before subscription.
- Consequential Mission commands require one-time command nonce.
- Desk reaps clients that stop heartbeating; Android and Desktop heartbeat paths exist.
- Mission-less `POST /orders` has no direct execution handler and remains a deterministic retired endpoint.

## ADR-0019 Trading Brain — deterministic foundation

Implemented in `packages/brain` and still isolated from runtime execution:

- Pure `evaluate(BrainVersion, FeatureVector, Context)` function with no clock, network, filesystem, broker, account, environment or LLM dependency.
- Explicit `brainVersion`, `featureSetVersion` and `rubricVersion` provenance.
- Transparent weighted rubric over normalized explicit features.
- Machine-readable rationale codes; no AI prose in scoring truth.
- Feature-set mismatch fails closed.
- Missing required features produce `insufficient-data`; values are never imputed.
- Invalid normalized values/rubrics fail closed.
- Deterministic integer-basis-point score representation.
- Same input/version produces byte-equivalent output and is independent of wall-clock time.

### Point-in-time feature extraction — added

A pure bitemporal extractor now exists in the Brain package:

- Versioned `FeatureSetVersion` definitions map stable scanner/source keys to normalized Brain features.
- Every observation carries market `validAt` and system `recordedAt`.
- Historical extraction sees only facts with `validAt <= decisionAsOf` **and** `recordedAt <= knowledgeCutoff`.
- Later corrections cannot leak into an earlier historical decision replay.
- Feature freshness limits turn stale evidence into explicit missing data rather than silently carrying it forward.
- Contradictory facts at identical bitemporal coordinates fail closed.
- Impossible clock-domain evidence (`recordedAt < validAt`), NaN/infinite values and out-of-contract normalization ranges fail closed.
- Extraction is deterministic regardless of input observation ordering.
- Pipeline regression proves `point-in-time extraction → deterministic evaluate` exactly replays the original historical score with the original knowledge cutoff.
- The same test proves a later correction may change a later hindsight query, but cannot retroactively alter the original decision replay.
- Missing point-in-time evidence flows through to Brain as `insufficient-data` rather than a fabricated score.

Not yet wired:

- Adapter from actual immutable scan/Mission ledger observations into `BitemporalFeatureObservation`.
- Brain output persistence into Mission decision facts.
- Brain → Mission candidate/planning runtime integration.
- Champion/challenger registry and forward-only paired evaluation.
- LLM explanation/query/hypothesis edge.
- ADR-0020 memory and ADR-0021 evaluation runtime layers.

The LLM remains outside actionable scoring and broker/account truth.

## ADR-0018 exit status

**IN PROGRESS — repository ownership boundary substantially hardened.**

The dead direct `/orders` compatibility handler is now removed. Remaining blockers are no longer a known server-side Mission-less execution path; they are final cross-client audit and external/native runtime proof/product packaging.

Brain pure-library work may continue in isolation. Brain-to-Mission/execution integration must remain controlled and cannot create a privileged execution path.

## Verification ladder

| Stage | Status | Evidence / boundary |
| --- | --- | --- |
| Architecture ADR-0015–0022 | **DONE** | Accepted ADRs + `docs/BRAIN-DESIGN-REVIEW.md`. |
| Repository MT5 foundation | **SUBSTANTIALLY DONE** | Deterministic execution truth, instrument/margin/recovery wiring built; target-terminal proof remains external. |
| Repository lint/typecheck/tests | **PASS** | Exact code head `3c1cbf5ab8c9ef4826f394e59be1ee424603b468` passed GitHub Actions `verify` after Mission handler removal, bitemporal feature extraction and point-in-time Brain pipeline tests. This documentation commit needs its own exact-head CI before being called green. |
| Simulation/chaos | **STRONG, NOT COMPLETE** | Duplicate/recovery/clock/partial-fill/margin/Mission replay covered; target terminal/device restart remains external. |
| Trade Mission spine | **IN PROGRESS — OWNERSHIP BOUNDARY HARDENED** | Durable lifecycle + server/Android/Desktop Mission truth exist; direct Mission-less POST handler physically removed; final cross-client/native audit remains. |
| Android pairing | **REPOSITORY BUILT / DEVICE PROOF BLOCKED** | Controller/screen/persistence fail closed; native hardware-backed proof external. |
| Windows Mission shell | **REPOSITORY BUILT / NATIVE PACKAGING BLOCKED** | Single-runtime shell and stale-state guard built; native bridge/packaging proof external. |
| Realtime + command auth | **REPOSITORY DONE** | Signed stream admission, replay guard, command nonce, heartbeat/resync coverage. |
| Trading Brain | **DETERMINISTIC FOUNDATION + PIT EXTRACTION BUILT** | Pure versioned scoring and bitemporal feature extraction built; actual ledger/Mission runtime adapter not yet wired. |
| Memory/Evaluation | **DESIGNED / BLOCKED** | Must derive from immutable Mission/Brain facts; no AI conclusions as memory truth. |
| MetaEditor compile | **NOT VERIFIED** | Requires Windows/MetaEditor. |
| Real MT5 terminal | **NOT VERIFIED** | Requires target terminal. |
| LiteFinance Demo E2E | **NOT VERIFIED** | Requires Windows + MT5 + broker Demo. |

## External verification boundary — NOT VERIFIED

Repository CI does not prove:

- MetaEditor compilation of `KeelAgent.mq5` and included `.mqh` files;
- EA attach/runtime in target MT5;
- target-terminal `TimeGMT`, `TimeTradeServer`, symbol selection and spool durability;
- real `OrderCheck` / `OrderCalcMargin` behavior on LiteFinance Demo;
- actual LiteFinance symbol aliases, filling modes and account position model;
- host/EA/terminal restart and reconnect against broker truth;
- App → Desk → host → EA → MT5 → LiteFinance end-to-end runtime;
- physical Android key provisioning/storage/background behavior;
- actual Windows native key provider, protected key persistence, hardware-backed classification, packaging/runtime;
- any real-money execution.

No real-money execution is enabled or claimed.

## Next highest-priority sequence

1. Continue the ADR-0018 independent replay/reconnect/bypass audit and remove any remaining client/server path that can create consequential state without durable Mission provenance.
2. Implement the actual immutable scan-ledger → bitemporal Brain observation adapter; preserve original valid-time/recorded-time and reject hindsight leakage.
3. Persist versioned deterministic Brain observations/outputs as durable Mission evidence without granting Brain execution authority.
4. Add champion/challenger registry with challenger creation time and forward-only paired evidence; never auto-promote.
5. Implement ADR-0021 evaluation before ADR-0020 derived memory so memory is built only from validated evidence.
6. Keep LLM work quarantined to explanation/query/hypothesis generation and validate all displayed figures against deterministic fields.
7. Keep Windows/Android native security, MetaEditor, MT5 and LiteFinance Demo on the external verification ladder until physically proven.
