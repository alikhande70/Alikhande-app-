# ADR-0010 — AI: grounded, read-only, citation-bearing

**Status:** Accepted

## Context
An LLM that states a price, a level, or a P&L figure it did not read from a record is a
liability in a trading system. The brief is explicit: AI must not fabricate market facts
or critical trading state.

## Decision
1. The copilot has **no write authority.** It cannot place, modify, cancel or flatten. Its
   tools are read-only queries over the ledger, journal, captured market data and risk
   config.
2. Every tool result is stamped with record ids. The answer contract requires that
   **quantitative claims cite the ids** they came from.
3. A post-generation **citation validator** re-checks cited figures against the tool
   results in that turn. Uncited or non-matching numerics are stripped and the answer is
   returned with an explicit "unverified content removed" marker rather than silently.
4. The copilot is told, and structurally prevented from having, no live market feed beyond
   what the desk captured — so it cannot opine on "current" price without a quote record,
   and quotes carry their own staleness.
5. AI output is **never** an input to an automated action. No auto-trading, no auto-sizing.

## Rejected
- *Letting the model call an execution tool with a confirmation step.* The confirmation UI
  becomes a rubber stamp under time pressure. The value of AI here is analysis, and the
  downside of AI execution is unbounded.
- *RAG over general market news.* Would reintroduce exactly the unverifiable claims this
  ADR exists to prevent. If news matters, it enters as structured calendar data.

## Consequences
- The copilot is narrower than a general chatbot and will refuse some reasonable questions.
  That is the correct trade.
- Genuinely useful surface: rejection explanation, execution-quality drift, journal
  pattern-finding, session/regime breakdowns, "what changed while I slept" — all of which
  are questions *about the operator's own data*, which is exactly what it can answer well.
