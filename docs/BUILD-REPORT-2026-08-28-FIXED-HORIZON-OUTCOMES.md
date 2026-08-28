# Build Report — ADR-0021 Fixed-Horizon Market Outcomes

Date: 2026-08-28

## Milestone

Implemented the first deterministic, versioned future-market outcome labeling boundary for ADR-0021.

`@keel/brain/outcome-labeling` now builds a `VersionedMarketOutcomeLabel` from an immutable decision-time seed, one exact future market-close observation, and a versioned fixed-horizon policy.

## Invariants now enforced

- The horizon is fixed by policy and the market observation must match it exactly. No nearest-bar or later-bar substitution is allowed.
- Market evidence is bitemporal: `recordedAt` cannot precede `validAt`.
- The market symbol must exactly match the Mission seed symbol.
- Reference price and risk distance must be finite and positive.
- Counterfactual R is deterministic and direction-symmetric for long and short scenarios.
- A versioned flat threshold classifies the result as `favourable`, `unfavourable`, or `flat` without modifying the numeric R value.
- Broker-realised trade P/L is deliberately not accepted by this boundary. Realised execution truth remains a separate MT5/broker evidence path.
- The LLM is not involved in label generation and has no scoring, broker-truth, promotion, or execution authority.

## Verification

Simulation/regression coverage includes:

- deterministic long outcome;
- symmetric short outcome;
- flat-threshold behavior;
- wrong-symbol rejection;
- exact-horizon enforcement;
- impossible bitemporal ordering rejection;
- invalid risk/policy rejection.

The implementation head `2374642eda8a94684b5dc7977251b3b6f359df59` passed the repository `verify` workflow (`lint`, `typecheck`, and full tests).

During verification an earlier head failed only on Biome formatting. The exact CI log was inspected and the formatter-required change was applied without weakening any test or invariant.

## Self-audit finding fixed in this milestone

The first implementation allowed a market observation with the correct timestamp but a different symbol to be used. This could have produced a mathematically valid but semantically false outcome label. The Mission seed now carries an exact symbol identity and the labeler fails closed on mismatch.

## Verification ladder

1. **Static contracts:** complete for this boundary.
2. **Unit/regression tests:** complete for deterministic and failure-path behavior listed above.
3. **Repository CI:** passed on the implementation head.
4. **Simulation composition:** next — derive the seed only from immutable Mission decision-time facts and feed generated labels through Mission evaluation cutoffs.
5. **Demo market-data validation:** pending; must use known historical/demo data and preserve valid-time/recorded-time semantics.
6. **Real-money validation:** not authorized and not claimed.

## Next sequencing step

Do not start ADR-0020 Memory yet. Continue ADR-0021 by composing:

`hash-verified Mission population -> immutable outcome seed -> versioned future market observation -> evaluation cutoff -> paired champion/challenger inference`

The next implementation must prove that `referencePrice`, `riskDistance`, `direction`, and `symbol` originate from immutable decision-time Mission facts rather than current broker state, mutable projections, or AI conclusions. Statistical comparison remains forward-only after challenger creation and cannot automatically promote a challenger.
