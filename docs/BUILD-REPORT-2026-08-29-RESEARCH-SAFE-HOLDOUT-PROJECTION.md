# Build Report — Research-Safe Holdout Projection

Date: 2026-08-29
Branch: `gpt/trading-brain-build`
Architecture: ADR-0021 / ADR-0022 sequencing preserved

## Starting state

- Branch head before this milestone: `e5662733f58cc59d18d74449bd2a596a0b65598c`.
- GitHub Actions `verify` run 843 on that exact head was green.
- Protected branch `claude/personal-trading-app-atm6e1` remained at `fdfc9daff888229ccefe01977f91988a0caa9d5d` and was not modified.
- The prior milestone had implemented deterministic locked-holdout, purge, embargo, and durable access-receipt primitives, but deliberately had not connected those primitives to the final evaluation composition because naïve composition would expose holdout evidence to ordinary research.

## Implemented

### 1. Research-safe projection before evaluation

Extended `packages/brain/src/evaluation-composition.ts` with a research-safe composition boundary.

`projectResearchSafeEvaluationPopulation(...)` now:

1. validates the **entire durable Mission population first**, before any leakage filtering;
2. binds `LeakageWindowPlan.labelHorizonMs` to the pre-registered fixed-horizon outcome policy so purge semantics cannot drift from the evaluated outcome horizon;
3. partitions durable scans only from immutable Mission identity and bitemporal scan timestamps using the pre-registered leakage window;
4. admits only rows classified as `research` to the ordinary evaluator;
5. removes `purged`, `holdout`, and `embargoed` Mission IDs consistently from `pairedEligibility`, decision-Mission projections, and snapshot-feature projections;
6. returns only aggregate counts for excluded partitions rather than returning their Mission identities or outcomes.

This ordering matters: validating first prevents malformed or missing holdout rows from becoming invisible merely because those rows would later be filtered out.

### 2. Research-safe final evaluator

Added `buildResearchSafeFinalEvaluation(...)`.

The ordinary research evaluator now receives only the projected research population. It has **no holdout access-receipt argument**, so this path cannot open the locked holdout. Holdout consumption remains a separate future one-shot promotion-evaluation concern.

No outcome, P&L, Brain score, LLM output, or Challenger result is consulted when deciding whether a Mission is research/purged/holdout/embargoed.

### 3. Public API narrowed to prevent bypass

Self-audit found that merely adding a safe wrapper was insufficient while the package subpath still mapped directly to the internal composition module, because an external caller could import `buildFinalPreRegisteredEvaluation(...)` and bypass the leakage projection.

To close that route:

- added `packages/brain/src/public-evaluation-composition.ts`;
- changed `packages/brain/package.json` so `@keel/brain/evaluation-composition` resolves to the public wrapper;
- the public wrapper exports the research-safe evaluator/projection and required types only;
- it deliberately does **not** export `buildFinalPreRegisteredEvaluation(...)` or `validateFinalEvaluationComposition(...)`;
- the lower-level composition remains internal for package tests/composition only.

### 4. Architecture regression guard strengthened

Updated `packages/brain/src/evaluation-boundary.test.ts` to assert that:

- only `.` and `./evaluation-composition` remain public Brain entrypoints;
- `./evaluation-composition` points to `public-evaluation-composition.*`, not the internal implementation;
- the wrapper exposes `buildResearchSafeFinalEvaluation`;
- the wrapper does not expose the unsafe internal final evaluator or raw composition validator;
- production workspace code still cannot deep-import Brain evaluator internals.

## Red-team tests

Added `packages/brain/src/research-safe-evaluation.test.ts` covering:

- research rows before/after the protected interval remain available;
- pre-holdout rows whose label horizon overlaps the holdout are purged;
- locked-holdout rows never reach ordinary evaluator projections;
- post-holdout embargo rows never reach ordinary evaluator projections;
- excluded Mission identities are absent from all projected populations;
- leakage-window label-horizon drift from the fixed outcome policy is rejected;
- the complete durable population is validated before filtering, so a malformed holdout row cannot hide behind exclusion.

Existing locked-holdout tests continue to cover duplicate Mission identity, bitemporal corruption, late sealing, premature opening, one valid receipt, and repeated peeking.

## Verification ladder

1. Baseline CI inspected before changes: PASS (`verify` run 843 on `e5662733f58cc59d18d74449bd2a596a0b65598c`).
2. First composed/public-boundary CI reached repository verification and failed only at Biome import/format checks; typecheck/tests had not started.
3. The exact formatter/import-order diffs reported by CI were applied without deleting or weakening tests or invariants.
4. Final implementation/test head before this report: `10fe8d59ce41bb1923bba8997a80d0b889e64a84`.
5. GitHub Actions `verify` run 861 on that exact head: PASS.
6. Run 861 completed the repository's full `pnpm verify` chain: Biome lint, TypeScript typecheck, and full recursive test suite.

## Self-audit

The ordinary research path is now protected, but **ADR-0021 is still open**.

The next required boundary is a distinct one-shot locked-holdout evaluation path that:

- derives the exact holdout population from the same hash-verified durable Mission population;
- computes a deterministic content hash of the sealed holdout projection;
- binds that hash to `LockedHoldoutAccessReceipt.populationHash`;
- rejects missing, mismatched, duplicate, premature, or repeated receipts;
- evaluates only the registered `(holdoutId, questionId)` and fixed outcome semantics;
- remains observational: even a favourable holdout result must not automatically promote a Challenger or mutate Brain state.

After that, ADR-0021 still requires registered hypothesis accounting and multiple-testing/FDR control. Probability calibration should only be added where the system truly emits a probability; the current rubric score must not be relabelled as one.

ADR-0020 Memory remains blocked until Evaluation is genuinely closed and independently red-teamed.

## Safety / execution scope

No broker command, MT5 authority, account-truth mutation, automatic promotion, LLM-generated actionable score, or real-money execution path was added or changed.
