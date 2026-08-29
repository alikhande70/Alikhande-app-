# Build Report — Durable Research Orchestration

Date: 2026-08-29
Branch: `gpt/trading-brain-build`
Architecture: ADR-0021 evaluation boundary

## Goal

Close the remaining composition gap between Desk's immutable hypothesis-family registration and Brain's deterministic registered-hypothesis/FDR evaluator without weakening package boundaries or introducing a reverse Desk -> Brain dependency.

## Implementation

Added `services/desk/src/research/evaluation-orchestration.ts`.

The production boundary accepts only:

- the verified Desk `Ledger`,
- a `familyId`,
- test results,
- an injected deterministic evaluator.

Desk itself resolves family definition, `familyHash`, transaction-time `knownAt`, `ledgerSeq`, and `ledgerHash` from the hash-chained ledger before invoking the evaluator. Callers cannot supply those provenance fields from memory.

The evaluator is injected using a structural generic contract. This is deliberate dependency inversion: Desk owns durable truth; Brain owns deterministic statistics. Desk does not depend on `@keel/brain`, so no new workspace dependency or lockfile change is required.

## End-to-end proof

Added `packages/brain/src/desk-ledger-research-orchestration.test.ts` covering the real chain:

`Desk hash-chained ledger -> durable family boundary -> orchestration boundary -> public Brain evaluation facade -> provenance-retaining FDR result`.

Cases covered:

1. Successful durable registration produces a complete deterministic evaluation with the exact ledger sequence/hash and registration timestamps retained in the result.
2. Missing durable family fails before evaluator invocation.
3. Evidence known before durable registration preserves Brain's anti-backdating fail-closed behavior.
4. Result remains `promotionAction: 'none'`.

## Self-audit finding and repair

The first end-to-end test was placed under `services/desk` and directly imported Brain source. Existing ADR-0021 architecture protection correctly rejected that path because production workspace code may not deep-import Brain internals.

That test was removed. The cross-package proof was moved into Brain's test suite, while production Desk code remains independent of Brain. The proof now uses `public-evaluation-composition.ts`, not the internal registered-hypothesis evaluator.

This failure was treated as an architecture regression caught by CI; no guard was relaxed.

## Verification ladder

- Repository head and existing CI inspected before changes.
- Protected Claude branch verified unchanged at `fdfc9daff888229ccefe01977f91988a0caa9d5d`.
- Frozen dependency install: PASS; no lockfile modification required.
- Architecture guard: PASS after relocating the cross-package proof.
- Lint/typecheck/full test Verify step: PASS on implementation head `344b65e40c747b62cab4b6da78824f599d0f232f`.
- No MT5 command path, live-trading authority, LLM score production, or automatic promotion was added.

## Remaining ADR-0021 work

This closes the composition/provenance wiring gap without coupling Desk to Brain. ADR-0021 should still receive an independent repository-wide final red-team audit before being declared complete. That audit must confirm no alternate production route can manufacture evaluation provenance, bypass research-safe projection/holdout controls, or promote a challenger automatically.

Memory/ADR-0020 remains intentionally blocked until that final evaluation audit passes.
