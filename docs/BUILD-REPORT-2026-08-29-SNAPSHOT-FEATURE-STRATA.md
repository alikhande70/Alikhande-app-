# Build report — snapshot-derived feature strata

Date: 2026-08-29  
Branch: `gpt/trading-brain-build`

## Scope

This milestone closes the ADR-0021 gap where market-condition/feature-strata evaluation accepted a caller-supplied `FeatureStrataEvidence` projection even though the authoritative deterministic feature evidence was already sealed inside each immutable Trade Mission `DecisionSnapshot`.

The new preferred boundary is `@keel/brain/snapshot-feature-strata`.

## Implemented

- Added `projectSnapshotFeatureStrataEvidence()` to derive the registered market-condition feature directly from immutable Mission decision snapshots.
- Added `buildSnapshotStrataAwarePreRegisteredEvaluation()` so the dependence-aware, pre-registered strata evaluator receives evidence derived from durable snapshots rather than a free-form caller projection.
- Added an exact `featureSetVersion` requirement to the pre-registered feature-strata policy. A cohort containing a different feature schema fails closed rather than silently reinterpreting historical values.
- Preserved missing snapshots, missing Brain evaluations and explicitly missing target features as missing evidence. No later value is imputed or backfilled.
- Enforced `decisionAsOf === snapshot.asOf`, `knowledgeCutoff >= decisionAsOf`, `validAt <= snapshot.asOf`, and `recordedAt <= knowledgeCutoff` for persisted feature coordinates.
- Reject duplicate Mission identities, duplicate feature keys, duplicate missing keys, impossible snapshot/observation ordering, values outside `[0,1]`, and features that are neither persisted nor explicitly recorded as missing.
- Added the new package export `@keel/brain/snapshot-feature-strata`.

## Red-team / failure cases

Repository tests cover:

1. exact projection of the immutable bitemporal value;
2. absent Decision Snapshot remains missing rather than fabricated;
3. explicitly missing decision-time feature remains missing;
4. feature-set/schema drift fails closed;
5. feature learned after the sealed knowledge cutoff is rejected;
6. future market evidence is rejected;
7. silently absent feature is rejected;
8. duplicate Mission identity cannot inflate evidence;
9. duplicate feature coordinates in a malformed snapshot are rejected;
10. snapshot time before the market observation is rejected.

## CI repair

The first verification run on the new files failed at Biome only, before typecheck/tests. The logged formatter/import-order diff was applied exactly. No invariant, assertion, failure case or coverage gate was weakened or removed.

Implementation/style head `dbd2c05dccab9ff4faaef0808a7bfd39cd3bbacf` passed GitHub Actions `verify` run 797: repository lint, typecheck and full tests all succeeded.

## Verification ladder

| Stage | Status | Evidence / boundary |
| --- | --- | --- |
| Immutable Mission feature source | **PASS** | Strata evidence is derived from sealed Decision Snapshot Brain evidence. |
| Feature schema/version integrity | **PASS** | Exact registered `featureSetVersion`; mixed historical schemas fail closed. |
| Bitemporal leakage guards | **PASS** | Future-valid or post-cutoff-recorded feature evidence is rejected. |
| Missing-data integrity | **PASS** | Missing snapshot/evaluation/feature remains missing; no imputation or AI backfill. |
| Duplicate/tamper-style guards | **PASS** | Duplicate Mission/feature identities and malformed timelines are rejected. |
| Repository lint/typecheck/tests | **PASS** | GitHub Actions `verify` run 797 on `dbd2c05dccab9ff4faaef0808a7bfd39cd3bbacf`. |
| Windows/MT5/LiteFinance Demo runtime | **NOT CHANGED / EXTERNAL** | This milestone adds no broker or execution path. Existing external verification boundary remains. |
| Real-money execution | **NOT ENABLED / NOT CLAIMED** | No execution authority was added. |

## Architecture boundaries preserved

- The deterministic Brain remains the only source of actionable Brain scores.
- The LLM has no role in feature extraction, feature strata, statistical readiness, broker truth or account truth.
- Challenger evidence remains shadow-only and cannot promote itself.
- No automatic promotion API was added.
- No order, risk, broker, MT5 or account-truth path was changed.
- ADR-0020 Memory remains intentionally blocked until ADR-0021 evaluation is fully validated and independently red-teamed.

## Remaining ADR-0021 work

This milestone removes the snapshot/projection mismatch. ADR-0021 is not yet declared complete. The next audit should compose the complete evaluation boundary around the hash-verified Desk population and verify that every denominator, paired outcome, dependence/episode guard, longitudinal maturity guard and snapshot-derived strata input shares one immutable Mission identity/cutoff path. That final composition must be red-teamed for cohort drift, repeated evidence, missing-data inflation and any remaining route around the registered analysis plan before Memory begins.
