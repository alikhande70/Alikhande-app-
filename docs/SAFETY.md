# Safety

The project owner set one rule above all others:

> **This system must never trade a real-money account.**

A comment cannot enforce that. This document describes what does.

---

## 1. The four-factor gate

`MQL5/Include/Alikhande/SafetyGate.mqh` runs **first** in `OnInit`, before the
symbol spec is read and before any component is constructed. On a real account
it returns `INIT_FAILED`, so the EA never reaches `OnTick`. There is no guarded
path from a live account to an order — there is no path at all.

Escaping the gate requires **four independent facts** to line up. Any one
missing blocks startup:

| # | Factor | Where it lives | Why it is there |
|---|---|---|---|
| 1 | `ALIKHANDE_ALLOW_LIVE` must be `#define`d before the header is included | **source code** | Not defined anywhere in this repository. Requires editing source and recompiling — it cannot be reached from the terminal UI. |
| 2 | `InpAllowLive = true` | EA input | A deliberate runtime choice. |
| 3 | `InpLiveAck` must exactly equal the acknowledgement phrase | EA input | 40 characters. Cannot be typed by accident or left at a default. |
| 4 | `InpLivePinnedLogin` must equal the account's actual login | EA input | An override prepared for one account is inert on any other. A copied `.ex5` does nothing. |

Factors 1 and 4 are what make this **structural** rather than advisory:
factor 1 is unreachable from the UI, and factor 4 means the override does not
travel.

### Why there is no `#error` guard

A natural instinct is to write a compile-time assertion. **MQL5's documented
preprocessor does not include `#error`** — it lists `#define`, `#property`,
`#include`, `#import`, and `#ifdef` / `#ifndef` / `#else` / `#endif`. A guard
built on `#error` would compile to nothing and **fail open**, which is worse
than no guard because it looks like protection.

So the design uses only `#ifdef`, whose behaviour is documented, and pairs it
with a runtime refusal.

---

## 2. Alert-only is the default

`InpExecutionMode` defaults to `EXEC_ALERT_ONLY`. In that mode the EA
evaluates signals, computes the position size, logs exactly what it *would*
do, raises an alert — and sends nothing.

This matters beyond the live-account question: a strategy that has never been
watched in alert-only mode has never had its signal timing checked against a
chart by a human. Switching to `EXEC_TRADE` is a conscious act.

---

## 3. What the gate permits

| Environment | Verdict | Trading |
|---|---|---|
| Strategy Tester | `SAFETY_ALLOW_TESTER` | Permitted — simulated funds, checked **first**, so backtesting is never blocked |
| Demo account | `SAFETY_ALLOW_DEMO` | Permitted |
| Contest account | `SAFETY_ALLOW_CONTEST` | Permitted — no withdrawable money |
| Real account | `SAFETY_BLOCK_REAL` | **Blocked** |
| Trade mode unreadable | `SAFETY_BLOCK_UNKNOWN` | **Blocked — fails closed** |

The last row is deliberate. An unreadable `ACCOUNT_TRADE_MODE` is not a reason
to assume demo.

---

## 4. Enforcement outside the code

Two independent checks in `.github/workflows/ci.yml`:

1. **Linter rule MQL001** fails the build, at `CRITICAL`, if
   `#define ALIKHANDE_ALLOW_LIVE` appears anywhere in the tree.
2. **A separate `grep` step** re-asserts the same thing without the linter.

The duplication is intentional. The linter has a suppression mechanism; the
project's core safety property should not depend on a rule that can be
suppressed.

---

## 5. Risk limits, which are a different problem

The gate answers *may this account be traded at all*. Once trading is
permitted, `CRiskManager` bounds the damage:

- **Daily loss kill switch** — default 3% of the day's starting equity.
- **Total drawdown kill switch** — default 8% from peak equity.
- **Per-trade risk** — default 0.5% of equity, sized from broker spec.
- **Hard lot cap** — an absolute ceiling independent of the risk percentage.

Three properties are worth stating explicitly because each exists to defeat a
specific failure:

**They use equity, not balance.** An account can breach a daily limit on
floating loss without closing a single trade, and every prop firm measures it
that way.

**They run on every tick, before anything else.** A daily limit checked only
on new bars can be breached and stay breached for an entire bar.

**Their anchors persist.** The day's starting equity, the peak equity and the
day stamp live in terminal global variables, not in EA memory. Without that, a
restart mid-drawdown would re-anchor to the already-drawn-down equity and hand
the trader a fresh loss budget — precisely the failure the kill switch exists
to prevent. The day stamp is `YYYYMMDD`, not day-of-year, because
day-of-year repeats across years.

In the Strategy Tester those anchors are **deleted at init**, so one
optimization pass cannot inherit a halt flag from the last and produce results
that depend on pass order.

---

## 6. A position is never left without a stop

Under Instant execution some brokers reject stops attached to the entry
request. The executor detects that specific case (retcode 10016 +
`SYMBOL_TRADE_EXECUTION_INSTANT`) and retries as open-then-modify.

That leaves the position unprotected for a few hundred milliseconds. If the
protective modify does not succeed within the retry budget, **the position is
closed**. An unprotected position is never an acceptable steady state, and
both `ManageOpenPositions` and the post-transaction resync assert on it.

---

## 7. Known limits — what this does **not** protect against

Stated plainly, because a safety document that only lists strengths is
marketing:

- **It does not protect against a modified copy.** Anyone who can edit the
  source can remove the gate. It defends against accident, not against a
  determined operator.
- **It does not make the strategy profitable or safe to trade.** The gate is
  about *where* orders go, not whether they should exist.
- **It cannot prevent losses within the configured limits.** A 3% daily limit
  permits losing 3% a day.
- **Kill switches are evaluated on ticks.** On a symbol that stops ticking —
  a weekend gap, a halt — a limit can be exceeded before the EA sees a price.
- **`CSymbolSpec::LoadSynthetic` exists for tests.** It builds a spec from
  literals with no live Bid/Ask, so it cannot place a trade, but it is a
  non-production entry point and is documented as such.
- **None of this has been through a compiler.** See `docs/TESTING.md`.
