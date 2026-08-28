# BUILD REPORT — FEATURE STRATA EVIDENCE GUARD

Date: 2026-08-29
Branch: `gpt/trading-brain-build`

## Scope

This milestone advances ADR-0021 after dependence-aware episode clustering and longitudinal maturity.
It does not enable execution, alter broker truth, promote a Brain version, or use an LLM-generated regime label.

## Implemented

- Added `@keel/brain/feature-strata-guard`.
- Added `@keel/brain/strata-aware-evaluation` as the next conservative evaluation boundary.
- Market-condition coverage is derived from a pre-registered normalized deterministic feature, not AI prose or a mutable current-state regime label.
- Fixed feature boundaries are part of the analysis plan and therefore cannot be tuned after forward evidence is seen without defining a new plan.
- Every eligible scan remains in the feature-evidence denominator; missing feature evidence is explicit.
- Any decisive directional Mission with missing feature evidence blocks readiness.
- Evidence is rejected if it is future-valid, recorded after the scan knowledge-time, duplicated, malformed, or attached to an ineligible Mission.
- Both full eligible population coverage and directional-evidence stratum spread are checked.
- Directional evidence can be blocked when too much of it is concentrated in one stratum.

## Why

Independent market episodes can still all arise in one narrow market condition. Counting them as mature evidence can overstate generality. The guard therefore asks a narrower and auditable question: does the forward evidence span pre-registered regions of a deterministic decision-time market feature, with missing data kept visible?

This avoids a common architectural trap: asking an LLM to name the market regime and then using that label as statistical truth. AI output remains explanation/query/hypothesis only.

## Verification ladder

1. Static type boundary: deterministic normalized feature evidence only.
2. Bitemporal guard: `validAt <= observedAt`, `recordedAt <= knownAt`, and `recordedAt >= validAt`.
3. Denominator guard: missing eligible feature evidence is retained and reported.
4. Directional guard: missing decisive evidence blocks readiness.
5. Concentration guard: pre-registered minimum occupied strata and maximum one-stratum share.
6. Chaos tests: future evidence, late evidence, duplicates, ineligible Mission IDs, malformed boundaries.
7. Repository CI must pass on the exact committed head before this milestone is claimed complete.

## Remaining ADR-0021 work

- Wire feature-strata evidence directly from Desk's hash-verified persisted Decision Snapshot evidence rather than accepting a separately supplied projection at the Brain boundary.
- Add multi-feature / versioned market-condition policy only if justified by pre-registration and sample size; do not multiply strata until evidence supports it.
- Red-team feature-set/version drift and ensure one analysis cannot mix incompatible feature definitions.
- Complete the independent evaluation audit before beginning ADR-0020 validated memory.

## Safety boundary

No automatic self-promotion, no LLM actionable score, no new broker command, and no real-money execution were added.
