# Keel — Product Definition

> A personal trading command center for one disciplined discretionary FX / gold trader.
> **Broker truth is the only truth. Risk is enforced, not suggested.**

Status: living document. Owner: the single user of this system.

---

## 1. How the product was chosen

The brief was deliberately open-ended: no feature list, no stack, no architecture.
So the first job was to work out *who this is actually for* and *what failure it should
prevent*, and only then to design.

### 1.1 Signals used

| Signal | Reading |
| --- | --- |
| Installed domain skills: `trading-pro`, `mql5-ea-engineering`, `xauusd-sessions`, `risk-position-sizing`, `backtest-validation`, `price-action-structure`, `strategy-design-review`, `trading-costs-execution` | The operator trades **FX and XAUUSD**, on **MetaTrader 5**, cares about **session structure**, **position sizing**, **execution cost realism** and **backtest honesty**. This is not a casual investor and not a crypto-native. |
| `risk-position-sizing` covers **prop-firm drawdown / consistency rules** | Funded-account rules are likely load-bearing. Breaching a drawdown rule is a *terminal* event — worse than a losing trade. |
| Brief's ordering: correctness → execution safety → broker truth → data integrity → risk → … → visual quality | The operator has been burned by, or fears, systems that *look* right and are wrong. |
| "Never invent or guess critical trading state" repeated three ways | Prior tools have shown stale or optimistic state. This is the deepest requirement in the brief. |

### 1.2 What the market gets wrong (2026)

Research into current retail platforms, broker apps and prop dashboards surfaced a
consistent set of weaknesses:

1. **Engagement-optimised, not survival-optimised.** Mass-market apps are built to
   maximise order flow. Watchlists, movers, streaks, and push loops all push toward
   *more* trades. A personal app has no such incentive and should push the other way.
2. **Optimistic state.** Most apps render "order placed" on HTTP 200 and reconcile
   later, silently. When the network drops mid-submit, the user genuinely does not know
   whether they are in the market. Industry reporting in 2026 attributes the majority of
   retail execution problems to the *interface*, not to misreading the market.
3. **Risk is a calculator, not a gate.** Position-size calculators are everywhere;
   systems that *refuse to send* an order that breaks a pre-committed rule are not.
   Risk lives in a separate tab from the button that costs money.
4. **The kill switch lives on the phone.** If risk enforcement is client-side, it dies
   when the app is backgrounded, the battery dies, or the trader is asleep.
5. **Journals are separate products.** Context (spread at entry, session, ATR, distance
   to news, HTF bias) has to be re-entered by hand, so it never gets entered, so reviews
   are anecdotes.
6. **AI is decoration.** LLM features in trading apps summarise news and hallucinate
   levels. Nothing is traceable to the user's own executions.
7. **Prop rules are unmodelled.** Firms moved to EOD-trailing drawdown, soft-breach
   auto-flatten, balance-vs-equity distinctions and consistency rules. Almost no trading
   *app* models the operator's actual funded-account constraints; the operator tracks
   them in their head or in a spreadsheet, under stress, in a drawdown.

### 1.3 The thesis

> Commercial trading apps optimise for the next trade.
> A personal trading app should optimise for **decision quality and survival**.
> Its job is to make the operator **fast everywhere except where being fast is expensive**,
> and to never, ever be confidently wrong about broker state.

Keel is therefore not "charts plus a buy button". It is:

- a **risk-governed execution surface**, and
- an **evidence system** for the operator's own behaviour.

---

## 2. Core purpose

Let one trader:

1. **See** market and account state fast, with the age and source of every number visible.
2. **Act** only through orders that pass rules they pre-committed to when calm.
3. **Never be wrong** about what the broker actually holds — including when the answer
   is honestly *"unknown, resolving"*.
4. **Survive** a bad day without the phone in hand: enforcement runs server-side.
5. **Learn** from every trade using evidence captured automatically, not recalled.

## 3. The five pillars

### P1 — Truth Ledger
Every order intent is durably written **before** it leaves the process. Broker state is
streamed and polled and continuously diffed against local projections. Divergence is a
first-class, alertable object — never a silent overwrite. Every position, order, balance
and price carries **source** and **age**. `UNKNOWN` is a real state that the UI renders
distinctly and that the system actively works to resolve.

### P2 — Risk Governor
A deterministic, explainable rule chain **in front of** execution, running on the desk
(server), so the phone cannot bypass it and it keeps working when the phone is off.
Rules: per-trade risk, daily loss limit, aggregate open risk, correlation-aware exposure,
instrument caps, session windows, news blackout, trade-count caps, loss-streak cooldown,
and a full **prop-firm drawdown model** (static / EOD-trailing / intraday-trailing,
balance- or equity-based, soft- or hard-breach). Every decision returns a reason chain
that the UI shows verbatim.

### P3 — One-Thumb Ticket
Risk-first order entry. The operator sets a **stop**, not a lot size; size is derived from
account currency, contract spec and risk policy. The confirm step restates, in money,
exactly what is being risked, and requires a deliberate gesture. Anti-fat-finger checks
run before the gesture, not after.

### P4 — Evidence Journal
Auto-captured at intent, fill and close: spread, ATR, session, minutes to next scheduled
high-impact event, R-multiple, MAE/MFE, latency and slippage. A **pre-trade note is
required before the order is sent** — the one deliberate piece of friction in the product,
because it is the highest-leverage discipline lever available.

### P5 — Grounded Copilot
An LLM with **read-only tools over the operator's own ledger and captured data**, and no
authority to state market facts it cannot cite. Every figure in an answer carries a
citation to a record id. It explains rejections, reviews trades, finds execution-quality
drift, and answers "what changed while I slept". It cannot place, modify or cancel orders.

## 4. Deliberate exclusions

Subscriptions, payments, ads, referrals, public sign-up, multi-tenancy, marketing
surfaces, social/copy trading, leaderboards, streaks and badges, a news feed to scroll,
"top movers", chat support, and enterprise admin. Also excluded on product grounds:
one-tap market orders without a stop, and any notification whose purpose is re-engagement
rather than a state change the operator asked to be told about.

## 5. Non-goals

- Not an HFT or latency-arbitrage system. Target is human-speed discretionary trading.
- Not a backtesting engine. It records live evidence; strategy validation stays in the
  operator's existing tooling.
- Not a strategy-signal generator. It will not tell the operator what to trade.
- Not multi-user. Single operator, single desk, by design.

## 6. Success criteria

1. After any crash, kill, network partition or broker disconnect, the system can state —
   with evidence — whether an order reached the broker, or explicitly that it is unknown
   and being resolved.
2. No sequence of client actions can produce a duplicate execution.
3. No UI surface can show a stale value as if it were live.
4. A pre-committed rule cannot be bypassed from the phone.
5. The daily-loss kill switch fires with the phone powered off.
6. Every AI claim about the operator's trading is traceable to a stored record.
