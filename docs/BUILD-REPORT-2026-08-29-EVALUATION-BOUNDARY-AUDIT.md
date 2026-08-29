# Build Report — ADR-0021 Evaluation Boundary Audit

Date: 2026-08-29
Branch: `gpt/trading-brain-build`
Baseline head: `60ab8a245251df1218a3defffc7eeb348d03dbd1`

## Goal

Perform the independent repo-wide bypass audit promised by the preceding Evaluation Composition milestone. The objective was to make the composed ADR-0021 evaluator the only public statistical evaluation path while preserving the deterministic Brain root API and internal unit-testability.

## Finding

The final `evaluation-composition` implementation was structurally guarded, but the package boundary still exposed lower-level evaluators as public package subpaths and also re-exported several evaluation modules from the package root. A future application/service caller could therefore bypass composition-level denominator, cutoff and outcome-policy guards without editing the Brain package itself.

No current external workspace import was found after the boundary was narrowed. A first architecture-test draft incorrectly treated JSDoc references in Desk's `evaluation-population.ts` as imports; CI exposed that false positive. The scanner was corrected to inspect actual module specifiers (`from`, dynamic `import`, `require`, side-effect `import`) rather than arbitrary source text.

## Delivered

1. Narrowed `@keel/brain` package exports to:
   - root deterministic Brain API (`@keel/brain`);
   - the single public statistical path (`@keel/brain/evaluation-composition`).
2. Removed root re-exports of low-level evaluation, paired-evaluation and paired-inference modules.
3. Added `evaluation-boundary.test.ts` to fail if:
   - forbidden low-level statistical subpaths are re-published;
   - low-level evaluators are re-exported through the root;
   - workspace code outside `packages/brain` deep-imports a hidden Brain subpath;
   - workspace code reaches `packages/brain/src` directly.
4. Kept internal low-level modules available to Brain's own tests and composition code, so statistical implementation remains testable without making it a production public API.

## Failure / red-team history

- First CI failure: Biome import ordering and a useless string escape in the new guard test. Only formatting was corrected.
- Second CI failure: the initial source scanner reported two apparent Desk bypasses. Inspection proved both were JSDoc references, not module imports. The guard was repaired to parse module-specifier syntax instead of weakening or deleting the workspace-level check.
- The corrected guard found no external workspace deep imports.

## Verification ladder

1. Baseline branch and latest CI inspected before changes; baseline exact head `60ab8a245251df1218a3defffc7eeb348d03dbd1` was green.
2. Public package exports and root exports were inspected directly.
3. Workspace-level architecture guard added and allowed to fail against real repo content.
4. False-positive failure was investigated by opening the reported Desk file; no Brain import existed there.
5. Corrected implementation/test head: `6a0e90c3449d0f2e58981f77cf7474bf5d843875`.
6. GitHub Actions verify run 830 on that exact head completed successfully: Biome lint, all workspace TypeScript typechecks, and full tests passed.
7. `claude/personal-trading-app-atm6e1` was re-read and remained unchanged at `fdfc9daff888229ccefe01977f91988a0caa9d5d`.
8. This report is documentation-only; its resulting commit must itself pass CI before it is treated as the final milestone head.

## Safety / authority status

- No automatic Brain promotion was introduced.
- No LLM-generated actionable score or broker/account truth was introduced.
- No MT5/broker command or execution authority was added.
- No real-money execution was enabled or claimed.

## ADR-0021 is not complete yet

The boundary bypass is now closed, but a fresh reading of the accepted ADR shows several explicit evaluation controls still without complete executable implementation:

- locked holdout access semantics;
- purge/embargo for overlapping label horizons and serially adjacent research/fitting windows;
- durable registered-hypothesis families and Benjamini-Hochberg FDR multiple-testing control;
- calibration reporting (bucket reliability, Brier/ECE and uncertainty) where a probability-like claim is genuinely defined.

The deterministic Brain score is explicitly not a probability, so calibration code must not silently reinterpret the rubric score as one. The next milestone should therefore implement leakage-controlled research/holdout semantics first, and only add calibration where the semantics support a real probabilistic claim.

ADR-0020 Memory remains intentionally blocked until these ADR-0021 controls are implemented and red-teamed.
