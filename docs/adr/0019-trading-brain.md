# ADR-0019 — The Trading Brain: deterministic core, LLM at the edge

**Status:** Accepted

## Context

"Build a real Trading Brain" is usually read as "put an LLM in the loop". That reading
fails four of the requirements it is meant to serve, and it fails them structurally
rather than through poor implementation:

- **Confidence cannot be calibrated if it is not reproducible.** Requirement 7 asks
  whether 90–100 signals really outperform 80–90. If the same market state can produce
  91 on Tuesday and 84 on Wednesday, the buckets measure sampling noise in a language
  model, not conviction about a market.
- **Champion/Challenger needs two comparable functions.** Comparing two
  non-deterministic generators on the same input requires many samples per input just to
  estimate each one's mean.
- **Evaluation needs the input to be recoverable.** A prompt is not a feature vector.
- **Cost and latency.** A scan of a dozen instruments across several timeframes on every
  closed bar is thousands of inferences a day. As a synchronous dependency of scanning
  it is both unaffordable and slow.

There is also a correctness argument that outranks all four: an LLM asked for a number
will always produce one, including when the data behind it is missing. That is the
precise failure mode the system's core principle forbids.

## Decision

**The Brain is a deterministic, versioned, pure function. The LLM never produces a
number the system acts on.**

```
   market data ──► feature extraction ──► scoring model ──► scores + rationale codes
   (PIT-filtered)   (pure, versioned)     (pure, versioned)          │
                                                                     ▼
                                                            decision snapshot
                                                                     │
   ┌─────────────────────────────────────────────────────────────────┤
   │                                                                 │
   ▼ deterministic path (fast, free, reproducible, calibratable)     ▼ LLM path
   risk governor ──► mission ──► execution                    explanation ·
                                                              hypothesis generation ·
                                                              natural-language query
                                                              (slow, costly, quarantined)
```

### `packages/brain` follows the discipline of `packages/core`

No clock. No network. No I/O. Inputs in, scores out. Everything it needs — bars, spec,
session state, account state — is passed explicitly. This is what makes it replayable
over history, testable with property tests, and comparable between versions.

A brain evaluation is a pure function:

```
evaluate(BrainVersion, FeatureVector, Context) -> BrainOutput
```

`BrainOutput` carries **scores plus rationale codes** — enumerated, machine-readable
reasons (`TREND_ALIGNED_HTF`, `ENTRY_AGAINST_MOMENTUM`, `SPREAD_ELEVATED`), not prose.
Rationale codes are what make "which filters add noise?" answerable statistically: they
are features of the decision, so their association with outcomes can be measured. Prose
cannot be grouped, counted or tested.

### What the LLM is genuinely good at, and is therefore given

1. **Explaining a decision that has already been made.** It receives the deterministic
   output and the evidence and turns rationale codes into language. It cannot change a
   score, and the score is displayed from the deterministic field regardless of what
   the explanation says.
2. **Generating hypotheses** in the research layer — proposing questions worth testing.
   The testing is statistical and deterministic (ADR-0021).
3. **Querying memory in natural language** — translating a question into a query over
   the derived-statistics store, then narrating results it did not compute.
4. **Summarising** sessions and reviews from computed inputs.

In all four the LLM consumes facts and emits language. It never emits a fact.

**Guardrail:** any LLM output that reaches the operator carries its provenance, and any
figure inside it must be traceable to a deterministic field. An explanation quoting a
number the deterministic layer did not produce is a defect, and the explanation
pipeline validates numerals against the snapshot before display rather than trusting
the model to behave.

### What the scoring model actually is

Not a neural network. A **transparent, weighted rubric over explicit features**, because
at personal data volumes a model with many parameters would fit noise, and because a
rubric can be reasoned about, argued with, and versioned meaningfully.

Feature families: market structure, trend alignment across timeframes, momentum,
volatility state, liquidity and spread, session and event proximity, distance to
significant levels, and risk geometry (stop distance vs ATR, R multiple available).

The rubric's weights are **pre-specified and changed rarely**, through the champion/
challenger process. They are not fitted continuously — see the rubric-overfitting flaw
in `BRAIN-DESIGN-REVIEW.md`, which is the subtlest failure mode in this whole design.

### Model selection for the LLM path

Claude, called from the desk on the execution host, with the current Claude models as
the default and the model id recorded in every snapshot that involved one. Cost is
controlled structurally rather than by tuning: the LLM is off the per-scan path
entirely, so its call volume is bounded by operator interactions and scheduled reviews
rather than by market activity.

### The Brain never touches execution

It produces a mission at `CANDIDATE`/`PLANNED`. Everything after that is the existing
path: risk governor, then supervisor, then broker. The Brain has no privileged route,
cannot bypass a risk rule, and its absence degrades the product to a manual trading
terminal that still works perfectly.

## Consequences

- Scans cost approximately nothing and run on every closed bar without an API budget.
- Any decision can be replayed exactly, which is what ADR-0021 and ADR-0022 stand on.
- The Brain can be run over years of history in seconds, so a challenger has a
  meaningful backtest before it ever sees live data.
- The LLM becomes optional: with no API key the system loses explanations and research,
  and loses nothing else.
- Rationale codes must be designed as carefully as the scores, since they are the unit
  of "which filters help?".

## Rejected alternatives

- **LLM produces the setup score.** Fails calibration, reproducibility, cost and the
  no-invented-numbers rule simultaneously.
- **Small trained ML model (gradient boosting on labelled setups).** Defensible later,
  but at a few thousand labelled scans a year it would overfit, and it would surrender
  the explainability that makes the evidence chain possible. Revisit at 10⁴–10⁵ samples.
- **LLM as a second opinion that can veto.** Sounds prudent, and introduces a
  non-reproducible component into the decision path through a side door.
