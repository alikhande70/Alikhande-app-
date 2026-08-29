# Build report addendum — durable paired Mission projection

Date: 2026-08-28
Branch: `gpt/trading-brain-build`

This addendum records repository evidence added after the current `docs/BUILD-REPORT.md` snapshot. It does not change the external verification boundary: MetaEditor, target MT5, LiteFinance Demo, Windows native packaging and physical Android key behavior remain externally unverified, and no real-money execution is enabled or claimed.

## ADR-0021 / ADR-0022 milestone

`@keel/brain/mission-evaluation` now projects the durable `DecisionSnapshot.brainComparison.evaluations` stored on each Trade Mission directly into forward-only paired scan evidence. The projection consumes immutable Mission snapshot facts; it does not consult the current Brain registry, an LLM, broker/account state or a parallel evaluation truth store.

The projection fails closed when:

- a durable Mission id is repeated in the supplied population;
- paired Brain evaluations are absent when paired projection is requested;
- a Brain content hash is malformed or repeated within one Mission;
- a paired evaluation uses a knowledge cutoff different from the Mission comparison cutoff;
- Brain content is recorded as created after the Mission decision cutoff;
- there is no single champion, or the champion hash differs from the durable `championHash`;
- the champion shadow evaluation diverges from the primary durable `brainEvaluation` in version, status, score or explicit missing fields;
- a challenger did not exist strictly before the Mission knowledge time (`missionKnowledgeTime <= challenger.createdAt`).

For each eligible challenger, the resulting `ForwardPairedScanEvidence` carries the exact Mission id, scan-configuration version, Mission knowledge time, challenger creation boundary, immutable champion/challenger content hashes, semantic Brain versions and scored/insufficient-data decisions. No winner, promotion recommendation, registry mutation or execution side effect is produced.

## Red-team regression coverage

Repository tests now cover:

- successful durable Mission → paired evidence → `buildForwardPairedCohort()` composition;
- rejection of a challenger created exactly at the decision boundary;
- rejection when the durable champion shadow result disagrees with the primary decision;
- rejection of duplicate immutable Brain content identity within a Mission.

The first CI attempt failed only on Biome formatting. The formatter diff was applied without weakening any invariant or test. The exact implementation/test head `fa5952b22061d1d8a3a5d44cb401f40657dc590b` then passed the complete GitHub Actions `verify` job: lint, typecheck and tests.

## Verification ladder delta

| Stage | Status after this milestone |
| --- | --- |
| Repository lint/typecheck/tests | **PASS** on implementation/test head `fa5952b22061d1d8a3a5d44cb401f40657dc590b`. |
| Durable Desk scan population | **BUILT** — hash-verified Mission-ledger projection remains the upstream fact boundary. |
| Durable paired Mission projection | **BUILT** — same-Mission champion/challenger evidence is projected directly from immutable Decision Snapshots with strict forward-only and identity checks. |
| Paired cohort gate | **BUILT** — one challenger cohort at a time, explicit sample/coverage/duration gates, no promotion behavior. |
| Market-derived future outcome labels | **IN PROGRESS / NOT YET BUILT AS RUNTIME FACT GENERATOR**. |
| Paired statistical inference | **NOT YET COMPLETE** — must be pre-registered and operate only on forward evidence. |
| ADR-0020 memory | **BLOCKED ON VALIDATED EVALUATION**. |
| MetaEditor / real MT5 / LiteFinance Demo | **NOT VERIFIED** — external Windows/broker evidence required. |
| Real-money execution | **NOT ENABLED / NOT CLAIMED**. |

## Next highest-priority work

1. Compose the hash-verified Desk population with `@keel/brain/mission-evaluation` in a non-execution evaluation runtime so there is one explicit end-to-end read path and no parallel truth store.
2. Define and implement versioned future-market outcome labels from market-data facts with fixed horizons and conservative fill/counterfactual rules.
3. Red-team the complete `Mission → market outcome → evaluation cutoff → paired cohort` path for duplicate evidence, temporal leakage, replay inflation and missing-data bias.
4. Add pre-registered paired statistical inference and uncertainty appropriate to the actual outcome metric. Do not reinterpret the existing deterministic rubric score as a probability.
5. Keep challenger promotion operator-controlled only. Do not add automatic self-promotion.
6. Start ADR-0020 memory only after validated evaluation facts exist, deriving knowledge from immutable bitemporal observations/statistics rather than AI conclusions.
