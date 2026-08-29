# Build Report — Registered Hypotheses + FDR Guard

Date: 2026-08-29
Branch: `gpt/trading-brain-build`
Architecture: ADR-0021

## Objective

Implement the deterministic multiple-testing boundary required by ADR-0021. Research questions are treated as one pre-registered family before evidence is evaluated, and statistical discoveries are corrected over that complete family.

## Baseline

- Starting head: `46397149eb382cc467e3b5efce97c74199199ad5`
- Starting GitHub Actions `verify`: run 899, success.
- `claude/personal-trading-app-atm6e1` remained at `fdfc9daff888229ccefe01977f91988a0caa9d5d` and was not modified.

## Statistical basis

ADR-0021 specifies Benjamini-Hochberg false-discovery-rate control. The implementation follows the original Benjamini-Hochberg step-up procedure.

Reference: Yoav Benjamini and Yosef Hochberg, Journal of the Royal Statistical Society: Series B, 1995, DOI 10.1111/j.2517-6161.1995.tb02031.x.

## Implemented

Added `packages/brain/src/registered-hypotheses.ts` with:

- versioned hypothesis families;
- deterministic SHA-256 sealing of the canonical family;
- fixed family identity, registration time, method, q-level, question IDs, test IDs, alternatives and analysis-plan hashes;
- exact-family validation that rejects missing, duplicate or unregistered results;
- bitemporal validation that rejects registration after eligible evidence was already known;
- test and analysis-plan drift detection;
- Benjamini-Hochberg step-up rejection over the complete family;
- monotone BH-adjusted p-values;
- explicit `insufficient-data` for unresolved families instead of silently shrinking the family;
- `promotionAction: 'none'` so this statistical layer has no state-change authority.

The module remains internal to the Brain package in this milestone; it does not create a new public evaluation bypass.

## Red-team tests

Added `packages/brain/src/registered-hypotheses.test.ts` covering:

- one valid BH discovery;
- largest-passing-rank semantics;
- omission of a registered question;
- unresolved/insufficient-data family state;
- late registration;
- analysis-plan drift;
- mutation of a sealed family;
- duplicate results;
- impossible temporal ordering;
- preservation of `promotionAction: 'none'`.

## Defects found and corrected

The first CI attempt stopped in Biome because of formatting/import ordering and forbidden non-null assertions in the tests. The files were brought into existing repository policy without disabling any rule.

The next CI run found an incorrect statistical fixture: `[0.001, 0.02, 0.03, 0.2]` at `q=0.05` with four hypotheses correctly yields three BH discoveries because the third ordered p-value satisfies `0.03 <= (3/4)*0.05`. The production algorithm was correct; the fixture was changed to `[0.001, 0.03, 0.04, 0.2]` for the intended one-discovery case. A separate test retains the three-discovery step-up case.

## Verification ladder

- Deterministic implementation: PASS
- No LLM computation inside the evaluator: PASS
- No automatic promotion authority: PASS
- Biome: PASS
- TypeScript typecheck: PASS
- Full recursive test gate: PASS
- Implementation head: `cd6cbc71f16ad411e34e02aa64db61bc8a6be53f`
- GitHub Actions `verify` run 908: SUCCESS on that implementation SHA.

## Remaining boundary

ADR-0021 is not yet complete. The family seal and FDR engine are deterministic, but the pre-registration itself is not yet persisted end-to-end as an immutable Desk ledger fact. The next step is:

`durable family registration -> ledger replay/read model -> exactly-once/conflict checks -> Brain family derived from ledger -> FDR evaluation bound to durable registration`

That step should include restart/replay, duplicate registration, conflicting family hash, late-registration and ledger-tamper tests. Memory work remains sequenced after the final evaluation audit.
