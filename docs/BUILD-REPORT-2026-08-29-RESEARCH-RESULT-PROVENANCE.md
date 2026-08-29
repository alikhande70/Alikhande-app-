# Build Report — Research Result Provenance Retention

Date: 2026-08-29
Branch: `gpt/trading-brain-build`
Scope: ADR-0021 evaluation hardening

## Starting verification

- Starting head: `93488fe27798f413926033cbe55e0a06b080425b`.
- Latest `verify` workflow for that exact head was successful.
- No change was made to `claude/personal-trading-app-atm6e1`.

## Defect found

The ledger-registered FDR boundary validated durable registration provenance before evaluation, but the returned statistical result discarded the exact Desk ledger identity and registration transaction time. A later audit or memory layer could therefore receive a statistically valid result without an explicit immutable link to the durable fact that authorized the evaluation.

## Change

`LedgerRegisteredResearchEvaluation` now retains `registrationProvenance` containing:

- source identifier,
- durable ledger sequence,
- ledger row hash,
- sealed family hash,
- declared `registeredAt`, and
- durable `registrationKnownAt`.

The provenance is retained for both complete and insufficient-data evaluations. `promotionAction` remains `none`.

The public evaluation facade exports the provenance type so downstream audit code can preserve the link without importing internal evaluator modules.

## Tests / red-team cases

Added assertions that:

1. complete evaluations retain the exact durable row identity and bitemporal registration timestamps;
2. insufficient-data evaluations retain the same provenance and cannot shed it while reporting zero discoveries;
3. forged source identity still fails closed;
4. malformed ledger sequence/hash still fail closed; and
5. family tampering still fails against the sealed family hash.

## Dependency/orchestration status

The intended production path remains:

`verified Desk ledger -> ledger-derived registration -> deterministic Brain FDR`.

A direct Desk -> Brain dependency was not added in this run because the available execution environment could not regenerate and verify `pnpm-lock.yaml` from a real checkout. The repository uses `pnpm --frozen-lockfile` in CI, so manually editing only `package.json` would knowingly break verification. This is left explicit rather than weakening the lockfile gate.

## Safety invariants

- No broker command was added.
- No MT5 execution authority changed.
- No real-money execution was enabled or claimed.
- No LLM-generated actionable score was introduced.
- No automatic champion/challenger promotion was introduced.
- Memory work remains blocked on completion and independent audit of ADR-0021.

## Next exit criterion

Add the official Desk -> Brain orchestration only with a valid regenerated lockfile and TypeScript project reference, then run restart/replay, provenance-forgery, duplicate-registration, and repository-wide bypass tests before declaring ADR-0021 complete.
