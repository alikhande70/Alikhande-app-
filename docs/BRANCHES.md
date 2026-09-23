# Branch survey — 2026-09-22

Written because this branch was built without knowing the others existed. That
is the most important thing in this document.

## What is actually in the repository

| Branch | Commits | Files | Active | Stack |
|---|---|---|---|---|
| `gpt/trading-brain-build` | **577** | **334** | 24–29 Aug | TypeScript / pnpm monorepo |
| `claude/integration-mt5-foundation` | 148 | 194 | 24–26 Aug | same monorepo |
| `claude/audit-2026-08` | 143 | 191 | 24–26 Aug | same monorepo |
| `claude/mt5-execution-hardening` | 76 | 176 | 24–26 Aug | same monorepo |
| `claude/personal-trading-app-atm6e1` | 17 | 148 | 24–26 Aug | same monorepo |
| `claude/alikhande-app-team-audit-mmoz9k` (this one) | 14 | ~45 | 15–22 Sep | Python + MQL5 |

Every branch roots at `4e5680f`, the empty initial commit. They share no other
history. `main` is still that empty commit.

## The correction this document exists for

`docs/AUDIT.md`, written 2026-09-15, reported the repository as empty and the
project as greenfield. **That was wrong.** Five branches carrying 961 commits
had existed since August.

The container's clone genuinely showed only `main` and this branch — the audit
reported what it could see. The error was method: it trusted the local ref list
instead of asking the remote (`git ls-remote`). An audit that cannot see most
of its subject should establish that before reporting.

`docs/AUDIT.md` is a point-in-time snapshot and is deliberately not rewritten.
This document is the correction.

## Which part is authoritative

**`gpt/trading-brain-build` is the reference for research integrity.** Not a
judgement about quality — a statement about what exists, read from the branch:

`packages/brain/src/` contains `registered-hypotheses.ts`,
`pre-registered-evaluation.ts`, `locked-holdout-evaluation.ts`,
`leakage-window-guard.ts`, `feature-strata-guard.ts`, `dependence-guard.ts`,
`paired-inference.ts`, `evaluation-pipeline.ts`, and a `version-registry.ts`,
each with a test file beside it.

Two capabilities there are strictly stronger than anything on this branch:

- **Benjamini–Hochberg FDR control over a pre-registered hypothesis family**
  (`BUILD-REPORT-2026-08-29-REGISTERED-HYPOTHESES-FDR.md`, citing Benjamini &
  Hochberg 1995). This branch only *warns in prose* that some bucket differs by
  chance. That branch corrects for it.
- **A SHA-256 sealed one-shot locked holdout with access receipts**, where
  "a challenger can be observed on the sealed holdout, but no result from this
  boundary can mutate champion/challenger registry state". This branch enforces
  looking-at-OOS-once by convention. That branch enforces it with a seal.

So the Python research lab on this branch re-derived a **weaker** version of a
system that already existed, three weeks later, in a different language.

## What this branch has that the survey did not find elsewhere

Stated narrowly, as what was checked rather than what is claimed:

- `MQL5/Include/Alikhande/SafetyGate.mqh` — the four-factor real-money refusal.
  The other branches carry `mt5/Keel*.mq5`, a different EA; no equivalent
  four-factor gate was found, but their MQL5 was not read in full.
- `tools/mql5lint` — a static linter for the MQL5 pitfall catalogue.
- The null-benchmark gate (long-only + random entry with matched exits). Not
  found by filename elsewhere; **not verified absent** — `outcome-labeling.ts`
  and `paired-inference.ts` were not read.

## The systemic problem, already documented in August

`claude/audit-2026-08` at `967139b` says it plainly:

> "all four defects reported in my previous session — three severe — were still
> present here. Those fixes lived on `claude/mt5-execution-hardening` and were
> never merged. **Parallel branches are silently losing safety work**, which is
> worth more attention than any single defect below."

That was written on 26 August about two branches. It now describes six. This
branch is the newest instance of the same failure, one layer up: a whole
research stack rebuilt in isolation.

## How to use this without a rushed merge

A merge is not attempted here, and should not be. The two stacks share no
history, no language and no build system; `git merge` would produce a tree
where neither half runs.

The sequence that does not lose work:

1. **Decide the main line.** On evidence, it is the TypeScript monorepo. That
   is the owner's call, not this branch's.
2. **Port the two capabilities that are genuinely missing there**, if the
   survey above holds after a proper read: the four-factor safety gate and the
   MQL5 linter. Port, do not copy the branch.
3. **Retire the research lab on this branch** rather than growing it further,
   once `packages/brain` is confirmed to cover it. Its ledger (8 eliminated
   candidates, the null-benchmark finding, three engine bugs) is a record worth
   migrating; the code is a weaker duplicate.
4. **Stop creating branches from `4e5680f`.** That is what produced six
   unrelated histories.

Until step 1 has an answer, work on this branch should be limited to defects
and to things the survey shows are not duplicated.
