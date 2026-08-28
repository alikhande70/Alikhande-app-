# Build Report — Durable Paired Denominator

Date: 2026-08-29
Architecture: ADR-0021 / ADR-0022
Implementation verification head: `3ef65ead4aa7251bd31196847ba33d8155299d9e`

## Objective

Close the remaining selection-bias gap between the hash-verified Desk Mission ledger and pre-registered Champion/Challenger evaluation.

Before this change, a durable internal scan whose Decision Snapshot or `brainComparison` was missing was surfaced as pending by Desk but could disappear from the paired-evaluation denominator. That could overstate Challenger coverage and statistical readiness.

## Implemented

### Desk: full durable scan eligibility

`buildMissionEvaluationPopulation()` now emits `pairedEligibility` for every internal durable Mission observation before checking whether a complete Brain decision/comparison exists.

Each eligibility fact contains only immutable Desk facts:

- Mission ID
- canonical symbol
- scan configuration version
- market valid-time (`observedAt`)
- durable knowledge-time (`knownAt`, from the ledger row timestamp)

No Brain score, comparison result, LLM conclusion, broker state, or synthetic decision is created for a missing snapshot.

Manual/external MT5 Missions remain durable truth but are explicitly excluded from Brain credit and paired statistical populations.

### Brain: durable population composition

`buildPreRegisteredEvaluationFromDurablePopulation()` consumes the structural Desk projection without importing Desk or creating a second truth store.

The paired denominator now comes from the complete durable eligibility stream, while the numerator comes only from Missions that genuinely contain the target Challenger shadow evidence.

A scan with no Decision/Comparison therefore lowers pairing coverage instead of disappearing.

### Fail-closed protections

Added checks for:

- duplicate paired eligibility identities;
- eligibility known before its market valid-time;
- evaluated Mission missing from the durable eligibility stream;
- `scanConfigVersion` drift between eligibility and the evaluated Mission;
- `observedAt` drift between eligibility and the evaluated Mission;
- multiple scan-configuration cohorts inside one paired analysis window;
- late pre-registration after any forward durable scan, including a scan with no comparison snapshot;
- missing Challenger shadow scans remaining in the denominator.

The fixed analysis cutoff, future-outcome cutoff, Challenger creation boundary, pairing-coverage gate, insufficient-data states, and no-automatic-promotion rule remain intact.

## Red-team cases

Tests now explicitly cover:

1. Four complete paired Missions plus a fifth durable scan with no comparison: denominator = 5, observed paired population = 4, pairing coverage = 0.8, status = insufficient-data when full coverage is required.
2. A no-comparison scan after Challenger creation but before plan registration: late pre-registration is rejected.
3. Rewritten observation time for an existing Mission: rejected.
4. Mixed scan configuration among eligible scans: rejected.
5. Existing duplicate-ledger, tampered-chain, future-observation, cutoff, Challenger-identity, and insufficient-data protections remain active.

## Verification ladder

1. Baseline branch and CI inspected before changes: prior head `a27ebaacd485153c19fd7acc53ba56105f2e0acc` was green.
2. Protected Claude branch re-read and remained at `fdfc9daff888229ccefe01977f91988a0caa9d5d`.
3. First implementation CI failure was formatter-only; exact Biome diff was applied without weakening logic or tests.
4. Self-audit found an additional late-registration hole for unpaired scans; code and regression test were added.
5. GitHub Actions `verify` run 741 on implementation head `3ef65ead4aa7251bd31196847ba33d8155299d9e` completed successfully, including lint, typecheck, and full tests.
6. A final CI run must also pass on the documentation head before this milestone is reported as a fully green final branch state.

## Safety / authority boundary

This milestone changes evaluation evidence only. It does not add or modify broker commands, `OrderSend`, risk authority, execution authority, automatic Champion promotion, LLM actionable scoring, or real-money enablement.

## Remaining ADR-0021 work

Evaluation is not yet declared complete. The next statistical red-team target is dependence between closely spaced scans and longitudinal cohort maturity. Repeated scans in the same market episode cannot automatically be treated as fully independent observations. That must be addressed before ADR-0020 Memory is allowed to derive validated knowledge from evaluation results.
