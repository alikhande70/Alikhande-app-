# Build Report — Pre-Registered Evaluation Composition

Date: 2026-08-28
Branch: `gpt/trading-brain-build`
Architecture: ADR-0021 / ADR-0022

## Objective

Close the repeated-look / optional-stopping gap in Champion/Challenger evaluation by composing durable Mission evidence, fixed-horizon market outcomes and paired inference behind one fixed, pre-registered analysis boundary. The evaluator must not reveal paired inference while the evidence window is still open, and later re-runs must not keep accumulating evidence until a favourable answer appears.

## Implemented

- Added `buildPreRegisteredEvaluation()` in `@keel/brain/pre-registered-evaluation`.
- Added a versionable analysis-plan boundary with stable `planId`, immutable Challenger content hash, durable registration time, fixed analysis cutoff and minimum pairing-coverage requirement.
- The analysis plan must exist no earlier than Challenger creation and no later than the first forward Mission that could contribute Challenger evidence. If forward evidence has already begun before registration, evaluation fails closed.
- Before the fixed analysis cutoff, paired inference is intentionally unavailable and the API returns only `analysis-window-open` for the paired layer.
- After the cutoff, every later re-run uses the same fixed analysis cutoff. Evidence arriving after that cutoff cannot expand the paired cohort or alter the paired inference.
- The top-level result deliberately does not expose raw future outcome labels, avoiding an accidental pre-cutoff side channel around the inference gate.
- Aggregate scan evaluation remains available under its own historical cutoff, but that cutoff cannot be later than the caller's current knowledge boundary.
- Eligible paired population is defined before checking whether a target Challenger shadow result exists. Missing Challenger shadow scans remain in the denominator through `pairingCoverage` instead of silently disappearing.
- Pairing below the pre-registered coverage threshold yields explicit `insufficient-data`.
- The target Challenger projection must be one-to-one with the durable Mission subset used for paired inference.
- Challenger creation time must be consistent across durable Mission evidence; conflicting creation identities fail closed.
- The existing fixed-horizon outcome label, forward-only Mission gate, historical outcome-availability gate and Wilson uncertainty layer are reused rather than duplicated.
- Added a public package export: `@keel/brain/pre-registered-evaluation`.

## Tests / Red-Team Cases

Coverage added for:

1. Paired inference is not exposed before the pre-registered analysis cutoff.
2. Once the analysis window closes, a much later run produces the same paired inference even when additional market data exists.
3. Registering the analysis plan after forward Challenger evidence has already started fails closed.
4. A Mission missing the target Challenger shadow result remains in the denominator and can force `minimum-pairing-coverage-not-met`.
5. Conflicting Challenger creation timestamps fail closed.
6. Aggregate evaluation cannot claim knowledge from a cutoff later than the system's current knowledge boundary.

## Verification Ladder

1. Repository branch and latest CI were inspected before changes; prior head `6f05577d8da76eedd8e8378d4fa1a8f8ad618e79` was green.
2. Source, tests and package export were committed on `gpt/trading-brain-build` only.
3. Initial CI reached lint and failed only on Biome import/formatting rules; the exact formatter diff was applied without weakening any invariant or test.
4. Final implementation head `5178f52cb3c3d82333153d3f9f8f7ee7c11efe8e` passed GitHub Actions `verify` run 723, including lint, TypeScript typecheck and the full test suite.
5. `claude/personal-trading-app-atm6e1` remained unchanged at `fdfc9daff888229ccefe01977f91988a0caa9d5d` during this work.
6. This documentation commit must itself pass the repository `verify` workflow before the milestone is considered fully recorded.

## Safety / Authority Boundary

This change is read-only evaluation composition. It adds no MT5 order path, broker command, registry mutation, Brain self-promotion, LLM-generated score or real-money execution capability. A `challenger-favouring` statistical result remains evidence only; it is not a promotion instruction.

## Self-Audit

The new boundary closes the most direct repeated-look failure mode for a fixed analysis plan, but ADR-0021 is not complete yet.

One denominator limitation remains explicit: the paired eligibility calculation can only reason about Missions carrying durable `brainComparison` identity. Missions with no sealed comparison at all are represented elsewhere by the durable Desk population boundary, but they are not yet folded into this top-level paired denominator. The next composition step should reconcile that population accounting so missing sealed comparisons cannot become an invisible selection mechanism.

Longitudinal evaluation also still needs cohort-drift diagnostics and evidence-maturity rules that respect dependence between nearby scans. A simple count threshold must not be treated as independent statistical power when observations are clustered in time/regime.

## Next ADR-0021 Work

1. Compose the hash-verified Desk population accounting with this pre-registered evaluator so Missions lacking sealed comparison identity remain visible in the top-level evaluation denominator.
2. Add explicit cohort-drift diagnostics for scan configuration, outcome-label policy and relevant market/regime strata without hindsight relabelling.
3. Add dependence-aware / variance-informed evidence-maturity diagnostics for longitudinal forward cohorts.
4. Red-team the complete Desk ledger → Mission snapshot → fixed-horizon outcome → pre-registered paired inference path for replay, missing-shadow, cutoff and persistence failures.
5. Keep promotion explicitly operator-controlled and separate from statistical inference.
6. Only after ADR-0021 is genuinely closed should ADR-0020 Memory derive validated knowledge from immutable bitemporal observations and accepted statistical evidence.
