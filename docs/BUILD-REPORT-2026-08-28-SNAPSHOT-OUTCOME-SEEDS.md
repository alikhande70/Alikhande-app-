# Build Report — Snapshot-Derived Outcome Seeds

Date: 2026-08-28
Branch: `gpt/trading-brain-build`
Architecture: ADR-0018 through ADR-0022

## Objective

Close the ADR-0021 boundary between immutable Trade Mission decision evidence and fixed-horizon market outcome labels. Outcome direction, reference price and risk normalisation must no longer be freely supplied by an evaluation caller when a sealed Mission plan already contains that historical truth.

## Implemented

- Added `projectOutcomeSeedFromDecisionSnapshot()` in `@keel/brain/outcome-labeling`.
- The projection derives:
  - Mission `canonical` -> market symbol,
  - `plan.side` -> long/short direction,
  - `plan.entry` -> historical reference price,
  - absolute entry/stop distance -> R denominator,
  - deterministic Brain `knowledgeCutoff` -> decision knowledge-time.
- The Desk evaluation population now carries the immutable Mission canonical symbol, allowing the hash-verified ledger projection to structurally feed outcome labeling without creating a Brain dependency in the execution host.
- No broker/account truth, LLM output, current Brain registry state or mutable cache participates in this derivation.

## Fail-closed / insufficient-data rules

- A Mission with no deterministic Brain evidence is `insufficient-data` for this outcome basis.
- A rejected/unplanned Mission with no directional plan remains `insufficient-data`; no direction, entry or stop is guessed after the fact.
- Missing entry/stop remains explicit missing evidence.
- Non-price persisted entry/stop strings fail closed instead of being coerced.
- Snapshot `asOf` after the Brain knowledge cutoff fails closed.
- Buy plans require stop < entry; sell plans require stop > entry before R normalisation.
- The existing exact-horizon, matching-symbol and bitemporal market-observation guards remain in force.

## Tests / red-team cases

Added coverage for:

- deterministic buy snapshot -> outcome seed,
- direct snapshot -> seed -> fixed-horizon label composition,
- rejected/unplanned scan -> insufficient-data,
- missing entry -> insufficient-data,
- future/historically impossible decision timing,
- stop on the profitable side for both buy and sell,
- non-numeric plan price injection,
- canonical symbol retained through the durable Desk evaluation population.

## Verification ladder

1. Prior branch head `0a43e0a9262135fcee60ca87fc4980ce2c2dc475`: GitHub Actions `verify` successful before this work began.
2. Implementation/test head `0eaba614d0edb9fd3dcb373f029103fa4ee0deaf`: GitHub Actions `verify` run 690 completed successfully, covering lint, typecheck and tests.
3. This documentation commit must also pass `verify` before being treated as the final coherent head for this milestone.

## Self-audit

The important limitation is deliberate: not every rejected scan has a directional executable plan. Creating a long/short counterfactual for such a scan from later information would be hindsight. Those Missions therefore remain in the scan-level evaluation population but do not receive a fabricated R-normalised directional outcome. A future architecture change may add a first-class, point-in-time directional evaluation basis for rejected scans, but it must be sealed at decision time and versioned; it must not be reconstructed later.

## Safety / authority statement

This milestone adds evaluation-only derivation. It adds no `OrderSend`, broker command, risk bypass, automatic Champion promotion, LLM trading score, account-truth source, or real-money execution path.
