# Build Report — Durable Locked-Holdout Access Receipts

Date: 2026-08-29
Branch: `gpt/trading-brain-build`
Architecture: ADR-0018 through ADR-0022 + `docs/BRAIN-DESIGN-REVIEW.md`

## Scope

This milestone closes the durability gap between the Brain's one-shot locked-holdout evaluator and the Desk's authoritative evidence ledger.

The previous Brain boundary required a durable `LockedHoldoutAccessReceipt`, but Desk did not yet have an immutable fact or replay-safe writer for that receipt. A process restart could therefore lose the fact that a holdout question had already been consumed unless a caller invented its own persistence mechanism.

## Implemented invariant

For one `(holdoutId, questionId)`:

1. the access receipt is appended to the Desk's existing synchronous, hash-chained SQLite ledger before evaluation;
2. an identical retry is idempotent and does not append a second event;
3. a different second receipt is rejected;
4. more than one raw receipt in the authoritative stream is treated as invalid evidence, not as another observation;
5. restart/replay preserves the receipt and the one-shot state;
6. the receipt records both event time (`openedAt`) and ledger knowledge time (`knownAt`), and impossible ordering fails closed;
7. the sealed `populationHash` must use canonical `sha256:<64 lowercase hex>` form;
8. the Brain remains observational only — this milestone adds no promotion or execution authority.

## Design decision: authoritative stream, not a lagging receipt table

A separate SQL projection table was considered and deliberately rejected for the exactly-once decision path.

The Desk projector may be behind the ledger between append and catch-up. If one-shot authorization consulted an eventually-caught-up table, a second caller could incorrectly observe "no receipt" during that lag. Instead, `holdout-access.ts` folds the dedicated hash-chained aggregate stream directly. The ordinary Desk projector explicitly accepts the event as a forensic/durable fact and replay remains deterministic, but the authorization read model is the authoritative stream itself.

This preserves the existing Desk invariant: the ledger is sufficient and projections are disposable.

## Code changes

### `services/desk/src/ledger/events.ts`

Added:

- `HoldoutAccessReceiptRecord`
- durable event `evaluation.holdoutOpened`
- collision-safe stream identity derived from JSON encoding of `[holdoutId, questionId]`
- `evaluation.holdoutOpened` to `DURABLE_KINDS`

### `services/desk/src/ledger/holdout-access.ts`

Added canonical write/read boundary:

- `recordHoldoutAccess(...)`
- `readHoldoutAccessReceipt(...)`
- `listHoldoutAccessReceipts(...)`
- `validateHoldoutAccessReceipt(...)`
- `HoldoutAccessInvariantError`

`listHoldoutAccessReceipts()` returns ledger-derived records whose core fields are structurally compatible with the Brain's `LockedHoldoutAccessReceipt`; the additional `knownAt`, `ledgerSeq`, and `ledgerHash` fields retain forensic provenance rather than moving truth into the Brain.

### `services/desk/src/ledger/projections.ts`

The exhaustive projector now recognizes `evaluation.holdoutOpened` as a durable forensic fact with no mutable projection state. This keeps projector catch-up/rebuild deterministic without making an eventually-caught-up table authoritative for one-shot access.

### `services/desk/src/ledger/holdout-access.test.ts`

Added seven tests covering:

- first durable write;
- identical retry idempotency;
- conflicting second receipt rejection;
- stream-key collision resistance;
- malformed hash / impossible bitemporal ordering;
- process restart and replay;
- raw-ledger duplicate-peek detection;
- projector catch-up and rebuild compatibility.

## CI repair

The first implementation CI run (`verify` #893) stopped at Biome formatting before typecheck/tests. The exact formatter diff was applied to the two new files. No invariant, assertion, or test was removed or weakened.

## Verification ladder

### L0 — pre-change repository state

- existing branch head inspected before changes;
- previous `verify` run #891: SUCCESS.

### L1 — static formatting/lint

- Biome checked 256 files;
- SUCCESS after applying formatter-only repair.

### L2 — type safety

- `packages/core`: PASS
- `packages/contracts`: PASS
- `packages/brain`: PASS
- `services/desk`: PASS
- `apps/mobile`: PASS

### L3 — deterministic test suites

Full workspace run on implementation head:

- contracts: 19 passed
- core: 218 passed
- brain: 155 passed
- mobile: 132 passed
- desk: 520 passed
- total: 1,044 passed

The new `src/ledger/holdout-access.test.ts` suite: 7/7 PASS.

### L4 — failure/recovery evidence

Verified:

- restart preserves the receipt and does not append on identical retry;
- conflicting retry fails closed;
- two manually injected raw receipts are detected as a violated one-shot invariant;
- the hash chain remains verifiable after injected duplicate facts, so the system distinguishes "ledger integrity" from "semantic one-shot validity";
- projector replay remains successful because the ledger fact is fully handled by the exhaustive event switch.

### L5 — hosted CI

Implementation head: `2d5d6b766b5e76eb151d5a119204149a1acbf879`

GitHub Actions `verify` run #897: SUCCESS (`lint + typecheck + full tests`).

## Self-audit

### What is now closed

The holdout receipt is no longer ephemeral Brain input. It is a durable Desk fact with restart-safe identity and fail-closed duplicate semantics.

### Assumption retained

The canonical exactly-once writer inherits the Desk ledger's documented single-writer architecture. A caller that bypasses the canonical writer can append duplicate facts, but those duplicates are immediately detectable by the authoritative stream read model and invalidate the question rather than silently permitting another independent evaluation.

### What is intentionally not added

- no automatic champion/challenger promotion;
- no LLM-generated trading score;
- no broker/account truth from the LLM;
- no new MT5 command or execution permission;
- no real-money execution;
- no Memory layer yet.

## Next architecture step

ADR-0021 is not yet complete. The next required boundary is durable registered hypotheses plus multiple-testing control (Benjamini-Hochberg/FDR or an explicitly justified equivalent), followed by a final Evaluation red-team audit. Only after Evaluation is genuinely closed should ADR-0020 Memory begin deriving validated knowledge from immutable bitemporal observations.
