# ADR-0021 — Evaluation: decision quality, calibration, and leakage control

**Status:** Accepted

## Context

Three requirements meet here: score decisions separately from outcomes, make confidence
numbers statistically meaningful, and protect against hindsight and data leakage. They
are one system, because each is worthless without the others — a decision score that
leaks future information is not a decision score, and a calibration curve computed on
contaminated data is a decorative graph with error bars.

The binding constraint is arithmetic, and it is severe. Detecting whether one
confidence bucket genuinely outperforms another, at 80% power:

| Effect being detected | Trades needed | At 200 trades/yr | Scans needed | At 3000 scans/yr |
| --- | --- | --- | --- | --- |
| 55% → 65% (implausibly large) | 751 | 3.8 years | 751 | 3 months |
| 55% → 60% (large) | 3,067 | 15 years | 3,067 | 1 year |
| 55% → 58% (realistic) | 8,571 | **43 years** | 8,571 | 2.9 years |
| 55% → 57% (typical) | 19,337 | 97 years | 19,337 | 6.4 years |

**Executed trades will never answer these questions.** This is not a limitation to
work around; it is the central design constraint, and it dictates three things:

1. The unit of analysis must be the **scan**, not the trade. This is why ADR-0018 makes
   every mission durable — it is the only route to statistical power.
2. The system must be fluent in saying **"insufficient data"**, and must say it far more
   often than it says anything else.
3. Every reported figure carries an interval. A point estimate from 40 samples is a
   number-shaped opinion.

## Decision

### 1. Decision quality is scored on a pre-specified rubric, never fitted to P&L

Eleven dimensions, in three groups that differ by *when they become knowable*:

**Process quality** — decidable from the snapshot alone, no outcome required:

| Dimension | Measured from |
| --- | --- |
| Analysis quality | Data completeness and freshness at decision time |
| Setup quality | Feature agreement, structure clarity |
| Risk quality | Size vs policy, exposure, correlation with open risk |
| Stop placement | Stop vs structure and volatility, not vs what later happened |
| Target logic | R available vs realistic reach for the regime |

**Path quality** — needs the realised path but **not** the P&L:

| Dimension | Measured from |
| --- | --- |
| Directional accuracy | Did price move the predicted way within the horizon |
| Timing | Adverse excursion before favourable; entry vs the bar's range |
| Entry quality | Fill vs the achievable range in that window |
| Trade management | Were modifications consistent with the stated plan |
| Execution quality | Slippage vs expectation, latency, requotes |

**Outcome** — recorded, reported, and never mixed into the decision score:

| Dimension | Measured from |
| --- | --- |
| Realised R | Actual result |

The composite **decision score is computed without the P&L term.** A good decision that
lost scores well; a reckless decision that won scores badly. That is the entire point.

The rubric is **pre-specified and versioned**, and specifically *not* tuned until it
correlates with returns — which would merely reconstruct P&L with extra steps and
discard the independent signal it exists to provide. Rubric changes go through
champion/challenger like any other brain change.

The interesting derived metric is the **relationship** between decision score and
outcome, tracked over time. Persistent zero correlation means the rubric measures
nothing. Perfect correlation means it has become a P&L proxy. Both are alarms.

### 2. Rejected signals are evaluated counterfactually, and always labelled

To answer "did rejected opportunities perform better?", the mission's *stated* plan is
simulated: its entry, its stop, its target, its horizon. Fills are assumed pessimistic —
entry at the worse side of the spread, stop at the worse side, no positive slippage.

Counterfactual R is stored in a separate field from realised R and can **never** be
aggregated into account performance. It exists solely to evaluate the filter, and it is
always shown as hypothetical. The pessimistic-fill rule exists because a counterfactual
that assumes perfect fills makes every rejection look like a mistake.

### 3. Calibration is measured, reported with uncertainty, and recalibrated rarely

For any bucketed confidence claim: a reliability diagram, Brier score, and expected
calibration error, each with bootstrap confidence intervals.

The default display is **not** a curve. It is a table of buckets with observed rate,
sample size, and interval — and a plain verdict per pair of adjacent buckets:
`separated`, `overlapping`, or `insufficient data`. Most rows will read
`insufficient data` for a long time and that is the honest state, not a bug.

Recalibration (isotonic or Platt) applies only when a bucket has enough samples for the
correction to exceed its own error, and it is a versioned brain change.

### 4. Leakage control

**Bitemporal queries.** Every evaluation query is scoped to `knowledge_time ≤ T`. The
evaluator physically cannot see data that arrived after the decision, because the query
layer will not return it.

**Purge and embargo.** Trading labels resolve over time and overlap. Following López de
Prado: training or fitting windows are *purged* of observations whose label horizon
overlaps the test window, and an *embargo* excludes observations immediately after it,
because serial correlation leaks backwards across the boundary too.

**Locked holdout.** The most recent portion of history is sealed. The research layer
cannot query it. It is opened only for a promotion decision, once, and using it a second
time for the same question invalidates it.

**Causal regime labels.** Regimes are computed from trailing data only. Labelling a
period "trending" using the whole window — the natural way to write it — is leakage, and
it is the most likely leak to be introduced accidentally because the code looks correct.

**Registered hypotheses and multiple-testing control.** Every research question is
registered with its test *before* the answer is seen. The registry counts the family of
tests, and reported significance is corrected (Benjamini–Hochberg FDR). Without this, a
research layer that can ask unlimited questions of a small dataset is a machine for
manufacturing false discoveries — it will always find something, and the something will
usually be noise.

### 5. The evaluator's independence comes from method, not from a second model

The requirement asks that the AI producing analysis not be the sole judge of it. Agreed
— but implementing that as *a second LLM grading the first* is theatre: correlated
training, correlated blind spots, no ground truth, and a confident grade either way.

Independence here is **methodological**:

- The evaluator is **deterministic statistics over realised outcomes**, not a model with
  an opinion. Ground truth is what the market did.
- It runs on data the Brain version being judged did not see.
- Its tests are pre-registered.
- It has no shared code path with the Brain beyond the shared domain library.

An LLM may narrate the evaluation report. It may not compute it, and it may not grade a
decision.

## Consequences

- Most questions will read "insufficient data" for months or years. The UI must present
  that as a normal, respectable state rather than an error or an empty chart.
- Scan volume becomes a first-class design parameter: it directly buys statistical
  power, and it is the cheapest power available.
- The research layer is deliberately slowed by registration overhead. That friction is
  the feature.
- Some questions are permanently out of reach at personal volume, and the system should
  say so rather than answer them badly.

## Rejected alternatives

- **Scoring decisions by profit.** Trains the system on luck.
- **Significance testing without multiple-testing control.** Guarantees false discovery
  at the rate the research layer asks questions.
- **A second LLM as the independent evaluator.** Independence without ground truth is
  the appearance of rigour.
- **Standard k-fold cross-validation.** Leaks across overlapping labels and serially
  correlated neighbours; on financial data it reliably produces excellent invalid
  results.
