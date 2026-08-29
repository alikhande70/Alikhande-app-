# ADR-0020 — Memory: derive knowledge, do not store it

**Status:** Accepted

## Context

The requirement is a memory system that distinguishes "something that happened once"
from "something repeatedly validated", ages knowledge, handles contradiction, and keeps
an evidence chain.

The obvious design — an AI writes conclusions into a knowledge store, and later reads
them back — contains a failure mode that destroys the system slowly and invisibly:

> The AI concludes something. The conclusion is stored. Later the AI reads it as
> context, is influenced by it, and concludes it again more confidently. Repetition is
> mistaken for evidence. Within months the store is full of the model's own opinions,
> mutually reinforcing, indistinguishable from observation.

This is not hypothetical; it is what happens to any system where a generator's output
becomes its own input without a barrier. It must be designed out, not policed.

## Decision

**Validated knowledge is never stored. It is derived, on demand, from an immutable
observation log — and it is therefore always recomputable, always current, and
structurally incapable of containing an opinion.**

Memory is six stores with genuinely different rules, not one store with a type column.

### 1. Observation log — immutable, bitemporal, the only ground truth

Every fact the system ever saw: market state, scans, decisions, orders, fills,
reconciliations, operator actions. Append-only, hash-chained, in the existing ledger.

Every record carries two timestamps:

- `valid_time` — when it was true in the world
- `knowledge_time` — when *we* learned it

Bitemporality is what makes hindsight-free evaluation possible at all: every historical
query is "as known at time T", and the answer at T never changes afterwards even when
the world later revises it. See ADR-0021.

### 2. Decision snapshots — immutable, sealed, content-addressed

Sealed at mission stage `PLANNED`. Contains the feature vector, brain version, scoring
model version, regime label, scores, rationale codes, prompt/model id if an LLM was
involved, and — critically — a **data availability manifest** naming what was
*missing*: which feeds were stale, which timeframes were incomplete, which values could
not be computed.

A snapshot that silently omits a missing feed is a lie about what the decision knew.
Recording absence is as important as recording presence, and it is the field most
likely to be dropped by a well-meaning refactor, so it is required by the type.

Snapshots are content-hashed and referenced by hash, so a snapshot cannot be edited to
match a later story.

### 3. Outcome records — immutable

What happened: realised path, MAE/MFE, exit, costs, realised R. Linked to the snapshot
by hash. Recorded by deterministic evaluation of market data, **not** by operator
self-report, which is a separate optional field and is never treated as ground truth.

### 4. Derived statistics — recomputable, never written by hand or by an AI

Every aggregate — win rates by bucket, calibration curves, regime-conditional
performance, rationale-code effectiveness — is a **pure function of stores 1–3**.

Nothing is incrementally accumulated into a "knowledge" table. Statistics are computed
from the log with a `knowledge_time` cutoff, cached with the inputs' hash, and
invalidated when the log grows.

This single decision resolves most of the memory requirements at once:

- *Aging* is automatic — a recency-weighted or windowed statistic simply stops
  reflecting old data; nothing has to expire.
- *Revalidation* is automatic — every recomputation is a revalidation.
- *Contradiction* between stored facts is impossible, because there is one derivation.
- *Contamination by AI output* is impossible, because AI output is not an input.
- *Evidence chains* are free — the derivation names the exact records it consumed.

### 5. Hypotheses — the only mutable, textual memory, and always labelled

Claims not yet (or not ever) reducible to a derived statistic: "London-session
breakouts on gold underperform after a US CPI release."

Each carries a grade, and the grade is assigned by evidence, not by confidence of
phrasing:

| Grade | Meaning | How it is reached |
| --- | --- | --- |
| `proposed` | Someone or something suggested it | Research AI, operator, or observation |
| `registered` | A falsifiable test has been pre-specified | Before any result is looked at |
| `observed` | Consistent with data, underpowered | Effect present, CI includes null |
| `supported` | Statistically supported on in-sample data | Pre-specified test passes |
| `validated` | Held on data the hypothesis never saw | Forward or held-out confirmation |
| `contradicted` | Data rejects it | |
| `superseded` | A better formulation replaced it | Links to successor |
| `dormant` | Was validated; no longer holds | Regime change or decay |

A hypothesis may **never** be consumed as fact by the Brain. Only `validated`
hypotheses may even be shown as guidance, always with their evidence and sample size
attached. Nothing below `validated` influences anything automatically, ever.

The path from `proposed` to `validated` runs through ADR-0021's registry and requires
data the hypothesis did not exist for. That is the barrier that stops repetition
becoming evidence.

### 6. Operator profile — behaviour, classified by evidence not frequency

Personalisation must not become "the operator does this a lot, therefore it is right".
So observed patterns are classified:

| Class | Meaning | Requires |
| --- | --- | --- |
| `preference` | Arbitrary, legitimate, honour it | Operator stated it |
| `habit` | Recurring, effect unknown | Frequency only — **the default** |
| `edge` | Recurring and measurably positive | Statistical support with CI excluding null |
| `leak` | Recurring and measurably negative | Same standard |

`habit` is the default and the honest resting place for almost everything, because at
personal volumes almost nothing reaches significance. Frequency alone can never promote
a pattern to `edge`. A system that learns "you usually do X, so X must be good" has
learned to flatter, and flattery from a trading system is expensive.

`leak` classification is surfaced gently and factually — the evidence, the sample, the
cost in R — never as a scolding, and never on a sample too small to mean anything.

## Consequences

- The memory layer is mostly *query*, not *storage*. Its complexity lives in derivation
  and caching rather than in schema and lifecycle management.
- Recomputation cost is real. Mitigated by content-hash caching and by the fact that
  personal-scale data is small: years of scans fit comfortably in SQLite.
- There is no "the AI remembered something wrong" failure mode, because the AI does not
  write to memory. It can only propose hypotheses, which are labelled as such until
  data promotes them.
- Deleting a mistaken observation is a ledger correction with an audit trail, not a
  quiet edit.

## Rejected alternatives

- **Vector store of AI-written notes (the default "AI memory" design).** Every failure
  mode above, plus retrieval that surfaces text by similarity rather than by evidential
  relevance. A vector index over *observations* may later help retrieval; an index over
  *conclusions* is the contamination engine itself.
- **Incrementally accumulated statistics tables.** Fast, and they drift from the log,
  cannot be recomputed after a bug, and quietly encode whatever the accumulation logic
  believed on the day it ran.
- **Letting the Brain read hypotheses as context.** The single change that would undo
  this entire architecture.
