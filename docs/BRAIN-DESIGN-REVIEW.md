# Critique of the trading-intelligence design

Written against ADR-0018 through ADR-0022, hunting for the failure modes named in the
brief — self-reinforcement, hindsight leakage, false confidence, overfitting — plus the
ones that were not named.

Six flaws were found in the requirements as written. Nine in my own design. One of
those nine has no clean fix and is documented as a permanent limitation.

---

## The finding that reframes everything

Detecting whether one confidence bucket genuinely outperforms another, two-proportion
test at 80% power, α = 0.05:

| Effect | Samples needed | At 200 trades/yr | At 3,000 scans/yr |
| --- | --- | --- | --- |
| 55% → 65% | 751 | 3.8 years | 3 months |
| 55% → 60% | 3,067 | 15 years | 1 year |
| 55% → 58% | 8,571 | **43 years** | 2.9 years |
| 55% → 57% | 19,337 | 97 years | 6.4 years |

**Requirement 7 — "confidence scores must be meaningful" — is unachievable from
executed trades.** Not difficult: arithmetically out of reach within a working lifetime.

This makes requirement 3 — "every scan matters" — the load-bearing requirement of the
entire brief. It was presented as an archival preference. It is in fact the only reason
any of the statistical requirements are reachable, and it is why ADR-0018 makes the
mission (not the trade) the aggregate root.

Even with scans, only large effects resolve inside a year. The system must therefore be
fluent in "insufficient data" and must present that as a respectable answer.

---

## Flaws in the requirements as written

### R1 · "Independent evaluator" implemented as a second AI is theatre — **redesigned**

Requirement 6 asks that the AI producing analysis not be the sole judge of it. Correct
instinct. But a second LLM grading the first has correlated training, correlated blind
spots, no ground truth, and produces a confident grade either way.

Independence must be **methodological**: deterministic statistics over realised
outcomes, on data the judged version never saw, with pre-registered tests. Ground truth
is what the market did. An LLM may narrate the report; it may not compute it.

### R2 · "Trading Brain" read as "LLM in the loop" breaks four other requirements — **redesigned**

A non-deterministic scorer cannot be calibrated (same state, different score), cannot be
compared against a challenger without many samples per input, cannot have its inputs
recovered for evaluation, and costs a fortune at scan volume. Worse, an LLM asked for a
number always produces one — including when the data behind it is missing.

ADR-0019 puts a deterministic, versioned rubric in the decision path and confines the
LLM to explanation, hypothesis generation and querying.

### R3 · Champion/Challenger on historical data is circular — **redesigned**

A challenger derived from history H will outperform on H by construction. ADR-0022
judges challengers **only on missions later than the challenger's creation timestamp**.

### R4 · Memory as stored AI conclusions is a contamination engine — **redesigned**

The AI concludes, the conclusion is stored, the AI later reads it, is influenced, and
concludes it again more confidently. Repetition becomes evidence. Within months the
store is the model's own opinions, mutually reinforcing, indistinguishable from
observation.

ADR-0020's answer: **validated knowledge is derived, never stored.** Statistics are pure
functions of an immutable log. AI output is never an input to the Brain.

### R5 · "Repeatedly validated" needs a definition or it means "repeatedly asserted" — **specified**

Formalised as an eight-level hypothesis grade where promotion requires data the
hypothesis did not exist for.

### R6 · Personalisation defaults the wrong way — **specified**

"Don't overfit to me" needs a default. ADR-0020 makes it `habit` — neutral, no
influence — and requires statistical support to reach `edge` or `leak`. Frequency alone
can never promote a pattern. Almost everything will stay `habit`, which is honest.

---

## Flaws in my own design

### D1 · Confidence is self-fulfilling — **no clean fix; documented**

The worst flaw here, and it is structural.

If the Brain scores a setup 91 and the operator sees 91, they may size it more
confidently, manage it more patiently, and cut it less readily. High-confidence trades
then outperform **because of the label**, not because of the setup. The calibration
curve looks excellent and measures the operator's reaction to a number.

Partial mitigations, all imperfect:
- Record whether the score was visible before the decision (`score_seen: bool`).
- Compare outcomes for missions where scoring ran but was not surfaced.
- Prefer **scan-level directional accuracy**, evaluated with no operator involvement at
  all, as the primary calibration evidence — a scan the operator never acted on cannot
  be contaminated by their behaviour.

That last point is the real fix and it reinforces the same conclusion: **the scan, not
the trade, is the unit that can be trusted.** But for trade-level calibration the
confound is permanent, and any calibration claim derived from executed trades is
labelled as potentially self-fulfilling rather than presented as clean evidence.

### D2 · Scan population drift makes longitudinal comparison invalid — **fixed**

If the instrument list, timeframes or trigger conditions change, this year's scans are
not comparable with last year's, and every trend in the statistics is partly an artefact
of configuration. This would have been invisible and would have corrupted every
long-horizon conclusion.

**Fix:** scan configuration is versioned and stamped on every mission. Statistics are
computed within a configuration cohort by default; cross-cohort comparison is possible
but flagged.

### D3 · The rubric can be overfitted to P&L — **fixed by constraint**

If the decision rubric is tuned until it correlates with returns, it becomes a P&L proxy
and the independent signal it exists to provide is destroyed. The tuning would feel like
progress at every step.

**Fix:** the rubric is pre-specified, changed only through champion/challenger, and
both zero correlation *and* very high correlation with outcome are alarms.

### D4 · The locked holdout is consumed by use — **fixed procedurally**

Every look costs some of its validity, and the pressure to peek is greatest when a
favoured challenger is marginal.

**Fix:** holdout access is a ledger-recorded event naming the hypothesis and the
challenger. The count is displayed. It cannot be silently reused.

### D5 · Counterfactual fills are fiction — **fixed by pessimism**

Optimistic counterfactuals make every rejection look like a mistake, which would push
the system toward taking more trades — the opposite of useful.

**Fix:** pessimistic fills throughout (worse side of spread, no positive slippage),
stored in a field that can never enter account performance.

### D6 · Regime labels leak by default — **fixed**

The natural implementation classifies a period using the whole window. It looks correct
and is hindsight. Regimes are computed from trailing data only, and the regime model is
versioned and calibrated like any other.

### D7 · Recomputation cost could make derived statistics impractical — **accepted risk**

Deriving everything from the log is clean and could get slow. Content-hash caching and
incremental derivation over immutable prefixes mitigate it. Personal-scale data is
small. If it becomes a problem the fix is more caching, never a hand-maintained
statistics table.

### D8 · Rationale codes are load-bearing and easy to design badly — **flagged**

"Which filters add noise?" is answerable only if reasons are enumerated, stable and
mutually exclusive enough to group. Free-text reasons make the question unanswerable.
Codes need the same design care as the scores and are versioned with the brain.

### D9 · The operator is also the labeller — **fixed by exclusion**

If the operator's own review supplies ground truth, their bias becomes the target.
Outcome records are computed from market data; operator self-assessment is a separate,
optional field, never used as ground truth.

---

## Concepts added that were not requested

| Addition | Why |
| --- | --- |
| **Brain kill switch** | One control disables the Brain entirely without touching execution. If it starts producing nonsense, the product degrades to a working manual terminal. |
| **Data availability manifest** in every snapshot | Recording what was *missing* is as important as what was present; a snapshot that omits a stale feed lies about what the decision knew. |
| **Scan configuration versioning** | D2 above. |
| **`score_seen` flag** | The only handle on D1. |
| **Pre-registration + FDR control** | A research layer that can ask unlimited questions of a small dataset is a false-discovery machine without it. |
| **Paired challenger comparison** | Removes market variance; at personal volume this is often the difference between a decidable and undecidable question. |
| **"Insufficient data" as a first-class UI state** | It will be the most common answer for a long time and must look deliberate, not broken. |

## Merged and removed

- Requirements 6, 7 and 8 (evaluator, calibration, research) are **one** evaluation
  layer. Separately they would duplicate query infrastructure and disagree.
- Requirements 2, 11 and 12 (memory, quality control, evidence chain) are **one** memory
  architecture; the derive-don't-store decision resolves all three at once.
- **Removed:** the implied per-scan LLM call. Off the hot path entirely.
- **Removed:** AI-written memory as a category. It does not exist in this design.

---

## Score: the intelligence layer as designed

| Dimension | Weight | Score | Note |
| --- | --- | --- | --- |
| Truth / memory / AI separation | 15 | 10 | Structural, not policy — AI output is not an input |
| Leakage & hindsight protection | 15 | 9 | Bitemporal, purge/embargo, causal regimes, locked holdout |
| Statistical validity | 15 | 8 | Honest about power; D1 remains partly unresolved |
| Memory integrity | 12 | 10 | Contamination is impossible by construction |
| Evaluation methodology | 12 | 8 | Decision/outcome split is sound; rubric quality unproven |
| Safe improvement | 10 | 9 | Forward-only, paired, operator-gated |
| Explainability & evidence chain | 8 | 9 | Derivations name their records |
| Operational independence | 5 | 9 | Brain optional; execution never depends on it |
| Cost & latency realism | 5 | 9 | LLM off the hot path by construction |
| UX of uncertainty | 3 | 6 | Designed, not yet built |
| **Total (design)** | **100** | **88** | |
| **Total (delivered)** | **100** | **0** | Nothing in this document is implemented |

The gap between 88 and 0 is the entire implementation, and the honest reading of an
88-point design with 0 built is that it is a plan, not a system.

## What I would still change if pushed

1. **D1 has no satisfying answer.** Blinding scores from the operator for a fraction of
   missions would give clean calibration evidence, but it means deliberately withholding
   the system's opinion from its user. It may still be right. Worth revisiting once
   there is enough data for the confound to be measurable.
2. **The 400-mission promotion threshold is a judgement, not a derivation.** It comes
   from the power analysis for a moderate effect on paired differences, but the true
   variance is unknown until the system runs. It should be re-derived from observed
   variance after the first six months, and that re-derivation must itself be
   pre-registered rather than chosen to suit a pending challenger.
3. **The rubric's initial weights are informed judgement, not evidence.** They are a
   starting hypothesis, and the honest framing is that brain-v1 is a guess with good
   provenance — not a model.
