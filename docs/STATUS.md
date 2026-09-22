# Project status

**Single source of truth for where Alikhande-app- stands.**
Updated with every change. `docs/AUDIT.md` is a point-in-time snapshot and is
deliberately *not* updated.

**Last updated:** 2026-09-22
**Branch:** `claude/alikhande-app-team-audit-mmoz9k`
**Phase:** foundation awaiting first compile; strategy research running

---

## One-paragraph summary

Two subsystems, at very different stages.

**The MQL5 trading core** is written and unverified: a structural refusal to
trade real money, a broker-spec-driven sizing and order layer with explicit
retcode policy, persisted kill switches, and a strategy boundary. **None of it
has been compiled** — MetaEditor is Windows-only — and that remains the single
largest open risk.

**The strategy research system** is built and running. It screens candidate
strategies against real historical bars, measures them against null benchmarks,
and eliminates them through a gate ladder. Its first real output was to
eliminate all four candidate families tested, including the EMA cross already
in the MQL5 tree — and to show that the apparent edge on gold was the
instrument tripling in price, not the strategies. **There is no champion, and
there cannot be one until the owner runs MetaTrader 5**: the Evidence Gate
refuses to record one on screening evidence.

---

## What exists

| Area | State | Verified how |
|---|---|---|
| Safety gate (four-factor real-money refusal) | Written | Logic asserted in `RunTests.mq5`; **not compiled** |
| Alert-only default execution mode | Written | **Not compiled** |
| Broker spec cache + volume/stop math | Written | Asserted in `RunTests.mq5`; **not compiled** |
| Filling-mode resolution | Written, docs-verified | Official MetaQuotes pages read directly; regression test written |
| Order layer (retcode policy, retries, ownership) | Written | Classification asserted; **order submission untested** |
| Risk manager (sizing + kill switches) | Written | Arithmetic asserted; **not compiled** |
| Session clock (GMT offset, windows, rollover) | Written | Window logic asserted; **not compiled** |
| Signal boundary + EMA-cross reference | Written | **Not compiled. Not an edge — no validated expectancy** |
| In-terminal assertion suite | Written | **Not compiled** |
| `mql5lint` + tests | **Working** | `make check` passes; runs in CI |
| Research engine (T0 screening) | **Working** | 117 tests; real results produced and recorded |
| Experiment Ledger + Evidence Gate | **Working** | Tested; refuses a champion claim on screening evidence |
| Tournament gates G1–G9 | **Working** | Eliminated all four candidate families on real data |
| Tier-1 validation scripts | Vendored | For MT5 trade lists; cannot run here for lack of input |
| Research Queue (six queues) | **Working** | Seeded with 17 items; blocked items sort last, not out |
| Sentinel integrity scanner | **Working** | Found 2 real defects on its first run |
| Red Team attack suite | **Working** | Destroyed the leading candidate on two axes |
| Trade Forensics lab | **Working (no input)** | Tested; the classifier cannot see outcomes by construction |
| CI workflow | **Working** | Run [34956953390](https://github.com/alikhande70/Alikhande-app-/actions/runs/34956953390) on `db9572d` concluded **success** |
| Documentation | Written | — |

### Verification legend

- **Working** — executed here and observed to pass.
- **Written, docs-verified** — behaviour confirmed against an official source
  read directly.
- **Written** — reviewed against the MQL5 pitfall catalogue, never compiled or
  executed.

---

## Open risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-01 | **No MQL5 code has been compiled.** Syntax or type errors are likely on first build. | **High** | Owner compiles in MetaEditor and reports diagnostics. Nothing downstream is trustworthy until this clears. |
| R-02 | No strategy has been specified, so nothing can be validated against intent. | **High** | Blocked on the owner — see open questions. |
| R-03 | Order submission, fills and partial fills are untested. | **High** | Needs a demo account plus Strategy Tester. Cannot be done from here. |
| R-04 | CI cannot prove compilation; a green badge means lint + tooling tests only. | Medium | Stated in `docs/TESTING.md` and in the workflow's own header. A Windows runner would close it. |
| R-05 | Most research findings are UNVERIFIED by the maintainer. | Medium | `docs/research/` carries a provenance header. Only the filling-mode finding was independently read and allowed to change code. |
| R-06 | The bundled EMA cross could be mistaken for a strategy. | Medium | Says so in its own header, in `docs/ARCHITECTURE.md` and here. |
| R-07 | Kill switches evaluate on ticks; a gap or halt can exceed a limit before the EA sees a price. | Low | Inherent to the platform. Documented in `docs/SAFETY.md` §7. |
| R-08 | The total-drawdown halt releases if equity recovers, unlike a prop firm's permanent breach. | Low | Intended circuit-breaker behaviour; documented in `docs/SAFETY.md` §7. Must be closed deliberately before any funded account. |
| R-09 | **Screening runs on a PROXY instrument.** `GC=F` is COMEX gold futures, not the owner's spot XAUUSD. | **High** | Flagged on every record by the ledger. No T0 result can become champion — `docs/RESEARCH.md` §2. |
| R-10 | T0 cost assumptions are assumptions. The screening data has no bid/ask. | Medium | Set pessimistically; every candidate must survive 2× them (gate G4). |
| R-11 | No candidate has any Tier-1 evidence, so the tournament cannot finish. | **High** | Gate G9 is blocked on the owner running MetaTrader 5. |
| R-12 | **This branch duplicates research machinery that already exists, more rigorously, on `gpt/trading-brain-build`.** | **High** | `docs/BRANCHES.md`. Needs an owner decision on the main line before more is built here. |
| R-13 | Scheduled cells run, succeed, and publish nothing. ~50 runs, 0 commits. | **High** | Cause not established. Verification step added; if it persists the cells should be disabled. |

---

## Open questions for the owner

Nothing below blocks the work in progress — the foundation is deliberately
strategy-agnostic so these answers can arrive without rework.

1. **What is the strategy?** Instrument(s), timeframe, and the entry/exit rules
   as precisely as you can state them. Even "I trade the London open on gold
   with structure breaks" is enough to begin turning into falsifiable rules.
2. **Which broker and account?** The symbol's exact name, digits and contract
   size change the arithmetic. `SymbolSpecDump` answers this in one run — its
   output is the most useful single thing you can send back.
3. **Risk budget.** Is 0.5% per trade / 3% daily / 8% total right, or are you
   working to prop-firm rules with specific numbers?
4. **Is MT5/MQL5 the right reading of this project at all?** It is an inference
   from your brief, not from anything in the repository (`docs/AUDIT.md` §3).
   If it is wrong, saying so now costs one message.

---

## Done in this session

- Audited the repository and recorded the greenfield baseline honestly, as
  absences rather than invented defects.
- Built the MQL5 core library, the safety gate and the reference strategy.
- Verified the filling-mode rules against the official MetaQuotes documentation
  and **corrected a real bug**: the RETURN fallback under Market execution would
  have produced retcode 10030 on every tick. The skill guidance this project
  started from was wrong on that point too.
- Built `mql5lint` with 12 money-relevant rules, justified suppressions, and 61
  tests; fixed a false positive it found in its own assertion harness.
- Wired CI and `make check`.
- Wrote the documentation set and archived the research record with provenance.

## Next, in order

**Blocked on the owner** — nothing downstream of these can be trusted:

1. **Compile everything** in MetaEditor; report the diagnostics.
2. Run `SymbolSpecDump` on the intended symbol and send the output.
3. Run `RunTests`; confirm `RESULT: PASSED`.
4. Name the instrument and broker so screening can stop using a proxy.

**Running automatically** — does not need the owner:

5. Expand the strategy families beyond the four tested (session structure,
   market structure, cross-asset conditioning, regime switching).
6. Raise trade counts: longer history, more instruments, lower timeframes.
7. Attack every candidate that survives, before believing it.

---

## Change log

| Date | Change |
|---|---|
| 2026-09-15 | Baseline audit; repository found empty |
| 2026-09-15 | MQL5 foundation: safety gate, spec cache, risk, order layer, session clock, signal boundary |
| 2026-09-15 | Filling-mode bug found and fixed against official docs |
| 2026-09-15 | `mql5lint`, 61 tests, CI, `make check` |
| 2026-09-15 | In-terminal assertion suite; scope-aware fix to MQL007 |
| 2026-09-15 | Documentation set and research archive |
| 2026-09-15 | First CI run on GitHub concluded success |
| 2026-09-16 | Self-review of the order and clock layers: three bugs found and fixed |
| 2026-09-16 | Self-review of the kill switches: silent-disable hole found and fixed |
| 2026-09-16 | Explicit signal cleanup on the OnInit failure path |
| 2026-09-16 | Two Routines created: 3-hourly engineering loop, weekly MT5/MQL5 research watch (`docs/AUTOMATION.md`) |
| 2026-09-20 | Strategy Research & Evolution system built: data layer, T0 engine, Experiment Ledger with Evidence Gate, tournament gates G1–G9 (`docs/RESEARCH.md`) |
| 2026-09-20 | First real experiments on 10y daily GC=F and EURUSD=X. **All four candidate families eliminated.** Null benchmarks showed the apparent gold edge was instrument drift |
| 2026-09-20 | Engine bug found by its own test: a position was immune to its entry bar's range. Fixed; impact on daily bars small but material on tighter stops |
| 2026-09-20 | Gate G7 bug found by reading its output: it computed a retention ratio against a near-zero denominator and manufactured passes. Hardened with three regression tests |
| 2026-09-21 | Lab expanded into four cells: Sentinel, Discovery, Red Team, Forensics (`docs/RESEARCH.md` §9) |
| 2026-09-21 | Anti-confirmation-bias made structural: mandatory H0 on surviving candidates; decision classifier physically cannot see outcomes |
| 2026-09-21 | **Red Team destroyed donchian_breakout**: 6/20 shuffled-return paths with no time structure matched or beat it (p≈0.30), and it does not transfer to EURUSD |
| 2026-09-21 | Third bug found by self-attack: the cross-instrument attack reused gold's cost model on EURUSD — a 44% spread — and reported a false destruction at -41.5R |
| 2026-09-21 | Routine diagnosis: runs SUCCEED and stage files but nothing reaches the branch. Cells now verify their own push landed |
| 2026-09-22 | **Five parallel branches discovered, 961 commits since August.** `docs/AUDIT.md`'s "repository is empty" was wrong; `docs/BRANCHES.md` is the correction |
| 2026-09-22 | Six audit defects fixed, each with a regression test verified to fail first (`tests/test_audit_fixes.py`) |
| 2026-09-22 | ~50 scheduled cell runs produced zero commits. Push path still unproven |
