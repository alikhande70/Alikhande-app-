# Build Report — ADR-0021 Final Evaluation Composition Boundary

Date: 2026-08-29
Branch: `gpt/trading-brain-build`
Baseline head: `4325ecf5eb278b095cb1ff3523886876c04d92d2`

## Goal

Close a composition-level gap in ADR-0021: the individual evaluation layers already enforced forward-only Champion/Challenger evidence, fixed looks, dependence/episode guards, longitudinal maturity, and snapshot-derived feature strata, but callers could still assemble those layers from structurally different populations or use different historical cutoffs. The fixed-horizon outcome policy was also supplied separately and was not pinned into the final pre-registered analysis plan.

## Delivered

Added `@keel/brain/evaluation-composition` as the final observational ADR-0021 boundary.

The boundary now requires one durable evaluation population and verifies before statistical evaluation that:

- paired eligibility Mission IDs are unique;
- snapshot-feature Mission IDs exactly match the durable scan denominator;
- decision Mission IDs are a subset of the durable scan population;
- decision and feature projections preserve the exact durable `observedAt` identity;
- evidence not yet known at `currentKnowledgeCutoff` cannot enter evaluation;
- evaluation cannot run before analysis-plan registration;
- aggregate and paired evaluation use the same historical cutoff;
- composition semantics are explicitly versioned;
- the fixed-horizon outcome `labelVersion`, `horizonMs`, and `flatThresholdR` are pre-registered and cannot be changed after seeing forward evidence.

The output includes a structural `compositionAudit` containing the ledger head, population counts, observed/known time span, analysis cutoff, and the registered outcome policy. It is audit evidence only. It does not mutate the Brain registry, promote a Challenger, emit broker/account truth, or authorize execution.

## Failure/chaos coverage

Added red-team tests for:

- a feature projection silently dropping a durable scan;
- a feature projection injecting a scan outside the durable denominator;
- decision Mission observation-time drift;
- snapshot-feature observation-time drift;
- future durable evidence relative to the declared knowledge boundary;
- evaluation before analysis-plan registration;
- aggregate/paired cutoff drift;
- fixed-horizon outcome-policy drift after plan registration;
- duplicate durable Mission identity;
- unknown composition semantics version.

A test-fixture defect was found by CI: the first future-knowledge test placed `currentKnowledgeCutoff` before `registeredAt`, so the earlier and correct pre-registration guard fired first. The fixture was corrected to isolate the intended future-evidence failure mode without weakening production checks.

## CI repair history

Initial commits failed only Biome formatting. Exact formatter diffs from GitHub Actions were applied. No invariant or assertion was removed or relaxed.

After formatting, CI reached the full suite and exposed the test-fixture ordering defect described above. That fixture was repaired. A self-audit then found the unpinned fixed-horizon outcome policy; the final analysis-plan contract was strengthened to pre-register that policy and a dedicated drift test was added.

## Verification ladder

1. Repository/branch inspected before changes.
2. Baseline branch head `4325ecf5eb278b095cb1ff3523886876c04d92d2` had GitHub Actions verify success from the preceding milestone.
3. Final implementation/test head before this report: `e886b50fe39eaaf47f001b9165f85f529f691b4e`.
4. GitHub Actions push verify run 816 on that exact implementation/test head completed successfully, including Biome lint, TypeScript typecheck for all workspace projects, and the full test suite.
5. `claude/personal-trading-app-atm6e1` was re-read and remained unchanged at `fdfc9daff888229ccefe01977f91988a0caa9d5d`.
6. This report is documentation-only; its resulting head must also pass CI before being treated as the final verified milestone head.

## Safety / authority status

- No automatic Brain promotion was introduced.
- No LLM-generated actionable score was introduced.
- No broker command or new MT5 execution authority was introduced.
- No real-money execution was enabled or claimed.
- Verification remains code/CI plus deterministic simulation-oriented evidence; real external MT5 behavior still requires explicit external validation and authorization where applicable.

## Remaining work

ADR-0021 is substantially more closed, but this report does not declare the overall application complete and does not start ADR-0020 Memory. The next run should perform an independent composition/red-team pass over the complete Evaluation path and check for any remaining bypass around the final boundary, especially call sites that still use lower-level evaluators directly when the hash-verified Desk population is available. Only after Evaluation has a single enforced production entry path should validated-knowledge Memory be built from immutable bitemporal observations.
