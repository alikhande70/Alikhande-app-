# Automation

The lab runs as **four independent work cells** plus a weekly documentation
watch. Each firing starts a **fresh session** with no memory of the last, so
everything a run needs lives in the repository — `CLAUDE.md` for the rules,
`docs/RESEARCH.md` for the design, and the Research Queue for the work.

| Cell | Schedule (UTC) | Does | Never |
|---|---|---|---|
| **1 — Research Sentinel** | hourly | Scans for integrity defects; curates the Research Queue | Runs experiments |
| **2 — Strategy Discovery Lab** | every 2h | One complete hypothesis cycle, start to verdict | Validates its own output |
| **3 — Red Team** | every 3h | Attacks the strongest survivor, trying to prove it false | Invents strategies |
| **4 — Trade Forensics Lab** | every 4h | Judges real trades; decisions separately from outcomes | Lets the P/L grade the decision |
| MT5/MQL5 research watch | Mondays 06:00 | Official MetaQuotes docs for changes affecting the code | — |

Manage them at [claude.ai](https://claude.ai) under Routines.

**The separation is the design.** Cell 2 builds and Cell 3 destroys, and they
are different cells on purpose — not because anyone would cheat, but because
whoever built something already knows which answer would be pleasant, and that
is enough to bend a judgement. Cell 3 is scored on whether it succeeds in
destroying, not on whether the lab has a working strategy.

## The Research Queue

Six named queues, so "this one is blocked, move to another" is a mechanical
decision rather than one re-derived by every cold session:

`NEW_HYPOTHESIS` · `RETEST` · `RED_TEAM` · `DATA_QUALITY` · `ENGINE_AUDIT` ·
`TRADE_FORENSICS`

Ranked by expected information gain. At equal priority `ENGINE_AUDIT` and
`DATA_QUALITY` sort first: an experiment run on a broken engine gives a
confident *wrong* answer. Items that need the owner are marked blocked, sort
last, and are never dropped.

```bash
python3 research/run_lab.py queue        # what to work on, most informative first
python3 research/run_lab.py sentinel     # scan and refill the queue
```

## A known problem, stated plainly

Scheduled runs on 2026-09-20 and 2026-09-21 completed successfully, did work,
and **staged files that never reached the branch**. The session record shows
`staged_files: true` and a REVIEW_READY state with zero commits on the remote.
The cause is not yet established from outside those sessions.

Every cell prompt therefore ends with a push **verification** step: commit with
`--no-gpg-sign`, push, then `git fetch` and compare `origin/<branch>` against
local HEAD. A run whose push did not land must report that first, as its
primary finding, rather than describing its work as done. That converts a
silent failure into a visible one, which is the correct response to a fault
that cannot yet be reproduced.

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
