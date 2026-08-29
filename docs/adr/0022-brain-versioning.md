# ADR-0022 — Brain versioning, and promotion by evidence

**Status:** Accepted

## Context

The Brain must improve without drifting, and must never change silently. A champion/
challenger process is the right shape. The obvious implementation of it contains a
circularity that makes it worthless:

> The challenger is derived by studying history H. It is then evaluated on H, where it
> naturally outperforms — that is what "derived from" means. It is promoted. It then
> underperforms live, and nobody understands why.

Shadow mode on historical data is not evidence when the history is what produced the
candidate. Any promotion process that does not confront this is a ritual.

## Decision

### Versioning

A brain version is an immutable, content-hashed bundle: feature extractors, rubric
weights, thresholds, regime model, calibration mapping. Semantic id (`brain-v3`) plus a
content hash. Every decision snapshot records the exact hash that produced it, so
"which decisions came from which brain" is answerable by construction.

A version record carries: what changed, why, the evidence that motivated it, the
hypothesis id it came from, and — once promoted or rejected — how it actually performed.

**Nothing changes brain behaviour except a version bump.** No runtime tuning, no
adaptive weights, no silent recalibration. A version bump is the *only* mechanism.

### Promotion requires forward evidence

The rule that fixes the circularity:

> **A challenger is judged only on missions whose `knowledge_time` is later than the
> challenger's creation timestamp.**

History is used freely for *developing* a challenger and for sanity-checking it. It is
never used as promotion evidence. The clock starts when the candidate is sealed.

The locked holdout of ADR-0021 provides one additional, single-use check.

### Paired shadow comparison

Every mission is scored by the champion **and** every active challenger. Both outputs
are recorded; only the champion's reaches risk and execution.

Pairing matters more than it sounds. Comparing two brains on the *same* missions removes
market variance from the comparison, and at personal volume that difference is often the
difference between a decidable question and an undecidable one. Unpaired comparison of
two periods would need several times the sample.

Comparison uses paired differences per mission on the primary metric, with a bootstrap
confidence interval on the mean difference.

### Promotion conditions

All of the following, pre-specified before the challenger starts:

1. **Sample.** At least 400 paired scored missions in the forward window, and at least
   40 that reached execution. Numbers derived from the power analysis in ADR-0021, and
   fixed in advance so they cannot be relaxed when a favoured challenger falls short.
2. **Primary metric.** Improvement in decision-score-to-outcome correlation, with a 95%
   bootstrap CI on the paired difference excluding zero.
3. **Guardrails, none of which may degrade materially:** calibration error, false-signal
   rate, risk-quality score, and realised expectancy.
4. **Calibration.** The challenger's confidence buckets must be at least as
   well-separated as the champion's.
5. **No regime blind spot.** No market regime in which the challenger is materially
   worse, even where it is better overall. A brain that improves on average by failing
   badly in one regime is a worse brain.
6. **Minimum duration.** At least 60 days, regardless of sample. Guards against a
   challenger that happens to suit one fortnight's conditions.

Promotion is an **explicit operator decision**, presented with the full comparison. The
system never promotes itself. Automatic self-modification is exactly the behaviour this
ADR exists to prevent.

### Rollback

The previous champion stays loaded and continues scoring in shadow after demotion. If
the new champion degrades beyond a pre-specified threshold on a rolling window, the
system raises a critical alert and recommends rollback — and rollback is one operator
action, because the old version is still running.

### Limits, stated plainly

At personal volume, 400 paired missions is roughly a quarter to half a year of scanning.
**A brain version can be evaluated properly perhaps twice a year.** That is slow, and it
is the honest consequence of the arithmetic. The alternative — promoting on 50 samples
because waiting is frustrating — is how a system starts chasing noise, and it would
undo every other protection in this design.

Faster iteration is available where it is legitimate: bug fixes and feature additions
that are *not* expected to change scoring behaviour ship as patch versions with a
regression test proving outputs are unchanged on a historical corpus.

## Consequences

- Brain changes are rare, deliberate and evidenced. The system is designed to change
  slowly, which is correct for a system whose main risk is fooling itself.
- Running several challengers concurrently is supported and cheap (deterministic scoring
  is nearly free), but multiplies the testing family and is therefore counted by the
  registry and corrected for.
- Every historical decision is attributable to an exact brain hash forever.

## Rejected alternatives

- **Continuous online learning.** Would track noise at this data volume, and makes every
  historical decision unattributable.
- **Backtest-only promotion.** The circularity above.
- **Automatic promotion on a metric threshold.** Removes the one human check on a system
  modifying its own judgement.
- **A/B by time period (champion this week, challenger next).** Confounds the comparison
  with market conditions and discards the power that pairing provides.
