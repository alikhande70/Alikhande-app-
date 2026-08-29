# Build Report — Mission → Outcome → Evaluation Pipeline

Date: 2026-08-28
Branch: `gpt/trading-brain-build`
Architecture: ADR-0018 through ADR-0022 + `docs/BRAIN-DESIGN-REVIEW.md`

## Milestone

Closed the composition gap between durable Trade Mission decision snapshots, versioned fixed-horizon market outcome labels, and ADR-0021 scan-population evaluation.

The new public boundary is `@keel/brain/evaluation-pipeline`.

## What was implemented

`buildMissionEvaluationPipeline()` now composes, in one deterministic path:

1. immutable Mission decision evidence,
2. snapshot-derived direction/reference/risk basis,
3. exact-horizon market close observations,
4. versioned future-outcome labels,
5. cutoff-gated scan-level evaluation.

No mutable Brain registry, LLM output, broker/account state, or parallel truth store participates in this path.

## Preserved statistical population

A Mission is never removed merely because it lacks a directional plan or an exact-horizon market observation.

Those conditions are surfaced explicitly in `outcomeEvidenceGaps` while the Mission remains in scan evidence. This prevents missing evidence from silently shrinking the denominator and overstating statistical quality.

## Fail-closed invariants

The composition boundary rejects:

- duplicate durable Mission identities,
- duplicate market observation identity for the same symbol and valid time,
- malformed or impossible market timestamps,
- market observations recorded before they became valid,
- invalid prices,
- invalid fixed-horizon policies,
- unsafe outcome target timestamps.

All supplied market observations are validated, including observations that are not selected for a Mission horizon, so corrupt evidence cannot hide outside the chosen lookup.

## Leakage protection

The fixed-horizon label can exist before it is eligible for a historical evaluation report. `evaluateScanPopulation()` continues to count an outcome only when `recordedAt <= evaluationCutoff`.

Therefore a future result that the system had not yet learned at the requested historical cutoff is not allowed into the report.

No nearest-bar substitution was introduced; exact fixed-horizon semantics remain intact.

## Tests / red-team cases

Added coverage for:

- successful Mission → label → evaluation composition,
- missing exact-horizon market observation without scan deletion,
- missing directional plan without manufactured counterfactual,
- outcome learned after the evaluation cutoff,
- duplicate market identity,
- duplicate Mission identity / sample inflation,
- corrupt unused bitemporal market evidence.

During CI, two defects in the change set were found and corrected before the milestone was accepted:

1. Biome import/format ordering failures.
2. A test helper accidentally supplied its default plan when the test intended `undefined`; the test was rewritten to construct a truly plan-less durable snapshot.

No production invariant or test assertion was weakened to obtain a green build.

## Verification ladder

### Level 1 — Static boundary

PASS — public package export exists for `@keel/brain/evaluation-pipeline`.

### Level 2 — Deterministic unit / red-team tests

PASS — composition and failure cases are covered.

### Level 3 — Workspace lint + typecheck

PASS on implementation/test head `f3b94e3ed72fe6bcb4801927245e9684acd850cd`.

### Level 4 — Full workspace tests

PASS on implementation/test head `f3b94e3ed72fe6bcb4801927245e9684acd850cd` via GitHub Actions verify run 707.

### Level 5 — Demo/simulation evidence

The path is simulation-compatible and uses synthetic market observations in tests. Direct replay from a durable market-data archive remains a later integration step and is not claimed complete here.

### Level 6 — External MT5 / LiteFinance validation

Not affected by this milestone. No new broker command or execution path was added.

### Level 7 — Real-money validation

NOT AUTHORIZED / NOT CLAIMED.

## Remaining work

ADR-0021 is not yet complete. The next high-value step is to compose the durable paired Champion/Challenger evidence with the same versioned outcome facts and add paired statistical inference/uncertainty gates while preserving forward-only eligibility after Challenger creation.

After ADR-0021 is closed and red-teamed end-to-end, ADR-0020 Memory may derive validated knowledge from immutable bitemporal observations and validated evaluation facts. It must not store AI conclusions.

## Safety / authority statement

This milestone adds no automatic promotion, no LLM-generated actionable score, no broker/account truth from an LLM, no new `OrderSend` path, and no real-money execution capability.
