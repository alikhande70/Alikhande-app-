# Project status

**Single source of truth for where Alikhande-app- stands.**
Updated with every change. `docs/AUDIT.md` is a point-in-time snapshot and is
deliberately *not* updated.

**Last updated:** 2026-09-15
**Branch:** `claude/alikhande-app-team-audit-mmoz9k`
**Phase:** foundation complete, unverified — awaiting first compile

---

## One-paragraph summary

The repository was empty at the start of this session (one 16-byte README, one
commit). It now holds a strategy-agnostic MQL5 foundation: a structural refusal
to trade real money, a broker-spec-driven sizing and order layer with explicit
retcode policy, persisted kill switches, a strategy boundary with one reference
implementation, an in-terminal assertion suite, a CI-runnable static linter with
61 tests of its own, and documentation. **None of the MQL5 has been compiled** —
that is the single largest open risk and the immediate next step.

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
| `mql5lint` + 61 tests | **Working** | `make check` passes; runs in CI |
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

1. **Compile everything** in MetaEditor; fix whatever the compiler reports.
   *(Owner action — blocks everything else.)*
2. Run `SymbolSpecDump` on the intended symbol and send the output.
3. Run `RunTests` and confirm `RESULT: PASSED`.
4. Run the EA in alert-only mode on a demo chart and sanity-check the signals.
5. Specify a real strategy, then replace the reference signal.
6. Only then: Strategy Tester, and the validation protocol in
   `docs/TESTING.md` §5.

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
