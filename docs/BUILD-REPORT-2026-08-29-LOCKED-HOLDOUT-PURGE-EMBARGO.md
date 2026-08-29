# Build Report — Locked Holdout + Purge/Embargo Guard

Date: 2026-08-29
Branch: `gpt/trading-brain-build`
Architecture: ADR-0021 / ADR-0022 sequencing preserved

## Starting state

- Branch head before this milestone: `5e7c8f9b7d87221f5aafd4a6787e644f972f7a46`.
- GitHub Actions `verify` run 832 on that exact head was green.
- Protected branch `claude/personal-trading-app-atm6e1` remained at `fdfc9daff888229ccefe01977f91988a0caa9d5d` and was not modified.

## Implemented

Added `packages/brain/src/leakage-window-guard.ts` as a deterministic ADR-0021 leakage-control primitive.

The guard now provides:

1. A versioned, pre-registered `LeakageWindowPlan` with immutable holdout identity, research question identity, seal time, holdout bounds, embargo width, and label horizon.
2. Deterministic scan partitioning into `research`, `purged`, `holdout`, or `embargoed` without consulting outcomes, Brain scores, P&L, or LLM output.
3. Purging of pre-holdout scans whose forward label horizon overlaps the holdout boundary, including exact-boundary overlap.
4. Embargo of scans immediately after the holdout interval.
5. Fail-closed validation for duplicate mission identity, impossible bitemporal order, invalid timestamps, unsafe timestamp arithmetic, and a holdout sealed after its first observation.
6. A durable `LockedHoldoutAccessReceipt` contract. For one `(holdoutId, questionId)`, zero receipts means sealed, one receipt means consumed once, and a second receipt invalidates the holdout for that question.
7. Holdout-open validation that rejects opening before the sealed window completes, rejects an evaluation cutoff before holdout completion, and rejects an access timestamp preceding its own evaluation cutoff.

## Red-team tests

Added `packages/brain/src/leakage-window-guard.test.ts` covering:

- ordinary research observations;
- overlapping-label purge;
- exact-boundary purge;
- sealed holdout observations;
- post-holdout embargo;
- observations after embargo returning to research eligibility;
- duplicate Mission inflation;
- `knownAt < observedAt` corruption;
- late sealing;
- unopened holdout state;
- exactly one valid durable access receipt;
- repeated peeking at the same registered question;
- premature holdout opening.

## Verification ladder

1. Baseline CI inspected before changes: PASS.
2. Initial implementation/test head reached CI and failed in the repository `verify` gate before semantic verification completed; formatting was corrected without weakening tests or invariants.
3. Final implementation/test head before this report: `e1e2690ae91f9675a3578241847a6d3b9502824f`.
4. GitHub Actions `verify` run 840 on that exact head: PASS.
5. Run 840 completed the repository's full `pnpm verify` chain: Biome lint, TypeScript typecheck, and full recursive test suite.

## Self-audit

The new guard is deliberately **not yet wired directly into `evaluation-composition`**.

Reason: the current final evaluator is an observational Champion/Challenger evaluation boundary, while ADR-0021 says the locked holdout must be invisible to ordinary research and opened only for a promotion decision, once. Naively adding the holdout population to the existing composition would create the exact leakage path this guard is intended to prevent.

The next correct step is therefore a research-safe projection boundary that:

- starts from the same hash-verified durable Mission population;
- applies this leakage partition before any evaluator receives rows;
- excludes `purged`, `holdout`, and `embargoed` rows from ordinary research/evaluation inputs;
- exposes the sealed holdout only through a distinct one-shot promotion-evaluation path backed by durable access receipts;
- binds the receipt's population hash to the exact immutable holdout projection;
- prevents the old general evaluator from being used as a holdout bypass.

ADR-0021 remains open after this milestone. Registered hypotheses/FDR and probability calibration are also still pending. ADR-0020 Memory must remain blocked until the Evaluation architecture is closed and red-teamed.

## Safety / execution scope

No broker command, MT5 authority, account truth mutation, automatic promotion, LLM-generated actionable score, or real-money execution path was added or changed.
