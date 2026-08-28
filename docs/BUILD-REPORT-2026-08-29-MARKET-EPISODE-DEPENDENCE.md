# Build Report — ADR-0021 Market-Episode Dependence Guard

Date: 2026-08-29  
Branch: `gpt/trading-brain-build`  
Verified implementation head: `1a26d154b81a36d3f09c2edcede90ff2fde1548a`

## Purpose

ADR-0021 requires scan-level evidence for statistical power, but scan count is not the same as independent evidence. Repeated scans from one continuing market move can be strongly dependent. Treating every scan as a fresh independent observation would create false precision even while preserving the correct raw denominator.

This milestone adds a conservative, deterministic dependence boundary before paired Champion/Challenger evidence can be considered ready.

## Implemented

### Deterministic market episodes

`@keel/brain/dependence-guard` now groups durable scan evidence by canonical instrument and ledger knowledge-time.

- Episode membership is deterministic and independent of input ordering.
- Only consecutive scans for the same canonical instrument may share an episode.
- A new episode starts when the fixed time gap is exceeded.
- Simultaneous scans on different canonical instruments remain distinct episodes.
- Duplicate Mission identities, missing canonical identity, impossible timestamps and invalid policy fail closed.
- The report preserves raw scan count while exposing a conservative `effectiveEvidenceUnits` count equal to the number of market episodes.
- The implementation explicitly does **not** claim this count is an estimated statistical Neff or that separated episodes are mathematically independent. It is a readiness guard against the simpler and dangerous error of treating repeated scans in one move as independent samples.

### Pre-registration boundary

`@keel/brain/dependence-aware-evaluation` composes the existing fixed-look durable evaluation with the episode guard.

The episode gap and minimum independent episode count live inside the analysis plan. They are therefore fixed before forward evidence instead of being tuned after outcomes are visible.

The episode report remains hidden while the pre-registered analysis window is open. Once the fixed analysis cutoff is reached, a large raw sample from one continuing episode cannot make the top-level paired result `ready`; the result remains `insufficient-data` with a machine-readable reason.

### Decisive-evidence concentration guard

Self-audit found a second failure mode after the first implementation: the full eligible population could span many episodes while all non-flat, fully-scored, non-tied evidence that actually drives the inference came from a single episode.

That gap is now closed.

`PairedOutcomeInferenceReport` exposes the immutable Mission identities behind decisive directional comparisons. The dependence-aware composition runs the same pre-registered episode guard twice:

1. across the complete eligible durable scan population; and
2. across only the Mission identities that actually drive directional paired inference.

Both must meet the episode requirement. Quiet, tied or incomplete scans can no longer make clustered decisive evidence look independent.

### Canonical identity protection

The Desk durable population already carries canonical instrument identity. The dependence-aware boundary requires that eligibility identity to agree with the immutable Mission projection when a sealed Mission exists. Rewriting `XAUUSD` as another instrument for clustering purposes fails closed.

## Red-team / failure cases

Tests now cover:

- twenty tightly repeated same-symbol scans collapsing to one conservative evidence unit;
- separate instruments at the same timestamp remaining separate episodes;
- deterministic grouping under input reordering;
- duplicate Mission inflation refusal;
- invalid pre-registered episode policy refusal;
- raw paired inference passing while overall episode readiness fails;
- full population spanning several episodes while all decisive directional evidence is concentrated in one episode;
- canonical instrument identity drift refusal; and
- no episode diagnostics leaking before the fixed analysis window closes.

## CI repair history

The first CI attempt failed only on Biome import ordering/formatting in the new files. The exact formatter changes were applied without weakening any test or invariant.

A later self-audit change initially failed on one Biome line-wrap difference in `paired-inference.ts`. The exact formatter output was applied. No statistical or safety rule was relaxed.

Final implementation head `1a26d154b81a36d3f09c2edcede90ff2fde1548a` passed the repository `verify` workflow, including lint, TypeScript typecheck and the full test suite.

## Verification ladder update

| Stage | Status | Evidence / boundary |
| --- | --- | --- |
| Immutable scan denominator | PASS | Durable Desk population includes all internal scans, including missing comparison snapshots. |
| Fixed-look / optional stopping guard | PASS | Pre-registered analysis cutoff prevents repeated-look evidence growth. |
| Raw pairing coverage | PASS | Missing Challenger comparison remains in the denominator. |
| Market-episode dependence guard | PASS — repository level | Same-instrument temporally adjacent scans cannot satisfy readiness as independent evidence. |
| Decisive-evidence episode guard | PASS — repository level | Directional inference-driving Missions must independently satisfy episode readiness. |
| Statistical model under residual cross-episode dependence | OPEN | Episode separation is a conservative gate, not proof of independence; cluster-balanced/robust uncertainty remains the next statistical hardening target. |
| ADR-0020 validated memory | BLOCKED BY DESIGN | Memory remains deferred until evaluation evidence is sufficiently hardened and validated. |
| Windows + MetaEditor + MT5 + LiteFinance Demo | NOT VERIFIED EXTERNALLY | Requires target Windows/terminal/broker environment. |
| Real-money execution | NOT ENABLED / NOT CLAIMED | No authorization or external real-money validation exists. |

## Architectural boundaries preserved

- No automatic Champion/Challenger promotion was added.
- No LLM-generated actionable score or broker/account truth was added.
- No execution authority was granted to evaluation or Brain code.
- No new `OrderSend` or real-money path was added.
- Raw scan count remains durable evidence; dependence guarding changes readiness, not historical truth.
- ADR-0020 Memory remains intentionally deferred.
- `claude/personal-trading-app-atm6e1` remains outside this workstream and untouched.

## Next highest-priority work

ADR-0021 is stronger but not complete. The next statistical hardening target is uncertainty under residual dependence: episode separation prevents obvious scan inflation, but it does not mathematically prove independence between episodes. The next implementation should evaluate cluster-balanced or cluster-robust paired uncertainty using only pre-registered, forward-only evidence, while preserving explicit `insufficient-data` states and no automatic promotion.

After that, longitudinal cohort maturity and regime-distribution drift should be red-teamed before ADR-0021 is declared complete and ADR-0020 Memory is allowed to derive validated knowledge.
