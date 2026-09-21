# Alikhande-app- — working rules

An MQL5 / MetaTrader 5 trading system. Read `docs/STATUS.md` first; it is the
single source of truth for project state.

Four work cells run on this repository on a schedule, each in a fresh session
with no memory of the last: **Research Sentinel** (1h), **Strategy Discovery
Lab** (2h), **Red Team** (3h), **Trade Forensics** (4h). `docs/AUTOMATION.md`
says what each does; `docs/RESEARCH.md` §9 says why they are separate.

If you are one of them, start with:

```bash
python3 research/run_lab.py queue     # the six queues, most informative item first
```

A cell whose own queue is blocked moves to another queue. It does not invent
work to fill the run, and it does not make a cosmetic commit.

## Non-negotiable

1. **Never define `ALIKHANDE_ALLOW_LIVE`.** It is the compile-time half of the
   real-money refusal. CI fails the build if it appears, twice over — linter
   rule MQL001 and an independent grep.
2. **Never claim MQL5 code is verified unless it has been through MetaEditor.**
   MQL5 cannot be compiled in a Linux environment. Say what was checked and
   what was not; "it lints" is not "it compiles".
3. **Never guess a broker value.** Digits, point, tick value, contract size,
   volume step, stops level and filling modes all come from `CSymbolSpec`,
   which reads them from the broker. A constant is correct on one broker.
4. **Never state an MQL5 API fact you have not read.** Prefer
   `www.mql5.com/en/docs`, read directly — not summarised, not recalled. When
   something cannot be confirmed, write UNVERIFIED and say what was found.
   Research records go in `docs/research/` with a provenance header.

## Before changing code

```bash
make check     # linter + 61 tests; exactly what CI runs
```

It must pass. If the linter flags your change, the default assumption is that
the linter is right. If it is genuinely wrong, **fix the linter and add a test
for the false positive** — do not rename variables to dodge it, and do not
suppress without a reason (an unjustified suppression is itself a finding).

## Research rules

Strategy research lives in `research/`. `docs/RESEARCH.md` is the design; these
are the rules it enforces:

- **A hypothesis and its rejection criterion are written BEFORE the run.** The
  ledger refuses a record without both.
- **Beating zero is not an edge.** Every candidate is measured against a
  long-only benchmark (instrument drift) and a random-entry band (noise), both
  matched to its own exit structure. This gate eliminates almost everything.
- **Thresholds live in `tournament.THRESHOLDS`** and are changed by a dated,
  reviewable diff — never mid-analysis.
- **Tier-0 screening cannot crown a champion.** The Evidence Gate in
  `ledger.py` raises on the attempt. Champion needs MetaTrader 5.
- **Screening uses PROXY instruments.** `GC=F` is gold futures, not the
  owner's spot XAUUSD. Every result says so.
- **A result that looks good is a suspect.** Check look-ahead, leakage, cost
  error and data artefact before believing it. Three real bugs have been found
  this way already, the most recent inside an attack that was itself producing
  a false verdict.
- **H0 is mandatory for any surviving candidate.** The mundane explanation that
  would produce the same result with no edge — specific to that test, not a
  generic "it might be noise". The ledger raises without it.
- **The builder is not the validator.** The Discovery Lab does not red-team its
  own output; the Red Team does not invent strategies.
- **Decision quality never sees the outcome.** `classify_decision` takes a type
  that has no profit field. Do not add one.
- **Correlation is never reported as cause.** Every pattern the forensics lab
  finds is stamped `causal: false` until it survives on trades not used to
  find it.
- **Negative results are results.** Eliminating three candidates beats adding
  a fourth unvalidated idea. The ledger is append-only for this reason.
- **A backtest is never presented as future profit.**

## Conventions

- **Points or price, never "pips."** `CSymbolSpec::PointsToPrice` /
  `PriceToPoints`. On a 2-digit gold feed "10 pips" is meaningless.
- **Signals read closed bars** — shift >= 1, including on higher timeframes.
  A deliberate live-intrabar read needs a comment saying why.
- **Signals return a stop DISTANCE, never a price.** Only the execution layer
  knows the broker minimum, the spread, and which side the server validates.
- **Order submission lives only in `COrderExecutor`.** Rule MQL010 enforces it.
- **Terminal globals live only in `CRiskManager`.** Rule MQL012 enforces it.
- **The EA file owns events and wiring only.** Logic belongs in a module.
- **English identifiers and comments.** Explicit over clever — the reader will
  be debugging this at a loss.
- Comments explain *why*, especially where the obvious code is wrong. Most of
  this codebase's comments exist because a plausible alternative loses money.

## Where things are

| Path | Contents |
|---|---|
| `MQL5/Experts/Alikhande/` | The EA |
| `MQL5/Include/Alikhande/` | The library |
| `MQL5/Scripts/Alikhande/` | `SymbolSpecDump` (run first on a new broker), `RunTests` |
| `tools/mql5lint/` | The linter |
| `tests/` | pytest suite for the linter |
| `docs/` | Documentation; `STATUS.md` is the live one |

## Keeping documentation honest

Update `docs/STATUS.md` with every change — its verification legend
distinguishes **Working** (executed and observed) from **Written** (never
compiled). Do not promote anything to Working without evidence.

`docs/AUDIT.md` is a point-in-time snapshot and is deliberately not updated.
