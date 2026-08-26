# ADR-0018 — The Trade Mission as the lifecycle spine

**Status:** Accepted

## Context

The intelligence requirements ask for scans to be remembered, decisions to be scored
separately from outcomes, snapshots to be preserved, and the whole lifecycle to be
coherent across two devices. Implemented as separate features these become five
loosely-related tables and a reporting problem.

They are all the same object seen at different moments.

There is also a counting problem hiding here. A personal operator executes perhaps 200
trades a year. At that volume, most questions worth asking are unanswerable — the power
analysis in `BRAIN-DESIGN-REVIEW.md` shows a realistic 3-point win-rate difference needs
roughly 43 years of executed trades to detect. The same question resolves in under 3
years if the unit of analysis is the **scan** rather than the trade.

So preserving scans is not an archival nicety. It is the only thing that makes the
system's own statistics reachable within a useful lifetime, and it therefore has to be
structural rather than a logging afterthought.

## Decision

**A Mission is the aggregate root for one trading idea, from first observation to
final lesson.** A trade is one possible stage of a mission, not its beginning.

```
OBSERVED ──► CANDIDATE ──► PLANNED ──► ARMED ──► EXECUTING ──► MANAGING ──► CLOSED
    │             │            │          │                                    │
    └─────────────┴────────────┴──────────┴────► ABANDONED ◄───────────────────┤
                                                 (rejected / expired /          │
                                                  invalidated / vetoed)         │
                                                       │                        │
                                                       └──────► REVIEWED ◄──────┘
```

Every terminal state leads to `REVIEWED`. **A mission that never became a trade is a
complete record, not an empty one** — it has a decision snapshot, a rationale, and a
counterfactual outcome, and it is exactly as valuable to evaluation as one that filled.

### Stages carry different obligations

| Stage | What must exist | Immutable after |
| --- | --- | --- |
| `OBSERVED` | Instrument, timeframe, trigger, PIT market state | — |
| `CANDIDATE` | Feature vector, brain version, scores, regime label | — |
| `PLANNED` | Entry, stop, target, size, invalidation conditions, risk verdict | **Decision snapshot sealed here** |
| `ARMED` | Operator authorisation, or an auto-arm policy | — |
| `EXECUTING` | Intent id, magic, submission record | Links to the existing order ledger |
| `MANAGING` | Every modification, with reason and origin | — |
| `CLOSED` | Exit, realised R, costs | — |
| `ABANDONED` | Reason, and who or what abandoned it | Snapshot still sealed |
| `REVIEWED` | Decision scores, outcome, counterfactual, evidence links | Scores versioned |

The **decision snapshot seals at `PLANNED`** — the last moment before commitment, and
the only defensible instant to freeze "what did we know". Sealing earlier misses the
plan; sealing later admits information the decision did not have.

### Origin is recorded on every mission and every action

```
origin: 'brain' | 'operator:android' | 'operator:desktop'
      | 'manual:mt5' | 'pending-activation' | 'external:unknown'
```

MT5 makes this mandatory rather than optional. The operator can trade the same account
from the terminal or the MetaQuotes phone app, and a pending order can activate with no
client involved at all. Positions discovered by reconciliation that carry a foreign
magic become missions in state `MANAGING` with origin `manual:mt5` and **no decision
snapshot** — because there genuinely was not one.

This is what stops the Brain being credited for trades it did not produce. A mission
with no snapshot can never contribute to a brain-quality statistic; it contributes to
account statistics only. The distinction is enforced by the absence of data, not by a
flag someone has to remember to set.

### Missions are not orders

A mission may produce zero, one, or several orders (scaling in, partial exits, a
re-entry after invalidation). The existing intent/order ledger is unchanged and remains
the execution record; a mission *references* intents. Execution truth stays exactly
where ADR-0015 put it, and the mission layer sits above it holding intent and meaning.

This separation is load-bearing: **execution truth must never depend on the
intelligence layer being correct, available, or even running.**

### One mission, two devices

A mission is server-side state on the execution host, streamed to both clients through
the existing sequenced snapshot/delta hub. Android and Windows show the same mission at
the same stage. Neither owns it. Each renders it for its device — the phone as a single
focused card with the next action, the desktop as a workspace with the chart, the
snapshot, and the evidence side by side.

## Consequences

- Scans become first-class durable records with the same care as trades, which is what
  makes the evaluation layer statistically viable at all.
- "Why am I in this trade?" has one answer with one home.
- Foreign and manual positions are represented honestly rather than being either
  ignored or misattributed.
- Missions are the natural unit for the champion/challenger comparison in ADR-0022,
  because both brains can score the same mission and be compared pairwise.
- A new storage cost: every scan is retained. At a few thousand a year with bounded
  feature vectors this is megabytes, not gigabytes, and it is the cheapest data the
  system will ever buy.

## Rejected alternatives

- **Trades as the root, scans logged separately.** The obvious design, and it puts the
  statistically essential data in the least-cared-for table.
- **A mission per order.** Loses the idea when it scales in or re-enters; makes
  "was this decision good?" unanswerable across a multi-order expression of one idea.
- **Modelling missions inside the order state machine.** Would couple execution truth
  to intelligence state. Execution must remain correct when the Brain is off.
