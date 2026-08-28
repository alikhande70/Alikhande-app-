# Build report — `gpt/trading-brain-build`

This report separates repository evidence from external Windows, MetaEditor, MT5, LiteFinance and physical-device evidence. ADRs define intended architecture; this file records only implemented or still-unverified state.

## Current state — 2026-08-28

The repository-level MT5/execution foundation is substantially built and remains fail-closed. Real-money execution is not enabled or claimed.

ADR-0018 Trade Mission is the durable aggregate above execution truth. Scans, rejected setups, lifecycle actions, Mission-bound intents, broker positions, external/manual MT5 positions, close/review and client realtime state are durable/reconstructable. The historical direct Mission-less `POST /orders` execution handler is physically removed; its deterministic `410 MISSION_REQUIRED` tombstone and a regression test remain.

ADR-0019 now has a deterministic/versioned Brain foundation, immutable Mission-ledger → bitemporal observation projection, point-in-time feature extraction, durable deterministic decision evidence, immutable ADR-0022 version registry and durable paired champion/challenger shadow evidence on the same Mission. Only champion evidence is copied into the primary decision field; challengers remain shadow-only and have no execution authority.

The preserved branch `claude/personal-trading-app-atm6e1` remains outside this workstream and must stay untouched.

## MT5 execution foundation — repository evidence

Implemented and covered by repository tests:

- Loopback Windows execution-host ↔ `KeelAgent.mq5` protocol with authenticated agent sessions.
- Durable command lifecycle, ambiguity handling and broker reconciliation instead of unsafe retry.
- MT5 orders/deals/positions remain distinct; 64-bit broker ids remain decimal strings.
- Partial-fill aggregation and duplicate/contradictory execution detection.
- Separate broker-local and UTC clock domains with freshness guards.
- Explicit venue-symbol ↔ canonical mapping and tradable-universe/instrument-facts binding.
- Runtime-selectable MT5 broker adapter with truthful capabilities.
- Durable event spool/replay while reconciliation remains authoritative.
- Request-specific margin path through `ExecutionSupervisor → BrokerPort → MT5 adapter → host → EA → OrderCalcMargin`.
- Margin fingerprint/freshness validation; missing/malformed/stale/mismatched/unavailable margin is **BLOCK**, never zero and never waivable.
- Real-account safety remains hard-gated.

External proof is still required for MetaEditor compilation, target-terminal runtime, LiteFinance Demo behavior and actual Windows/device security.

## ADR-0018 Trade Mission — repository evidence

Implemented:

- Durable stages from `OBSERVED` through `CLOSED/ABANDONED` and `REVIEWED`.
- Distinct scanner/Brain/operator/manual-MT5/external origins.
- Append-only hash-chained Mission facts; no second mutable broker truth database.
- Bitemporal valid-time/recorded-time separation and versioned scan configuration.
- Immutable `DecisionSnapshot` records both known and missing data at decision time.
- Rejected/untraded scans remain complete durable records.
- External/manual MT5 positions enter management without fabricated Brain attribution.
- Internal ownership requires durable `clientOrderId → intent.created → mission.intentLinked` provenance, never fuzzy similarity.
- Mission ownership is recorded before intent creation; restart repair closes the crash gap from durable facts.
- Canonical contradictions fail closed and broker close events affect only durably linked Missions.
- Decision review remains separate from realised outcome/counterfactual evidence.
- Android/Desktop consequential paths require current Mission truth and `/missions/:missionId/orders`.
- Mission-less `POST /orders` is physically retired; source regression prevents handler reintroduction.

Repository/native work still open:

1. Continue independent replay/reconnect/bypass audit across Desk, Android and Desktop.
2. Package/bind the Windows UI around the single `WindowsMissionAppShell` without local trading truth.
3. Keep Android/Windows hardware-backed key claims external until real-device proof exists.

## Client/security paths — repository evidence

Android and Windows signed command paths use enrolled-device identity, command nonce and current Mission truth. Stale/gapped last-known state can be displayed but cannot authorize a new consequential action. Authenticated realtime requires a signed hello, rejects malformed/replayed/stale/bad-signature admission, and uses heartbeat/resync protection.

`WindowsProtectedSigner` exposes only an opaque native-provider boundary; repository metadata does not contain private key material. Missing/orphan/malformed key states fail closed. Hardware-backed status is not treated as verified until target-Windows proof exists.

## ADR-0019 deterministic Brain

Implemented:

- Pure deterministic `evaluate(BrainVersion, FeatureVector, Context)` with no clock/network/filesystem/broker/account/environment/LLM dependency.
- Explicit `brainVersion`, `featureSetVersion`, `rubricVersion` provenance.
- Transparent normalized weighted rubric and machine-readable rationale codes.
- Version/feature mismatch and invalid values fail closed.
- Missing required features produce explicit `insufficient-data`; no imputation.
- Integer-basis-point score representation for stable replay.
- Same input/version yields byte-equivalent output independent of wall-clock time.

### Point-in-time evidence

- Versioned feature definitions map stable scanner/source keys to normalized features.
- Every observation carries market `validAt` and system `recordedAt`.
- Historical extraction admits only `validAt <= decisionAsOf` and `recordedAt <= knowledgeCutoff`.
- Later corrections cannot leak into an earlier decision replay.
- Stale/contradictory/impossible-clock/NaN/out-of-contract evidence fails closed or becomes explicit missing data as appropriate.
- `observationsFromMissionLedger()` projects immutable Mission observations without consulting current projections or AI output.
- Regression coverage proves `Mission ledger → bitemporal extraction → deterministic Brain` replays original historical decisions with the original cutoff.

### Durable Brain decision evidence

`mission.snapshotSealed` can carry full deterministic Brain evidence:

- exact semantic versions and point-in-time cutoffs;
- scored or explicit `insufficient-data` status;
- machine rationale codes and exact missing fields;
- per-feature source key, valid/recorded times, raw value and normalized value;
- fail-closed vector/evidence consistency and hindsight guards.

The bridge performs no market/clock/network/LLM reads and creates no order intent.

## ADR-0022 versioning + paired forward evidence

The immutable registry enforces:

- required `sha256:` content identity, semantic version, sealed `createdAt`, role, change summary and optional hypothesis id;
- exactly one champion; duplicate/malformed/ambiguous identities fail closed;
- challenger eligibility only when `missionKnowledgeTime > challenger.createdAt` — equality and pre-creation Missions are excluded;
- retired versions do not re-enter active challenger comparison;
- deterministic concurrent-challenger ordering;
- no automatic promotion API.

### Durable same-Mission comparison — added in this build

`DecisionSnapshot.brainComparison` now persists paired shadow evidence for the champion and every eligible challenger on the **same Mission**:

- exact immutable content hash, semantic Brain result and version creation time are retained for each participant;
- every paired version must use the exact same `missionKnowledgeTime`/knowledge cutoff;
- a challenger at or before its own creation boundary is rejected before persistence;
- duplicate content hashes or semantic Brain ids fail closed;
- each version independently passes the existing point-in-time feature/evidence invariants;
- challengers are sorted deterministically by content hash;
- the champion alone populates the primary `brainEvaluation` and therefore remains the only Brain result that can continue toward risk/execution;
- challenger `insufficient-data` does not contaminate the champion's decision `missing` set;
- durable Mission-ledger regression proves paired evidence can be sealed without creating `intent.created`.

This is the evidence spine only. ADR-0021 still owns statistics, minimum sample/duration gates, calibration/guardrails and the explicit operator promotion decision.

## Evaluation and memory status

Not yet implemented as runtime layers:

- ADR-0021 scan-level evaluation dataset/statistics;
- separation of decision-quality metrics from realised outcome metrics in the evaluator;
- bootstrap paired-difference confidence intervals and pre-registered sample/duration gates;
- regime/calibration/false-signal/risk-quality/expectancy guardrails;
- explicit operator promotion workflow;
- ADR-0020 validated-memory derivation over immutable bitemporal observations;
- LLM explanation/query/hypothesis edge.

No AI conclusion is stored as memory truth and no LLM output participates in actionable scoring or broker/account truth.

## Verification ladder

| Stage | Status | Evidence / boundary |
| --- | --- | --- |
| Architecture ADR-0015–0022 | **DONE** | Accepted ADRs + `docs/BRAIN-DESIGN-REVIEW.md`. |
| Repository MT5 foundation | **SUBSTANTIALLY DONE** | Deterministic execution truth, instrument/margin/recovery wiring built; target-terminal proof external. |
| Repository lint/typecheck/tests | **PASS** | Exact implementation head passed GitHub Actions `verify` after paired-evidence regression tests and formatter repairs. |
| Simulation/chaos | **STRONG, NOT COMPLETE** | Duplicate/recovery/clock/partial-fill/margin/Mission replay covered; target terminal/device restart external. |
| Trade Mission spine | **IN PROGRESS — OWNERSHIP BOUNDARY HARDENED** | Durable lifecycle and Mission truth across server/clients; final cross-client/native audit remains. |
| Android pairing | **REPOSITORY BUILT / DEVICE PROOF BLOCKED** | Fail-closed controller/persistence; hardware-backed proof external. |
| Windows Mission shell | **REPOSITORY BUILT / NATIVE PACKAGING BLOCKED** | Single-runtime shell and stale-state guard built; native bridge/packaging proof external. |
| Realtime + command auth | **REPOSITORY DONE** | Signed admission, replay guard, command nonce, heartbeat/resync coverage. |
| Trading Brain | **DETERMINISTIC + PIT + DURABLE PAIRED EVIDENCE BUILT** | Pure scoring, bitemporal projection/extraction, immutable decision evidence, version registry and same-Mission champion/challenger persistence built. |
| Evaluation | **NEXT** | Must use scan-level forward-only paired evidence, explicit insufficient-data and separate decision/outcome measures. |
| Memory | **DESIGNED / BLOCKED ON VALIDATED EVALUATION** | Must derive from immutable bitemporal facts/statistics; never AI conclusions. |
| MetaEditor compile | **NOT VERIFIED** | Requires Windows/MetaEditor. |
| Real MT5 terminal | **NOT VERIFIED** | Requires target terminal. |
| LiteFinance Demo E2E | **NOT VERIFIED** | Requires Windows + MT5 + broker Demo. |

## External verification boundary — NOT VERIFIED

Repository CI does not prove MetaEditor compilation, EA attach/runtime in target MT5, LiteFinance symbol/filling/account behavior, real `OrderCheck`/`OrderCalcMargin`, host/EA/terminal restart against broker truth, full App → Desk → host → EA → MT5 → LiteFinance Demo E2E, physical Android key behavior, actual Windows native protected key persistence/packaging, or any real-money execution.

No real-money execution is enabled or claimed.

## Next highest-priority sequence

1. Continue the ADR-0018 cross-client replay/reconnect/bypass audit while preserving the hardened Mission ownership boundary.
2. Build ADR-0021 evaluation input from **scan-level durable paired Mission evidence**, including rejected/untraded scans and explicit insufficient-data states.
3. Keep decision-quality assessment structurally separate from realised outcome, then implement forward-only paired statistics and pre-registered sample/duration/guardrail checks.
4. Add only an explicit operator-controlled promotion workflow; never automatic self-promotion.
5. Implement ADR-0020 memory only as derived validated knowledge over immutable bitemporal observations/statistics.
6. Add LLM explanation/query/hypothesis generation only after deterministic figures are available for validation.
7. Keep Windows/Android native security, MetaEditor, MT5 and LiteFinance Demo on the external verification ladder until physically proven.
