# Build Report — One-Shot Locked Holdout Evaluation

Date: 2026-08-29
Branch: `gpt/trading-brain-build`
Architecture: ADR-0018 through ADR-0022, especially ADR-0021/ADR-0022

## Scope

This milestone implements the guarded one-shot evaluation boundary for a locked holdout population. It does not add execution authority, broker commands, LLM scoring, model self-promotion, or real-money behavior.

The locked holdout remains an evaluation-only mechanism. A challenger can be observed on the sealed holdout, but no result from this boundary can mutate champion/challenger registry state.

## Implemented

### Exact holdout population seal

`packages/brain/src/locked-holdout-evaluation.ts` adds a deterministic SHA-256 seal for the exact holdout cohort.

The seal is built from the pre-registered holdout/question identity and canonical sorted holdout rows containing only durable scan identity/timing fields. It intentionally does not reveal holdout Mission IDs or outcomes through the seal API.

The hash deliberately excludes the moving ledger head. A later append-only research record outside the holdout therefore cannot invalidate a receipt for an unchanged holdout cohort. The current ledger head is still returned as audit provenance, but it is not part of cohort identity.

### One-shot access receipt enforcement

`buildLockedHoldoutEvaluation()` requires exactly one pre-existing access receipt for the registered `(holdoutId, questionId)`.

The receipt must match:

- the sealed `populationHash`;
- the pre-registered `analysisCutoff`;
- the holdout/question identity;
- the current historical knowledge boundary.

A second matching receipt invalidates the question instead of being treated as confirming evidence. A missing receipt, future receipt, population mismatch, premature access, or cutoff drift fails closed.

The evaluator itself does not fabricate or mutate receipts. Receipt persistence is deliberately a caller/Desk concern so the Brain boundary cannot authorize its own access.

### Observational-only result

The public result carries `promotionAction: 'none'`. The module has no registry dependency and performs no champion mutation. This preserves ADR-0022's no-automatic-self-promotion rule.

### Public boundary

The guarded functions are exposed only through `@keel/brain/evaluation-composition`:

- `sealLockedHoldoutPopulation`
- `buildLockedHoldoutEvaluation`

The raw lower-level final evaluator remains internal.

## Red-team coverage

Tests cover:

- deterministic seal independent of input ordering;
- no Mission identity list exposed by the seal;
- stable holdout hash when the append-only ledger grows outside the holdout;
- refusal to seal before the holdout window completes;
- missing access receipt;
- wrong population hash;
- repeated peeking / second receipt;
- receipt from the future relative to current knowledge;
- receipt cutoff drift from the pre-registered plan.

## Self-audit findings

### Finding 1 — moving ledger head in population hash

The first implementation included the full moving ledger head in the population hash. That would have invalidated an otherwise correct receipt whenever unrelated research was appended after the holdout.

Fix: remove the moving ledger head from cohort identity and keep it only as audit provenance. A regression test now locks this behavior.

### Finding 2 — attempted Desk receipt event widened the invariant surface

A follow-up attempt added an `evaluation.holdoutOpened` event to the Desk ledger. CI correctly exposed that adding a new exhaustive `LedgerEvent` variant also requires a coherent projector change. Rather than weaken the projector exhaustiveness check or land a partial persistence path, that experimental Desk change was reverted in full.

Result: this milestone leaves the Brain one-shot boundary coherent and green. Durable Desk persistence/projection of the access receipt remains an explicit next step and must be implemented end-to-end rather than as a partial event-only change.

### Finding 3 — test-file replacement risk

During the experimental Desk change, a partial view of `ledger.test.ts` was initially used for an edit. The omission was detected before acceptance. The complete original file was restored and the entire experimental Desk change was subsequently reverted. No existing test coverage is intentionally removed in the accepted tree.

## Verification ladder

1. Pre-run branch/CI inspection: existing branch head was green before new work.
2. Locked-holdout implementation added with deterministic seal, one-shot receipt checks, public boundary, and red-team tests.
3. Early CI failures were formatting/import-order only and were repaired without weakening invariants.
4. Implementation SHA `971c8a08c00d7cc05683905305d708cb70299818` reached successful lint/typecheck/full-test execution.
5. Self-audit fixed moving-ledger-head instability and added the regression test at SHA `0ed1fc697b3bfea761d1d104561d3e8a755670c3`; GitHub Actions verify run 879 succeeded.
6. Experimental Desk receipt persistence exposed an exhaustive-projector dependency and was reverted through commit `0c218d3dee339daf969bf77a33a5987955a2c22b`, restoring the accepted code tree to the already-green post-self-audit state.
7. Final documentation commit must pass the same repository-wide `verify` gate before this milestone is considered closed.

## Safety / execution posture

- No MT5 order path changed.
- No new broker command exists.
- No live-account authorization was added.
- No LLM-generated actionable score or broker/account truth was introduced.
- No automatic champion promotion exists.
- Demo/simulation-first verification posture remains unchanged.

## Exit state and next work

The one-shot locked-holdout Brain boundary is implemented and red-teamed, but ADR-0021 is not yet complete.

Next sequencing:

1. Add a coherent durable Desk receipt path: immutable `holdout opened` fact + projector/read model + exactly-once write contract + restart/replay/duplicate tests, then feed those ledger-derived receipts into the Brain boundary.
2. Implement registered hypotheses and multiple-testing control (including the accepted FDR policy) without using Brain rubric scores as probabilities.
3. Complete the final ADR-0021 independent leakage/statistics audit.
4. Only after Evaluation is genuinely closed, begin ADR-0020 validated-memory derivation.

Memory remains intentionally deferred.
