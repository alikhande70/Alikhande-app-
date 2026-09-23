# Strategy Research & Evolution

The goal is **not** a strategy. The goal is a process that generates strategies,
tries to destroy them, and keeps only what survives — running continuously, so
that what ends up in the Alikhande core earned its place on evidence rather than
on a nice-looking equity curve.

The default assumption throughout is that any promising result is inflated.
That is not pessimism; it is the base rate. The process that produces backtests
— try things, keep what worked — selects for luck exactly as reliably as it
selects for edge, and the winner looks identical either way.

---

## 1. The constraint that shapes everything

This environment **cannot run MetaTrader 5**. No MetaEditor, no Strategy Tester,
no broker tick data, no bid/ask feed. That is not a temporary inconvenience to
work around; it is a permanent property of where the research runs, and the
architecture is built on top of it rather than pretending otherwise.

What *is* available here: real historical bars from public sources, and enough
compute to test thousands of ideas against them.

So the system is split into **three evidence tiers**, and the whole design
exists to stop tier-0 evidence being mistaken for tier-1 evidence.

| Tier | Runs where | Data | What a pass MEANS | What it does NOT mean |
|---|---|---|---|---|
| **T0 — Screening** | here, automated | public daily/intraday bars, often a **proxy instrument** | "not yet falsified" — worth spending real test time on | Nothing about expectancy on the owner's broker |
| **T1 — Strategy Tester** | owner's Windows MT5 | broker tick data, real spread | the strategy has a measurable result on the real instrument | Nothing about live fills, latency or requotes |
| **T2 — Forward** | demo account | live feed, simulated money | execution and cost assumptions hold | Still not proof of edge — the sample is too small |

**The proxy problem, stated plainly.** The best free gold series reachable from
here is `GC=F`, the COMEX gold **futures** contract. The owner's instrument is
spot **XAUUSD** at a retail broker. These are correlated but they are not the
same thing: different contract specification, roll effects, different session
boundaries, different spread behaviour, different liquidity. A T0 result on
`GC=F` is a **lead**, never a finding about XAUUSD.

Likewise `EURUSD=X` is an indicative rate, not a broker's bid/ask. There is no
real spread in it, so T0 costs are an **assumption** applied on top — and the
assumption is deliberately pessimistic.

---

## 2. The Evidence Gate

Documentation does not stop anyone conflating tiers. Code does.

`research/alkresearch/ledger.py` enforces:

- Every experiment record carries its tier, its data source, its symbol, and an
  explicit `proxy_instrument` flag.
- A strategy's status can reach `CANDIDATE` on T0 evidence.
- A strategy **cannot reach `CHAMPION` without a T1 record**. Attempting it
  raises, in code, not in a review comment.
- No record can be edited or deleted. Corrections are new records that
  supersede, so a failure cannot quietly vanish once it becomes inconvenient.

This is the research-integrity equivalent of `SafetyGate.mqh`. Same reasoning:
a rule that depends on everyone remembering it is not a rule.

---

## 3. The tournament — elimination gates

Candidates climb in order. Each gate has a threshold **written before results
are seen**, because a threshold chosen afterwards is negotiation, not
validation. Failing a gate eliminates the candidate; it does not trigger a
search for a kinder threshold.

| Gate | Tier | Asks | Eliminates when |
|---|---|---|---|
| **G0 Specification** | — | Are the rules falsifiable, and was the hypothesis written before the test? | Rules are ambiguous, or the hypothesis was reverse-engineered from a result |
| **G1 Sanity** | T0 | Does the trade list match the stated rules? | Trades do not correspond to the rules |
| **G2 Sample** | T0 | ≥ 100 trades, spanning ≥ 2 regimes | Too few trades for any conclusion |
| **G3 Cost survival** | T0 | Survives 2× the assumed cost | Edge lives inside normal cost variation |
| **G4 Outlier independence** | T0 | Still positive with the top 5 winners removed | The "edge" was a few lucky days |
| **G5 Parameter plateau** | T0 | Neighbouring parameters also work | The optimum is a spike, i.e. fitted noise |
| **G6 Out-of-sample** | T0 | Holds on a period never used in development, looked at **once** | OOS collapses relative to IS |
| **G7 Walk-forward** | T0 | WFE and the fraction of profitable OOS windows | Inconsistent across windows |
| **G8 Monte Carlo** | T0 | Survivable p95 drawdown | Ruin probability unacceptable |
| **G9 Real instrument** | **T1** | Same conclusion on broker tick data | Conclusion changes — the edge was inside the proxy's noise |

**G9 is the wall.** Everything before it runs here automatically. G9 needs the
owner and MetaTrader 5. Nothing becomes champion without crossing it.

---

## 4. Not one metric — a vector

Net profit is read **last**, because it is the most easily inflated and the
least informative. Every candidate is scored across:

expectancy in R · profit factor · max drawdown and its duration · return over
drawdown · trade count · outlier dependence · IS→OOS decay · walk-forward
efficiency and window consistency · sensitivity to spread and commission ·
sensitivity to parameters · per-regime performance · tail risk · longest losing
run · recovery time · Monte Carlo p95 drawdown · dispersion across sub-periods.

A candidate that is excellent on one axis and fragile on another loses to one
that is merely good on all of them.

---

## 5. Strategy families to explore

The EMA cross currently in the repository is a **reference implementation of
the signal contract**, not a contender. It carries no privilege and is subject
to exactly the same gates as anything else.

Families worth testing, each generating multiple falsifiable hypotheses:

1. **Trend / momentum continuation** — breakout of range, momentum persistence
2. **Mean reversion** — stretch from a moving reference, band extremes
3. **Volatility regime** — expansion/contraction, ATR-conditional behaviour
4. **Session structure** — Asian-range break, London/NY open behaviour, session momentum
5. **Market structure** — swing breaks with explicit confirmation lag
6. **Time-of-day / day-of-week conditioning** — only where a structural reason exists
7. **Cross-asset conditioning** — DXY, real yields, silver for gold
8. **Regime-switching ensembles** — different sub-strategies by measured regime
9. **Do-nothing filters** — improving an existing candidate by trading less

The output may well **not** be a single strategy. If evidence favours an
ensemble or regime-based switching, that is the answer.

---

## 6. The Experiment Ledger

Every run writes a record. Nothing is lost, and nothing failed is repeated by
accident. A record pins everything needed to rebuild the result:

code version (git SHA) · data source, symbol, period, and a content hash of the
bars · the full parameter set · the cost assumptions · the tier · the gate
outcomes · the resulting metrics · the verdict and its reason.

The ledger is queryable, so "has anything like this been tried?" is answerable
before a run rather than after.

---

## 7. The cycle

Each scheduled run does one of these, choosing whichever currently yields the
most information:

1. **Study** — market structure, volatility, sessions, regimes; record what is measurable.
2. **Hypothesise** — write a falsifiable statement and its rejection criterion *first*.
3. **Implement** — the rule, in code, with tests.
4. **Screen** — T0, with the gates.
5. **Attack** — assume the result is wrong; hunt for look-ahead, leakage, a cost error, a data artefact.
6. **Eliminate or refine** — without attachment.
7. **Record** — including, especially, the failures.
8. **Rank** — update the standings; move the champion only on evidence.

When a family is exhausted, move to another. Cosmetic changes to produce a
commit are a failed run.

---

## 8. Standing rules

- **Any result that looks too good is treated as a bug until proven otherwise.**
  The first hypotheses are look-ahead, data leakage, a cost error, and a data
  artefact — in that order.
- **A backtest is not a prediction of future profit**, and no report from this
  system may present it as one.
- **No real-money trading.** `SafetyGate.mqh` stays as it is. All evaluation is
  historical, Strategy Tester, or demo.
- **MT5/MQL5 claims come from official MetaQuotes documentation**, read
  directly. Otherwise they are marked UNVERIFIED.
- **Negative results are results.** A run that eliminates three candidates has
  produced more value than one that adds a fourth unvalidated idea.

---

## 9. The four work cells

The lab runs as four independent recurring cells. Independent matters: **the
cell that builds a strategy is not the cell that validates it.** Not because
anyone would cheat, but because whoever built something already knows which
answer would be pleasant, and that is enough.

| Cell | Every | Does | Never |
|---|---|---|---|
| **1. Research Sentinel** | 1h | Scans for integrity defects; maintains the Research Queue | Runs experiments |
| **2. Strategy Discovery Lab** | 2h | One complete hypothesis cycle, start to verdict | Validates its own output |
| **3. Red Team** | 3h | Takes the strongest survivor and tries to destroy it | Invents strategies |
| **4. Trade Forensics** | 4h | Judges real trades; decisions separately from outcomes | Lets the P/L grade the decision |

### The Research Queue

Six named queues, so "this one is blocked, move to another" is mechanical
rather than a judgement made afresh by every cold session:

`NEW_HYPOTHESIS` · `RETEST` · `RED_TEAM` · `DATA_QUALITY` · `ENGINE_AUDIT` ·
`TRADE_FORENSICS`

Items are ranked by **expected information gain**, not by how promising they
sound — different orderings, and the difference is the whole value. At equal
priority `ENGINE_AUDIT` and `DATA_QUALITY` sort first: an experiment run on a
broken engine or bad data produces a confident *wrong* answer, which is worse
than no answer. An item that cannot state what would be learned is rejected at
construction.

```bash
python3 research/run_lab.py sentinel     # scan, fill the queue, name the next experiment
python3 research/run_lab.py queue        # what to work on, most informative first
python3 research/run_lab.py redteam --strategy donchian_breakout --instrument GOLD
python3 research/run_lab.py forensics    # the trade journal's state
```

---

## 10. Anti-confirmation-bias, enforced structurally

Three guarantees live in types rather than in discipline, because a rule
everyone must remember is not a rule.

**H0 is mandatory for any surviving candidate.** Every ledger record carries
H1 (the strategy contains information) *and* H0 (the mundane explanation:
drift, noise, overfitting, a data error, a cost artefact). A record claiming
`CANDIDATE` or better without a specific H0 raises. `h0_ruled_out_by` may be
empty — that is honest; empty *plus* a claimed edge is what the field exposes.

**Decision quality cannot see the outcome.** `classify_decision` takes a
`DecisionFacts` object, and that type has no profit, no exit price and no
result field. Hindsight is not a bias one can decide not to have: once the
outcome is known it reorganises the memory of the reasoning. Making the
information physically unavailable is the only reliable fix.

**A strong result is a bug report.** The Sentinel flags any screening
expectancy above +0.60R as a suspect rather than a success. Two engine bugs
have already been found by attacking a good-looking number.

### The 2×2 that makes a journal worth keeping

| | Good outcome | Bad outcome |
|---|---|---|
| **Good decision** | Working as designed | **The cost of doing business.** Do not "fix" this |
| **Bad decision** | **The most dangerous cell.** It pays for doing the wrong thing | Correct and move on |

And a loss is not automatically a failure. Most losses are `STATISTICAL` — a
40%-win-rate system produces them as designed, and treating those as failures
is how a working system gets tinkered to death. `STRATEGY`, `EXECUTION`,
`RISK`, `TIMING`, `EXIT` and `RULE_VIOLATION` are the failures worth acting on.

### Correlation is never reported as cause

`find_patterns` splits trades by session, regime, direction, setup, weekday,
hour, duration, rule compliance, whether the trade was modified, and what the
trader did after a win or a loss. With a dozen dimensions and a few hundred
trades, **some bucket differs by chance**. Every finding is stamped
`causal: false` and says so in its own text. A pattern becomes a finding only
when it survives on trades that were not used to discover it.
