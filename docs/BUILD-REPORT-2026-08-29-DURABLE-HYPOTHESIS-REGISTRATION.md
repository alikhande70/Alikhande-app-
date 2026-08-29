# Build Report — Durable Hypothesis Registration

Date: 2026-08-29  
Branch: `gpt/trading-brain-build`  
Architecture: ADR-0021 evaluation integrity

## Objective

Close the next anti-hindsight gap in registered-hypothesis evaluation: a hypothesis family must become immutable Desk truth before its evidence is inspected, and evaluation must be able to derive the Brain receipt's `knownAt` from the actual durable ledger transaction time rather than a caller-authored timestamp.

This milestone deliberately does **not** start ADR-0020 Memory. Evaluation integrity remains the sequencing gate.

## Implementation

### Durable Desk fact

Added `evaluation.hypothesisFamilyRegistered` to the append-only hash-chained Desk ledger. The durable payload stores the complete pre-registered family, not only its digest:

- family/version identity;
- declared `registeredAt` domain time;
- Benjamini-Hochberg method and q-level;
- every registered question;
- test id;
- analysis-plan hash;
- alternative direction;
- deterministic `familyHash`.

The event is in `DURABLE_KINDS`, so it has the same synchronous durability contract as the other evaluation-integrity facts.

### Brain-compatible deterministic sealing

`services/desk/src/ledger/hypothesis-registration.ts` independently reproduces the canonical family representation used by the Brain and computes the SHA-256 seal. Hypothesis order is canonicalised by `questionId` before hashing.

Desk therefore rejects a payload whose supplied `familyHash` no longer matches its family. A caller cannot change q-level, a question, test id, analysis plan or alternative and retain an old valid seal.

### Bitemporal registration receipt

The durable registration exposes two distinct times:

- `registeredAt`: domain time declared by the research plan;
- `knownAt`: actual ledger transaction time (`LedgerRow.ts`) when the registration became durable knowledge.

`knownAt < registeredAt` is impossible and fails closed.

`toHypothesisEvaluationRegistrationInputs()` produces the exact structural inputs expected by the deterministic Brain: the immutable family plus `{ familyHash, knownAt }`. Ledger sequence/hash remain Desk provenance rather than Brain scoring inputs.

### Exactly-once and restart behaviour

The canonical writer reads the authoritative hash-chained family stream directly before appending:

- first valid registration -> append once;
- identical retry -> idempotent, no second event;
- changed retry for the same `familyId` -> hard conflict;
- more than one raw registration fact -> invalid state / fail closed;
- restart -> prior registration remains authoritative and the same retry stays idempotent.

The read path intentionally does not depend on an eventually caught-up mutable projection, so projector lag cannot permit an accidental rewrite.

### Projector/replay compatibility

The projector explicitly recognises the new event as a forensic immutable fact with no mutable projection. It still advances the watermark and survives full replay/rebuild verification.

## Red-team / chaos coverage

Added `services/desk/src/ledger/hypothesis-registration.test.ts` with eight cases:

1. Brain-compatible canonical SHA-256 seal and ledger-derived evaluation inputs;
2. hypothesis-order canonicalisation and collision-safe stream identity;
3. payload tampering while reusing an old hash;
4. conflicting retry for one family identity;
5. malformed hash, duplicate question ids and impossible bitemporal ordering;
6. real SQLite close/reopen restart with idempotent retry and drift rejection;
7. projector catch-up plus rebuild verification while authoritative reads remain ledger-derived;
8. raw-ledger duplicate facts inserted by bypassing the canonical writer, detected fail-closed while the ledger hash chain itself remains valid.

## Verification ladder

### Baseline before changes

Branch head `b550d2c7093023c5f3f136b2844c232e6b4534c1` had a successful GitHub Actions `verify` run (#921).

### First implementation CI

Run #928 on `350fbf68d8802b274897c915b9b95200e29654d0` failed during Biome lint, before typecheck/tests:

- two test-fixture non-null assertions violated repository lint policy;
- the new implementation needed Biome formatting.

The assertions were replaced by an explicit fixture guard and the formatter diff was applied. No test, invariant or production check was disabled or weakened.

### Verified implementation head

Implementation head `eff31f7b19ba6c371f78f7fe476d1f660fc448c8` passed the full `pnpm verify` chain in push run #932:

- Biome lint: PASS (`260` files checked);
- TypeScript typecheck: PASS for Brain, Contracts, Core, Mobile and Desk;
- Contracts: `19` tests PASS;
- Core: `218` tests PASS;
- Brain: `164` tests PASS;
- Mobile: `132` tests PASS;
- Desk: `528` tests PASS;
- total: **1,061 tests PASS**;
- new durable hypothesis-registration suite: **8/8 PASS**.

Desk CI remains the repository's normal simulation/non-live suite and excludes `**/*.live.test.ts`; no live broker validation is claimed by this milestone.

## Self-audit

### Closed in this milestone

The Brain anti-backdating receipt no longer needs to be an in-memory assertion. Desk now has an immutable, replayable source from which the receipt's `knownAt` can be derived after restart, and the full research family can be reconstructed and hash-verified from durable history.

### Remaining ADR-0021 boundary gap

This milestone does **not** yet prove that every production evaluation call-site is forced to obtain its registered-hypothesis family/receipt through the Desk ledger-derived adapter. Structurally compatible `{ familyHash, knownAt }` values can still be constructed by TypeScript callers unless the production orchestration boundary is audited and constrained.

The next step is therefore a repository-wide call-site/boundary audit and an enforced production composition path:

`verified Desk hypothesis registration -> ledger-derived family/receipt -> registered-hypothesis/FDR evaluation`

A production bypass must become a CI architecture failure. Only after that should ADR-0021 receive its final independent red-team audit and closure decision; ADR-0020 Memory remains sequenced after it.

## Safety / authority

This milestone adds no broker command, MT5 authority, risk override, automatic champion promotion, LLM-generated actionable score, or real-money execution path. It is evaluation-integrity infrastructure only.
