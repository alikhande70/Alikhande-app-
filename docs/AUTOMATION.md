# Automation

Two **Routines** (scheduled triggers) run this project without a human in the
loop. Each firing starts a **fresh session** with no memory of the last one, so
everything a run needs to know lives in the repository — `CLAUDE.md` for the
rules, `docs/STATUS.md` for the state.

| Routine | Schedule (UTC) | Fires | Notifications |
|---|---|---|---|
| **Alikhande: engineering loop** | every 3 hours, at :30 | fresh session | push |
| **Alikhande: MT5/MQL5 research watch** | Mondays 06:00 | fresh session | push + email |

Manage them at [claude.ai](https://claude.ai) under Routines, or ask Claude to
list, pause or reschedule them.

---

## Engineering loop

Picks the highest-value available work and finishes one coherent piece of it.
Priority order: a failing `make check`; an open risk in `docs/STATUS.md` that
can be closed without the owner; **adversarial self-review of a module**; a new
linter rule; new assertions; Python tooling.

Self-review is ranked high deliberately — it is what found every bug in this
project so far, including a kill switch that silently stopped existing and a
stop loss placed at twice the market price. Runs rotate through modules using
the change log in `docs/STATUS.md` rather than re-reading the same file.

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
- **A hard ceiling.** Two things cannot be done without the owner: compiling
  the MQL5 (MetaEditor is Windows-only) and specifying the trading strategy.
  Until those land, runs work on tooling, review and tests — genuinely useful,
  but not a substitute. Expect some runs to correctly report that they stopped.
- **Rate limits.** Session limits are real and were hit during development.
  Three hours between runs is a deliberate trade-off, not a maximum: tighter
  spacing burns limits and produces churn on a project with the ceiling above.
