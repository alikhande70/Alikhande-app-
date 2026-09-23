# Alikhande-app- — Baseline Audit

**Audit date:** 2026-09-15
**Auditor:** Claude Code engineering team (Lead Architect / Developer / MT5-MQL5 Specialist / Research / QA / Security)
**Commit audited:** `4e5680f` — "Initial commit" (author `alikhande70`, 2026-08-25)
**Branch:** `claude/alikhande-app-team-audit-mmoz9k`

---

## 1. Verified baseline

Every statement below was verified directly against the working tree and git history.
Nothing in this section is inferred.

| Check | Command | Result |
|---|---|---|
| Tracked files | `git ls-files` | **1** file: `README.md` |
| Files on disk (excl. `.git`) | `find . -path ./.git -prune -o -type f -print \| wc -l` | **1** |
| `README.md` size | `wc -c README.md` | **16 bytes** — content is the single line `# Alikhande-app-` |
| Commit count | `git log --oneline` | **1** (`4e5680f`) |
| Branches | `git branch -a` | `main`, `claude/alikhande-app-team-audit-mmoz9k` (+ their remotes) |
| Divergence | `git log main..HEAD` | none at audit time |
| Remote | `git remote -v` | `https://github.com/alikhande70/Alikhande-app-` |

### Conclusion

**There is no existing codebase.** This project is greenfield.

A code audit in the usual sense — finding bugs, smells, dead code, insecure
patterns in shipped software — has **no subject matter here**. Reporting such
findings would mean inventing them. The honest finding is the absence itself,
and it is the most consequential fact about the project.

---

## 2. Findings

Findings are stated as *absences*, because that is what the evidence supports.
Severity reflects the cost of leaving the gap open once code starts landing.

| # | Severity | Finding | Consequence if unaddressed |
|---|---|---|---|
| A-01 | **Critical** | No safety mechanism of any kind exists, while the project's stated domain is automated trading. | Any EA added later can reach a live account by accident. The owner's "no real money" rule is currently enforced by nothing but intent. |
| A-02 | **High** | No project structure. | MT5 loads code from a fixed data-folder layout; a repo that ignores it forces manual copying and makes the install step unreproducible. |
| A-03 | **High** | No tests, and no answer to *how* MQL5 would be tested. | MQL5 has no mainstream unit-test framework; without a deliberate strategy, "tested" silently degrades to "it compiled". |
| A-04 | **High** | No CI. | Nothing prevents a regression from being merged. |
| A-05 | **Medium** | No `.gitignore`. | Compiled `*.ex5`, tester output and — worse — broker credentials or account `.ini` files can be committed. |
| A-06 | **Medium** | No documentation beyond a one-line title. | Project intent, strategy rules and risk limits exist only in the owner's head; they are not reviewable or falsifiable. |
| A-07 | **Medium** | No specification of the trading strategy, instrument, or timeframe. | Code cannot be validated against an intent that has not been written down. |
| A-08 | **Low** | No license, no contribution rules, no issue/PR templates. | Not urgent for a private project; matters if it is ever shared. |

### Explicitly **not** claimed

To keep this report falsifiable, these are things the audit did **not** find and does **not** assert:

- No security vulnerabilities were found — because there is no code in which to find any.
- No performance issues, no dependency risks, no supply-chain exposure — same reason.
- No statement is made about the owner's intended strategy; none is recorded in the repo.

---

## 3. Domain inference — stated as an assumption, not a fact

The repository itself contains **zero** evidence of what the application is meant to do.
The project direction was inferred from the owner's brief, which explicitly requested an
**MT5/MQL5 Specialist** team role and mandated continuous research into **MT5/MQL5**
platform changes, together with the hard rule that **real-money execution is forbidden**.

> **Working assumption:** Alikhande-app- is an automated trading system for
> **MetaTrader 5**, written in **MQL5**, to be developed and validated on
> demo accounts and in the Strategy Tester only.

This assumption drives every architectural decision in `docs/ARCHITECTURE.md`.
It is recorded here so it can be corrected in one place if wrong.

**Open question deferred to the owner** (does not block foundation work):
the concrete strategy — instrument(s), timeframe, entry/exit logic, risk budget.
The foundation being built is strategy-agnostic precisely so this answer can arrive later
without rework. See `docs/STATUS.md` → "Open questions".

---

## 4. Environment constraints discovered during audit

These shape what "tested" can honestly mean in this project.

| Constraint | Evidence | Impact |
|---|---|---|
| **MQL5 cannot be compiled in this environment** | No MetaEditor; MetaTrader 5 is a Windows application. | CI can never prove `.mq5` code compiles. Any claim of "verified" MQL5 must come from the owner running MetaEditor. |
| **Strategy Tester cannot be run here** | Requires a MetaTrader 5 terminal and broker tick history. | Backtest results cannot be produced by this team; only the protocol and the analysis tooling can. |
| **Python 3.11.15 and pytest are available** | `python3 --version`, `which pytest` | Static analysis and tooling **can** be genuinely tested in CI. This is the only layer where "green" means something automatic. |

The testing strategy in `docs/TESTING.md` is built around these limits rather than
pretending they do not exist.

---

## 5. Remediation plan

| Finding | Addressed by | Status |
|---|---|---|
| A-01 | `MQL5/Include/Alikhande/SafetyGate.mqh` + `docs/SAFETY.md` | see `docs/STATUS.md` |
| A-02 | `MQL5/` tree mirroring the MT5 data folder + `tools/install_to_mt5.py` | see `docs/STATUS.md` |
| A-03 | Two-layer strategy: CI static linter + in-terminal MQL5 assertions (`docs/TESTING.md`) | see `docs/STATUS.md` |
| A-04 | `.github/workflows/ci.yml` | see `docs/STATUS.md` |
| A-05 | `.gitignore` (includes an explicit secrets block) | **done** |
| A-06 | `docs/` set | see `docs/STATUS.md` |
| A-07 | Owner input required; foundation kept strategy-agnostic | **open** |
| A-08 | Deferred — low value while the repo is private | **deferred** |

Live remediation status is tracked in `docs/STATUS.md`, which is the single
source of truth for project state. This audit is a point-in-time snapshot and
is not updated as work lands.
