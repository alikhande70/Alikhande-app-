# Build Report — Ledger-Registered Research Evaluation Boundary

Date: 2026-08-29
Branch: `gpt/trading-brain-build`
Architecture: ADR-0018 through ADR-0022, with ADR-0021 governing this milestone.

## Objective

Close the provenance gap between durable hypothesis pre-registration and deterministic multiple-testing evaluation without weakening the existing evaluation boundary, exposing low-level statistical APIs, granting promotion authority, or changing broker/execution behavior.

The intended evidence path is:

`Desk hash-chained ledger -> ledger-derived registration provenance -> deterministic Brain FDR evaluation`

This milestone establishes and verifies the provenance-aware Brain facade and the Desk-side durable provenance projection. The final production dependency wiring between Desk and Brain is deliberately not claimed complete yet; see **Remaining gap**.

## Pre-run verification

Before implementation, the latest `gpt/trading-brain-build` head and GitHub Actions state were inspected. The prior accepted head was green. The protected reference branch `claude/personal-trading-app-atm6e1` was also inspected and was not modified.

## Implementation

### 1. Ledger-provenanced public statistical facade

Added `packages/brain/src/ledger-registered-research-evaluation.ts`.

The facade accepts only a registration package that carries:

- source marker `desk-hash-chained-ledger:v1`;
- committed positive `ledgerSeq`;
- canonical lowercase SHA-256 `ledgerHash`;
- the sealed registered hypothesis family;
- the bitemporal registration receipt (`familyHash`, `knownAt`).

Before invoking the internal registered-hypothesis evaluator, the facade fails closed on malformed or non-ledger provenance.

The facade exposes no registration factory and no promotion mechanism. The underlying deterministic evaluator still returns `promotionAction: 'none'`.

### 2. Desk provenance forwarding

Updated `services/desk/src/research/registered-family-boundary.ts` so that an authoritative read of a registered hypothesis family now forwards the durable row identity together with the existing family and receipt:

- `source`;
- `ledgerSeq`;
- `ledgerHash`;
- `family`;
- `receipt`.

The caller still supplies only `familyId`; the registration definition, transaction-time `knownAt`, ledger sequence, and ledger hash are recovered from the hash-chained Desk ledger rather than accepted from caller memory.

### 3. Public-boundary hardening

Updated the public evaluation composition to expose the provenance-aware facade while continuing to hide the low-level registered-hypothesis evaluator.

Expanded `evaluation-boundary.test.ts` so CI now asserts that:

- only the existing public statistical subpath remains exported;
- `evaluateLedgerRegisteredResearchFamily` is available through that controlled subpath;
- the low-level `evaluateRegisteredHypothesisFamily` and receipt type are not re-exported there;
- the facade carries ledger provenance fields;
- it contains no registration writer/factory;
- it contains no promotion action implementation;
- production workspace code still cannot deep-import Brain internals.

## Red-team / failure cases

Added tests for:

1. valid ledger-provenanced family reaches deterministic FDR evaluation;
2. non-ledger/forged source is rejected before statistics run;
3. non-positive ledger sequence is rejected;
4. malformed ledger hash is rejected;
5. family tampering is still detected by the pre-existing canonical family hash check;
6. Desk boundary forwards the exact committed ledger sequence and hash;
7. unknown family still fails closed;
8. duplicate durable registration facts remain invalid;
9. impossible bitemporal ordering remains invalid.

## Self-audit finding and reverted experiment

An initial attempt added a direct `services/desk -> @keel/brain/evaluation-composition` production dependency and an orchestration function.

That change would require a legitimate workspace dependency/lockfile update. The repository uses `pnpm install --frozen-lockfile` in CI, and the available edit path in this run could not safely regenerate and verify the complete lockfile rather than hand-editing it.

The attempted dependency, TypeScript project reference, and orchestration file were therefore fully reverted. CI was not weakened, `--frozen-lockfile` was not removed, and the lockfile was not hand-patched.

This was intentional fail-closed behavior: a partially wired production dependency is worse than an explicit remaining boundary task.

## CI repair

The first implementation CI exposed a Biome export-ordering violation in `public-evaluation-composition.ts`. The exact GitHub Actions log was inspected and the export order was corrected according to Biome's safe fix. No invariant, linter rule, or test was removed or weakened.

## Verification ladder

### Level 1 — Static architecture

- Public package surface remains restricted.
- Low-level registered-hypothesis evaluator remains internal.
- No automatic promotion capability was introduced.

### Level 2 — Durable provenance

- Desk derives family definition and receipt from the authoritative hash-chained ledger.
- Desk now forwards committed `ledgerSeq` and `ledgerHash` with that registration.
- Duplicate and impossible-timeline states fail closed.

### Level 3 — Statistical semantics

- Existing canonical family-hash validation remains active.
- Existing anti-backdating rule (`knownAt` before first evidence) remains active.
- Existing insufficient-data behavior remains active.
- Existing deterministic Benjamini-Hochberg FDR behavior remains active.
- Evaluation remains observational with no automatic promotion.

### Level 4 — Full repository CI

Implementation head verified by GitHub Actions `verify` run #998:

- frozen lockfile install: PASS;
- Biome: PASS, 264 files checked;
- TypeScript workspace typecheck: PASS;
- Brain: 169 tests PASS;
- Contracts: 19 tests PASS;
- Core: 218 tests PASS;
- Mobile: 132 tests PASS;
- Desk: 532 tests PASS;
- Total: 1,070 tests PASS.

Implementation head: `0e704209b491e9d91079a5a63922d08a8957f679`.

## Safety / execution scope

This milestone changes research/evaluation provenance only.

It adds no MT5 command, no broker permission, no live-money execution path, no LLM-generated actionable score, and no automatic champion promotion.

## Remaining gap

ADR-0021 is **not closed** by this milestone.

The final production path still needs a legitimate, repository-consistent orchestration layer that performs:

`verified Desk ledger read -> ledger-derived provenance package -> Brain ledger-registered FDR facade`

without allowing callers to manufacture provenance.

That work must include a proper workspace dependency and regenerated `pnpm-lock.yaml`, then pass `pnpm install --frozen-lockfile`, architecture tests, restart/replay tests, and full CI.

Only after that wiring and a repository-wide bypass audit pass should ADR-0021 be considered for final closure. ADR-0020 Memory remains sequenced after that closure.
