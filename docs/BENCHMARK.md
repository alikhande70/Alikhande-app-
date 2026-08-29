# Competitive benchmark and scoring

A personal system does not have to beat commercial platforms everywhere. It has to
beat them where it matters to one operator, and it should admit where it never will.

## The scoring framework

Weights follow the priority order set for this project: correctness first, visual
quality last. They are not equal, because the platforms differ most in the places that
matter least, and are most alike in the places that matter most.

| # | Dimension | Weight | What a 10 looks like |
| --- | --- | --- | --- |
| 1 | Execution correctness & safety | 15 | Duplicate execution is structurally impossible; every ambiguous outcome is represented as ambiguous |
| 2 | Broker truth & reconciliation | 12 | The UI can never disagree with the venue for long, and says so while it might |
| 3 | Risk control & enforcement | 12 | Pre-committed limits are enforced by something that cannot be talked out of it, with the operator absent |
| 4 | Recoverability & failure handling | 10 | Any crash, restart or partition converges back to venue truth without human archaeology |
| 5 | Data integrity & auditability | 8 | Every state has a provable derivation; tampering is detectable |
| 6 | Charting | 8 | Fast, precise, multi-timeframe, good drawing tools on both devices |
| 7 | Analytics & journal | 8 | Decisions are reconstructable; statistics are honest about sample size |
| 8 | Mobile UX | 8 | Complete situational awareness and safe action in thirty seconds, one thumb |
| 9 | Desktop UX | 8 | Multi-chart, multi-monitor, keyboard-first investigation |
| 10 | Alerting & awareness | 5 | The operator learns about what matters, while it still matters |
| 11 | AI assistance | 3 | Grounded, traceable, never inventing state |
| 12 | Automation & extensibility | 3 | Strategies can be expressed and tested |

Scores are 0–10 per dimension, weighted to a 0–100 total.

## Scores

| Dimension (weight) | MT5 | cTrader | TradingView | TradeLocker | Quantower | Journals¹ | **Keel now** | **Keel target** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Execution correctness (15) | 8 | 8 | 4 | 6 | 8 | 0 | **3** | **9** |
| Broker truth (12) | 6 | 7 | 3 | 5 | 7 | 2 | **4** | **9** |
| Risk enforcement (12) | 2 | 4 | 2 | 4 | 5 | 2 | **6** | **10** |
| Recoverability (10) | 4 | 5 | 3 | 4 | 5 | 2 | **6** | **9** |
| Data integrity (8) | 5 | 6 | 4 | 4 | 6 | 6 | **8** | **10** |
| Charting (8) | 5 | 7 | 10 | 8 | 8 | 4 | **1** | **7** |
| Analytics & journal (8) | 3 | 5 | 6 | 4 | 6 | 10 | **3** | **8** |
| Mobile UX (8) | 4 | 7 | 9 | 9 | 2 | 7 | **2** | **8** |
| Desktop UX (8) | 6 | 8 | 8 | 6 | 9 | 7 | **0** | **8** |
| Alerting (5) | 3 | 5 | 7 | 5 | 5 | 4 | **3** | **8** |
| AI (3) | 0 | 1 | 4 | 2 | 1 | 8 | **0** | **6** |
| Automation (3) | 9 | 7 | 8 | 5 | 7 | 3 | **1** | **4** |
| **Total** | **48** | **62** | **52** | **53** | **61** | **39** | **36** | **85** |

¹ TradeZella / TraderSync / Edgewonk class — journal and analytics products with no
execution capability.

**Keel now** scores only components that exist and have been tested. Anything designed
but unbuilt scores what it currently delivers, which is nothing.

## Reading the table honestly

**We currently score last.** 36 is below every commercial platform including the
journal products. That is the correct result: almost everything a user touches is
either unbuilt (desktop, charts, AI), unverified (mobile has never rendered on a
device), or unconnected to a real venue. A system that cannot yet place a real order
does not get credit for placing it safely.

**The target score is high because the weights favour what we build and they don't.**
Every commercial platform serves many users, which makes them structurally unable to
be opinionated about risk. MT5 has no daily loss limit. cTrader has no pre-trade risk
governor that refuses. None of them has a kill switch that fires while the operator
sleeps with the phone off. That is not incompetence — it is the cost of serving
everyone. A single-user system can pre-commit to rules and then genuinely enforce
them, and that is where the 12-point risk dimension is won.

## What each competitor does exceptionally well

**MetaTrader 5** — MQL5 and the Strategy Tester. Genuinely excellent, deeply
integrated, and something we should not attempt to replace. It is also the venue, so
its execution semantics are definitionally correct even where they are inconvenient.
*Outdated:* the UI, the reporting, and the complete absence of risk enforcement.

**cTrader** — the best-balanced of the retail platforms. Clean execution, good depth
of market, competent mobile, cTrader Automate is pleasant. *Outdated:* nothing badly,
but nothing exceptional either; risk tooling is thin.

**TradingView** — charting is the best in the world and it is not close. Cross-device
sync is exemplary; the mobile app is the benchmark for how much can be done well on a
phone. *Fails to integrate:* execution is a thin broker-dependent layer bolted to an
analysis product, and there is no meaningful account-truth layer.

**TradeLocker** — proves that a modern web stack with TradingView charts embedded
produces a better mobile experience than MT5 by a wide margin. *Fails:* thin
analytics, and the account model is shallow.

**Quantower** — the best desktop workspace here: order flow, DOM, multi-broker in one
layout. *Fails:* mobile is effectively absent, which for this operator is
disqualifying on its own.

**Journals (TradeZella et al.)** — the best analytics and the only credible AI
integration in the group; Zella-style automatic trade tagging and session review is
genuinely good. *Fails to integrate:* completely disconnected from execution. They
import your history after the fact and cannot prevent a single bad trade.

## Where a single-user system can be better

1. **Enforce risk instead of displaying it.** Nobody in the table refuses an order
   because the operator already lost their daily limit. We can, server-side, with
   reason chains.
2. **Represent uncertainty.** Every platform shows a position or does not. None
   distinguishes "confirmed by the venue" from "we believe this but have not
   confirmed it since 14:02".
3. **Prove state.** A hash-chained ledger where every projection is a pure function
   of an append-only log is not something a commercial platform will build, and it
   makes "why does it think I'm long?" answerable.
4. **Unify execution, journal and analytics.** The journals are disconnected from
   execution and the terminals are disconnected from analytics. One system that
   captures the decision *at the moment of the order* — the reasoning, the chart, the
   risk verdict — produces a journal nobody can reconstruct after the fact.
5. **One truth across two devices.** Same rules, same numbers, same certainty
   annotations, phone and desktop, because it is literally the same code.

## Where we are inferior and likely to stay

Stated plainly, because pretending otherwise would make the rest of this document
worth less:

- **Charting will not beat TradingView.** It is a decade of specialised work. Target
  7/10: fast, precise, correct — not a superset.
- **Automation will not beat MQL5.** We should not try. MT5 is already running on the
  execution host with the best backtesting engine in retail trading. The right move
  is to *use* it, not to reimplement it.
- **Order flow and DOM tooling will not beat Quantower**, and for a swing/intraday FX
  and gold operator it does not need to.
- **Multi-broker breadth is not a goal.** One account, served exceptionally.
- **Ecosystem, community and third-party indicators are worth zero here** and are a
  real advantage of the commercial platforms that we are deliberately forgoing.

## The honest summary

The design targets 85 and delivers 36. The gap is entirely execution-of-plan rather
than plan quality, and the two largest single contributors are that no order has ever
reached a real venue and that the desktop client does not exist.

The nearest competitor at 62 is beaten only if the truth, risk and recovery layers are
actually finished *and verified against LiteFinance* — because they are the only
dimensions where we are structurally advantaged, and they are worth 49 of the 100
points.
