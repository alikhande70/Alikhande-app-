# Build Report — Forward Paired Outcome Inference

Date: 2026-08-28
Branch: `gpt/trading-brain-build`
Architecture: ADR-0021 / ADR-0022

## Objective

Close the next evaluation gap after the durable Mission-to-outcome pipeline: compare Champion and Challenger on the same forward-only Mission population and the same immutable future outcome, while preserving the rule that Brain rubric scores are not probabilities and that no evaluation code can auto-promote a Brain version.

## Implemented

- Added `inferForwardPairedOutcomeAlignment` in `@keel/brain/paired-inference`.
- Reuses the existing `buildForwardPairedCohort` gate, so pre-challenger Missions, changing Brain hashes, scan-configuration drift, duplicate Missions, and insufficient forward duration remain fail-closed.
- Requires one versioned outcome-label policy for the paired cohort.
- Requires each outcome label to match the exact Mission and decision knowledge-time.
- Rejects non-forward or bitemporally impossible outcome evidence.
- Applies the historical `evaluationCutoff`; an outcome learned later is unavailable rather than leaked backward.
- Preserves flat outcomes, tied Brain scores, and insufficient-data decisions as explicit population facts instead of silently removing them.
- Adds an outcome-coverage gate so a small selectively labelled subset cannot masquerade as full paired evidence.
- Adds a minimum decisive directional-comparison gate.
- Evaluates ordinal alignment only: for favourable future setup outcomes, the higher score is better aligned; for unfavourable outcomes, the lower score is better aligned. No score is interpreted as a probability.
- Reports a fixed Wilson 95% interval for Challenger alignment share. This provides uncertainty without a caller-tunable significance parameter.
- Emits only `challenger-favouring`, `champion-favouring`, `inconclusive`, or `insufficient-data`. It emits no winner, promotion, recommendation, broker command, or execution side effect.

## Verification Ladder

1. Repository/CI state inspected before implementation; prior exact head was green.
2. Unit coverage added for favourable and unfavourable ordinal alignment.
3. Balanced paired evidence must remain inconclusive.
4. Historical-cutoff leakage test keeps late outcomes unavailable.
5. Flat outcomes, tied scores, and insufficient Brain data cannot inflate decisive evidence.
6. Red-team tests reject outcome identity mismatch, temporal corruption, cohort leakage, and label-version drift.
7. Package public export added for `@keel/brain/paired-inference`.
8. CI must pass lint, typecheck, and tests on the exact implementation commit before this milestone is considered verified.

## Safety / Authority Boundary

This change is read-only evaluation logic. It does not add `OrderSend`, broker access, registry mutation, automatic self-promotion, LLM scoring, or real-money execution. Champion/Challenger interpretation remains evidence for human/system review only.

## Remaining ADR-0021 Work

- Compose durable Desk population, durable paired Brain evidence, and fixed-horizon outcome labels through one top-level evaluation entry point.
- Add longitudinal/statistical drift diagnostics across forward cohorts without mixing scan configuration or outcome-label versions.
- Red-team repeated looks / optional stopping and ensure reports make evidence maturity explicit.
- Only after ADR-0021 is complete should ADR-0020 Memory derive validated knowledge from immutable bitemporal observations and accepted evaluation evidence.
