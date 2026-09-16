# Alikhande-app- — working rules

An MQL5 / MetaTrader 5 trading system. Read `docs/STATUS.md` first; it is the
single source of truth for project state.

Two Routines work on this repository on a schedule, each in a fresh session
with no memory of the last. If you are one of them, `docs/AUTOMATION.md`
describes what runs, when, and what each run is expected to do — including
that stopping with "nothing useful to do without the owner" is a correct
outcome, and inventing work to look busy is not.

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
