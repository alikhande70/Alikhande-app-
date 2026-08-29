# Build report — `gpt/trading-brain-build`

This report separates repository evidence from external Windows, MetaEditor, MT5, LiteFinance and physical-device evidence. ADRs define intended architecture; this file records only implemented or still-unverified state.

## Current state — 2026-08-28

The repository-level MT5/execution foundation is substantially built and remains fail-closed. Real-money execution is not enabled or claimed.

ADR-0018 Trade Mission is the durable aggregate above execution truth. Scans, rejected setups, lifecycle actions, Mission-bound intents, broker positions, external/manual MT5 positions, close/review and client realtime state are durable/reconstructable. The historical direct Mission-less `POST /orders` execution handler is physically removed; its deterministic `410 MISSION_REQUIRED` tombstone and a regression test remain.

ADR-0019 now has a deterministic/versioned Brain foundation, immutable Mission-ledger → bitemporal observation projection, point-in-time feature extraction, durable deterministic decision evidence, immutable ADR-0022 version registry and durable paired champion/challenger shadow evidence on the same Mission. Only champion evidence is copied into the primary decision field; challengers remain shadow-only and have no execution authority.

ADR-0021 now has a deterministic scan-population evaluation foundation, a forward-only paired-cohort gate, and a direct hash-verified Desk Mission-ledger population projection boundary. The projection consumes immutable Mission streams rather than a second truth store, surfaces sealed internal decisions, incomplete internal decisions and external/manual MT5 Missions as separate populations, and fails closed on ledger tampering, duplicate durable scan observations and impossible valid/recorded-time ordering. Decision evidence and future outcomes remain structurally separate; rejected and `insufficient-data` scans remain in the population; future outcomes are admitted only when they were known by the evaluation cutoff; scan-configuration/version drift and duplicate Missions fail closed. Paired champion/challenger cohorts reject any Mission at or before challenger creation, require one immutable version pair and one scan-configuration cohort, and expose only sample/duration/coverage evidence — never a winner or promotion action.

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

Important semantic boundary: the current Brain score is a deterministic rubric score, **not a calibrated probability**. ADR-0021 therefore does not compute Brier score/ECE from it. Probability calibration must wait for an explicitly defined, versioned probabilistic output with appropriate ground truth; relabelling the existing 0–100 rubric as probability would create false statistical confidence.

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

### Durable same-Mission comparison

`DecisionSnapshot.brainComparison` persists paired shadow evidence for the champion and every eligible challenger on the **same Mission**:

- exact immutable content hash, semantic Brain result and version creation time are retained for each participant;
- every paired version must use the exact same `missionKnowledgeTime`/knowledge cutoff;
- a challenger at or before its own creation boundary is rejected before persistence;
- duplicate content hashes or semantic Brain ids fail closed;
- each version independently passes the existing point-in-time feature/evidence invariants;
- challengers are sorted deterministically by content hash;
- the champion alone populates the primary `brainEvaluation` and therefore remains the only Brain result that can continue toward risk/execution;
- challenger `insufficient-data` does not contaminate the champion's decision `missing` set;
- durable Mission-ledger regression proves paired evidence can be sealed without creating `intent.created`.

ADR-0021 consumes this as evidence only. It still has no API that promotes a challenger.

## ADR-0021 evaluation — repository foundation

Implemented in `@keel/brain`:

### Scan-population evaluation

- The Mission/scan is the statistical unit; executed trades are not the population selector.
- Rejected/untraded and `insufficient-data` scans remain counted in `totalScans` and coverage.
- Duplicate Mission ids fail closed so retries/replays cannot inflate statistical power.
- A report is restricted to one versioned scan-configuration cohort and one immutable Brain content hash.
- Future market outcome evidence carries independent `validAt` and `recordedAt` coordinates.
- Outcomes must be strictly after the decision and cannot be recorded before they became valid.
- An evaluation cutoff excludes outcomes not yet known at that cutoff, protecting historical reports from later knowledge leakage.
- Decision evidence (`coverage`, scored vs missing, mean rubric score) is structurally separate from future outcome evidence.
- Market counterfactual R and realised trade R are separate fields and aggregates; realised account outcome cannot rewrite decision quality.
- Minimum scan/outcome gates return explicit `insufficient-data` reasons rather than manufacturing confidence.

### Forward-only paired cohort

`buildForwardPairedCohort()` provides the pre-inference gate for champion/challenger comparison:

- every Mission must have `knowledgeTime > challengerCreatedAt`; equality and pre-creation observations fail closed;
- duplicate Missions fail closed;
- all rows must share one scan configuration, champion content hash, challenger content hash and challenger creation boundary;
- champion and challenger content must differ;
- `insufficient-data` on either side is counted as population evidence rather than imputed;
- minimum paired-scan count and minimum forward duration are explicit caller-supplied/pre-registered policy inputs;
- insufficient sample or duration returns `insufficient-data` with machine-readable reasons;
- the report contains no winner, promotion flag or recommendation and cannot mutate the version registry.

### Durable Desk Mission population projection

Implemented in `@keel/desk` as a structural boundary rather than a second evaluation database:

- `buildMissionEvaluationPopulation()` reads directly from the append-only hash-chained Desk ledger and verifies the full chain before trusting any Mission facts.
- The projection captures a ledger head and paginates deterministically to that head; it does not consult a mutable Mission table, current Brain registry or AI output.
- Each internal Mission is reconstructed from its immutable stream with `reduceMission()`; sealed Brain decisions are projected with their original Decision Snapshot.
- Internal Missions without sealed Brain identity remain explicit in `pendingDecisionMissionIds` instead of disappearing from population accounting.
- Manual MT5, pending-activation and unknown external positions remain explicit in `externalMissionIds`; they are durable account truth but are never credited to a Brain version.
- Duplicate durable `mission.observed` events fail closed to prevent retry/replay inflation of scan sample size.
- A Mission whose market `observedAt` is after the ledger row's recorded timestamp fails closed as impossible bitemporal evidence.
- Snapshot seal time, decision `asOf`, Brain knowledge cutoff and paired-comparison knowledge time must be mutually consistent before projection.
- Tampering regression mutates a ledger row and proves the population builder refuses evaluation when the hash chain no longer verifies.
- Desk exports only structural durable facts here; it does not import `@keel/brain`, so the execution host does not gain Brain authority. Runtime composition can consume this view through `@keel/brain/mission-evaluation` outside the execution decision boundary.

### Deliberately not claimed complete

Still required before ADR-0021 can be called complete:

- runtime composition of the hash-verified Desk population boundary with `@keel/brain/mission-evaluation`, including durable extraction of same-Mission paired challenger evidence without a parallel truth store;
- versioned future-outcome labeling rules derived from market data rather than operator review;
- pre-registered statistical comparison over paired outcomes (including uncertainty/confidence intervals appropriate to the metric and observed dependence structure);
- regime/false-signal/risk-quality/expectancy guardrails where their ground truth is well-defined;
- sample-size/duration policy based on observed variance rather than an arbitrary fixed number;
- explicit human/operator promotion workflow, with no automatic self-promotion;
- leakage/red-team tests across the full Mission → outcome → evaluator persistence path.

## ADR-0020 memory status

Not yet implemented as a runtime layer. This remains intentionally blocked behind validated evaluation facts.

Memory must be derived from immutable bitemporal observations and validated statistics. AI/LLM conclusions are not memory truth, are not fed back into deterministic scoring, and cannot supply broker/account truth.

## Verification ladder

| Stage | Status | Evidence / boundary |
| --- | --- | --- |
| Architecture ADR-0015–0022 | **DONE** | Accepted ADRs + `docs/BRAIN-DESIGN-REVIEW.md`. |
| Repository MT5 foundation | **SUBSTANTIALLY DONE** | Deterministic execution truth, instrument/margin/recovery wiring built; target-terminal proof external. |
| Repository lint/typecheck/tests | **PASS** | Code head `8b90e71f4eb592303a55c333177088ba57af872d` passed GitHub Actions `verify` run 655 after the new hash-verified Mission-population and tamper/duplicate/bitemporal regressions plus the exact Biome repair. |
| Simulation/chaos | **STRONG, NOT COMPLETE** | Duplicate/recovery/clock/partial-fill/margin/Mission replay plus ledger-tamper evaluation refusal covered; target terminal/device restart external. |
| Trade Mission spine | **IN PROGRESS — OWNERSHIP BOUNDARY HARDENED** | Durable lifecycle and Mission truth across server/clients; final cross-client/native audit remains. |
| Android pairing | **REPOSITORY BUILT / DEVICE PROOF BLOCKED** | Fail-closed controller/persistence; hardware-backed proof external. |
| Windows Mission shell | **REPOSITORY BUILT / NATIVE PACKAGING BLOCKED** | Single-runtime shell and stale-state guard built; native bridge/packaging proof external. |
| Realtime + command auth | **REPOSITORY DONE** | Signed admission, replay guard, command nonce, heartbeat/resync coverage. |
| Trading Brain | **DETERMINISTIC + PIT + DURABLE PAIRED EVIDENCE BUILT** | Pure scoring, bitemporal projection/extraction, immutable decision evidence, version registry and same-Mission champion/challenger persistence built. |
| Evaluation | **FOUNDATION + DURABLE DESK POPULATION BOUNDARY BUILT / OUTCOME LABELING + INFERENCE IN PROGRESS** | Scan-level separation/leakage gates, forward-only paired gates and direct hash-verified Mission-ledger population projection are built; runtime composition, market-derived labels and statistical inference remain open. |
| Memory | **DESIGNED / BLOCKED ON VALIDATED EVALUATION** | Must derive from immutable bitemporal facts/statistics; never AI conclusions. |
| MetaEditor compile | **NOT VERIFIED** | Requires Windows/MetaEditor. |
| Real MT5 terminal | **NOT VERIFIED** | Requires target terminal. |
| LiteFinance Demo E2E | **NOT VERIFIED** | Requires Windows + MT5 + broker Demo. |

## External verification boundary — NOT VERIFIED

Repository CI does not prove MetaEditor compilation, EA attach/runtime in target MT5, LiteFinance symbol/filling/account behavior, real `OrderCheck`/`OrderCalcMargin`, host/EA/terminal restart against broker truth, full App → Desk → host → EA → MT5 → LiteFinance Demo E2E, physical Android key behavior, actual Windows native protected key persistence/packaging, or any real-money execution.

No real-money execution is enabled or claimed.

## Next highest-priority sequence

1. Continue the ADR-0018 cross-client replay/reconnect/bypass audit while preserving the hardened Mission ownership boundary.
2. Compose the hash-verified Desk population view with `@keel/brain/mission-evaluation` outside the execution authority boundary and project same-Mission champion/challenger evidence directly from immutable Decision Snapshots.
3. Define/version future-outcome labels from market data and add point-in-time leakage tests for the complete Mission → outcome → evaluation path.
4. Add pre-registered forward-only paired statistics and uncertainty measures appropriate to the actual outcome metric; do not treat the current rubric score as probability.
5. Add only an explicit operator-controlled promotion workflow; never automatic self-promotion.
6. Implement ADR-0020 memory only as derived validated knowledge over immutable bitemporal observations/statistics.
7. Add LLM explanation/query/hypothesis generation only after deterministic figures are available for validation.
8. Keep Windows/Android native security, MetaEditor, MT5 and LiteFinance Demo on the external verification ladder until physically proven.
