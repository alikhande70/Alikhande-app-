# ADR-0021 build report addendum — durable Mission evaluation projection

Date: 2026-08-28
Branch: `gpt/trading-brain-build`

This addendum records repository evidence added after the current `docs/BUILD-REPORT.md` evaluation section. It does not upgrade any external Windows, MetaEditor, MT5, LiteFinance Demo or physical-device claim.

## Implemented

`@keel/brain` now contains a deterministic Mission-to-evaluation projection in `packages/brain/src/mission-evaluation.ts`.

The projection accepts structurally compatible durable Mission records and converts sealed Mission decision evidence into `ScanDecisionEvidence` consumed by the existing ADR-0021 scan-population evaluator.

The projection preserves these invariants:

- Mission id and `scanConfigVersion` are required and are never reconstructed from current state.
- The immutable champion content hash comes from the Mission's sealed `brainComparison.championHash`; semantic version text is never treated as immutable identity.
- The Brain `knowledgeCutoff` and paired comparison `missionKnowledgeTime` must be identical or the projection fails closed.
- `insufficient-data` remains explicit and retains the exact missing-field set; the bridge never invents a score.
- Future-outcome labels are versioned and bound to the exact Mission id and decision knowledge cutoff that produced the historical decision.
- Outcome `validAt` must be strictly after decision knowledge time.
- Outcome `recordedAt` must be at or after `validAt`, preserving bitemporal ordering.
- Duplicate labels for one Mission fail closed instead of allowing last-write-wins contamination.
- Counterfactual market R and realised trade R remain separate downstream fields.

`@keel/brain` also exposes the projection as the public subpath `@keel/brain/mission-evaluation`, avoiding unsupported deep imports when Desk wiring is added.

## Regression / failure coverage

`packages/brain/src/mission-evaluation.test.ts` covers:

1. Durable Mission evidence flowing directly into `evaluateScanPopulation()`.
2. Explicit `insufficient-data` propagation without score fabrication.
3. Rejection of outcome labels generated against a different historical decision cutoff.
4. Rejection of hindsight labels where outcome valid time is not strictly forward.
5. Rejection of impossible `recordedAt < validAt` ordering.
6. Rejection of Missions lacking sealed immutable Brain identity.
7. Rejection of divergent Brain/comparison knowledge cutoffs.
8. Rejection of duplicate outcome labels.

During implementation, CI exposed formatter failures. The exact Biome diff was read from the GitHub Actions job log and repaired without relaxing a test or invariant. The subsequent code head passed the complete `pnpm verify` chain: lint, typecheck and tests.

## Verification ladder update

| Stage | Status | Evidence / boundary |
| --- | --- | --- |
| Durable Mission -> ADR-0021 scan projection | **BUILT + TESTED** | Sealed Brain identity/cutoff projected directly into evaluator evidence; fail-closed bitemporal guards. |
| Versioned future-outcome evidence contract | **FOUNDATION BUILT** | Version, Mission identity, decision cutoff, valid time and recorded time enforced. Actual market-data label generator remains next. |
| Repository lint/typecheck/tests | **PASS on code head before this documentation commit** | GitHub Actions `verify` passed after formatter repair. This docs commit must also pass before being treated as final head. |
| Paired champion/challenger statistical inference | **IN PROGRESS** | Forward-only paired cohort exists; inferential statistics/uncertainty still not implemented. |
| Operator-controlled promotion | **NOT IMPLEMENTED** | No automatic self-promotion exists. |
| ADR-0020 Memory | **BLOCKED BY DESIGN** | Must wait for validated evaluation facts and derive knowledge from immutable bitemporal observations, never AI conclusions. |
| MetaEditor / real MT5 / LiteFinance Demo | **NOT VERIFIED** | Requires external Windows/terminal/broker validation. |
| Real-money execution | **NOT ENABLED / NOT CLAIMED** | Remains outside repository verification and requires explicit authorization plus external validation. |

## Next sequence

1. Wire the Desk Mission history reader to `@keel/brain/mission-evaluation` without introducing a parallel mutable truth store.
2. Build a versioned future-outcome label generator from market-data facts, with a fixed horizon and explicit conservative fill/counterfactual rules.
3. Add end-to-end leakage tests across Mission ledger -> outcome facts -> evaluator cutoff.
4. Add pre-registered paired statistical inference with uncertainty and insufficient-data states; do not reinterpret the current 0-100 rubric score as probability.
5. Only after validated evaluation evidence exists, derive ADR-0020 Memory facts from immutable bitemporal observations/statistics.
6. Keep LLM use restricted to explanation, querying and hypothesis generation; it must not emit actionable scores, promotion decisions, broker truth or account truth.
