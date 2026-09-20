# Automation

Two **Routines** (scheduled triggers) run this project without a human in the
loop. Each firing starts a **fresh session** with no memory of the last one, so
everything a run needs to know lives in the repository — `CLAUDE.md` for the
rules, `docs/STATUS.md` for the state.

| Routine | Schedule (UTC) | Fires | Notifications |
|---|---|---|---|
| **Alikhande: strategy research & evolution cycle** | every 3 hours, at :30 | fresh session | push |
| **Alikhande: MT5/MQL5 research watch** | Mondays 06:00 | fresh session | push + email |

Manage them at [claude.ai](https://claude.ai) under Routines, or ask Claude to
list, pause or reschedule them.

---

## Strategy research & evolution cycle

Runs one iteration of the cycle in `docs/RESEARCH.md`: hypothesise, implement,
screen, attack, eliminate, record. Priority order: a failing `make check`; a
**new strategy family**; raising trade counts so eliminations stop being "too
few trades"; attacking anything that survived; improving the measurement
itself; adversarial review of an MQL5 module.

**This Routine was rewritten on 2026-09-20, and why matters.** Its previous
version produced zero commits across four days. That was not a malfunction —
its stop condition said to stop rather than invent work, the project genuinely
had nothing that did not need the owner, and the runs correctly concluded so.
The fix was not a looser stop condition; it was giving the cycle real work.
The research space is large enough that stopping should now be rare.

Eliminating candidates is the successful outcome. A run that kills two ideas
has produced more than one that adds a third unvalidated one.

## Research watch

Checks the official MetaQuotes release notes and MQL5 documentation for changes
affecting this codebase: the order-sending layer, the `SYMBOL_*` properties the
project reads, `OnTradeTransaction`, account properties, the Strategy Tester,
and MQL5 *language* changes. Verified findings that contradict the code are
fixed, with a regression assertion naming the wrong behaviour. Unverifiable
ones become open risks instead of code changes.

Weekly, because MetaTrader builds ship every few weeks, not daily.

---

## Rules every run inherits

Restated here because a fresh session reads the repository, not this
conversation:

1. **Never define `ALIKHANDE_ALLOW_LIVE`.** CI fails the build if it appears.
2. **Never claim MQL5 code is verified without MetaEditor.** It cannot be
   compiled in this environment. "It lints" is not "it compiles".
3. **Never guess a broker value.** It comes from `CSymbolSpec`.
4. **Never state an MQL5 API fact you have not read** on
   `www.mql5.com/en/docs`. Unconfirmed means UNVERIFIED, in writing.
5. **Never open a pull request** unless asked.
6. **Stopping is allowed.** A run that reports "nothing useful to do without
   the owner" is a successful run. Inventing work, churning documentation, or
   making cosmetic commits to look busy is a failed one.

---

## Known limits

- **No MCP connectors.** Routine-fired sessions run without connector tools,
  including the GitHub API. Plain `git` works for fetch, commit and push, which
  is all the workflow needs; CI status cannot be queried, so runs rely on
  `make check` — the same gate CI runs. To grant connectors, create the Routine
  from the claude.ai Routines UI instead.
- **Concurrency.** Both Routines push to
  `claude/alikhande-app-team-audit-mmoz9k`. Each run rebases onto the remote
  before starting. Their schedules rarely coincide, but a rebase conflict is
  possible and a run is expected to resolve it rather than force-push.
- **A hard ceiling, in a different place now.** The research cycle has plenty
  to do without the owner, but it cannot finish: gate G9 needs the MetaTrader 5
  Strategy Tester on the real instrument, and the Evidence Gate refuses to
  record a champion without it. Screening also runs on PROXY instruments —
  `GC=F` is COMEX gold futures, not spot XAUUSD — so even a survivor is a lead,
  not a finding.
- **Rate limits.** Session limits are real and were hit during development.
  Three hours between runs is a deliberate trade-off, not a maximum: tighter
  spacing burns limits and produces churn on a project with the ceiling above.
