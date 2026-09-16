# Architecture

## Working assumption

The repository contained no evidence of what the application is meant to do —
a 16-byte README and nothing else. The direction is inferred from the owner's
brief, which named an **MT5/MQL5 specialist** role, mandated continuous
MT5/MQL5 research, and forbade real-money execution:

> **Alikhande-app- is an automated trading system for MetaTrader 5, written in
> MQL5, developed and validated on demo accounts and in the Strategy Tester
> only.**

This is recorded as an assumption in one place so it can be corrected in one
place. See `docs/AUDIT.md` §3.

---

## Layout

The tree mirrors the MetaTrader 5 data folder, namespaced under `Alikhande/`
so it can be linked in beside the MetaQuotes standard library rather than
replacing it.

```
MQL5/
├── Experts/Alikhande/
│   └── AlikhandeEA.mq5          events and wiring only
├── Include/Alikhande/
│   ├── Logger.mqh               level-gated logging, silent under optimization
│   ├── SymbolSpec.mqh           broker specification cache + volume/stop math
│   ├── SafetyGate.mqh           the four-factor real-money refusal
│   ├── RiskManager.mqh          position sizing + persisted kill switches
│   ├── OrderExecutor.mqh        retcode policy, retries, position ownership
│   ├── SessionClock.mqh         server time, session windows, rollover
│   ├── Signal/
│   │   ├── ISignal.mqh          the strategy boundary
│   │   └── EmaCrossSignal.mqh   reference implementation, not an edge
│   └── Testing/Assert.mqh       in-terminal assertion harness
├── Scripts/Alikhande/
│   ├── SymbolSpecDump.mq5       run this first on any new broker
│   └── RunTests.mq5             the assertion suite
└── Files/Alikhande/             sandboxed runtime output

tools/mql5lint/                  the static linter
tests/                           pytest suite for the linter
docs/                            this documentation
docs/research/                   dated research records
```

**The EA file owns events and wiring only.** If `OnInit`, `OnTick` or
`OnTradeTransaction` stops fitting on one screen, the logic belongs in a
module.

---

## Data flow

```
OnInit
  SafetyGate.Evaluate  ──► INIT_FAILED on a real account, before anything else
  SymbolSpec.Load      ──► INIT_FAILED on unreadable numbers, not zeros
  RiskManager.Init     ──► restores persisted anchors, re-derives the halt state
  OrderExecutor.Init   ──► INIT_FAILED when no legal filling mode exists
  SessionClock.Init    ──► derives the broker's GMT offset at runtime
  Signal.Attach        ──► creates indicator handles once

OnTick
  RiskManager.Update       every tick: roll the day, track peak equity
  RiskManager.LimitBreached  every tick: a bar-gated limit can be breached mid-bar
  resync if a trade transaction arrived
  ── new bar? ──────────────────────────────────────────────── no ─► return
  ManageOpenPositions      assert every owned position has a stop
  SessionClock.CanOpen     weekend / rollover / session / Friday cutoff
  Signal.Evaluate          reads CLOSED bars, returns a stop DISTANCE
  RiskManager.CalcLots     spec-derived sizing, rounded DOWN
  ── alert-only? ──────── log and alert, send nothing ──────────────► return
  RiskManager.MarginAffordable
  OrderExecutor.OpenMarket retcode classification, bounded retries
```

---

## Decisions and their reasons

### The signal returns a distance, never a price

`SignalDecision` carries `sl_distance` as a price delta. Only the execution
layer knows the broker minimum distance, the current spread, and which side
the server validates against — so only it may turn a distance into a price.
A signal that computed prices would be duplicating broker knowledge it does
not have.

### Everything is points or price; there is no "pip"

On a 2-digit gold feed, "10 pips" means nothing unambiguous. `CSymbolSpec`
exposes `PointsToPrice` and `PriceToPoints` and deliberately offers no pip
abstraction.

### Stop distances include the spread

MT5 validates a buy's stop loss against **bid**, not against the ask it was
entered at. A stop placed at `ask - dist` is only `dist - spread` from the
level the server checks. Omitting the spread is the usual reason a tight stop
passes in the tester and returns retcode 10016 live.

`SYMBOL_TRADE_STOPS_LEVEL == 0` means **dynamic**, tied to current spread —
not "no limit". A spread-proportional floor replaces the zero.

### Retcodes are classified, not branched on

Five classes, because a boolean cannot express the dangerous one:

| Class | Policy |
|---|---|
| `RC_SUCCESS` | Done, placed, or partial — partial is logged loudly, since realised risk is now smaller than planned |
| `RC_RETRYABLE` | 10004, 10020, 10021, 10024, 10028, 10031 — each **guarantees** the order did not execute, which is what makes resending safe |
| `RC_AMBIGUOUS` | **10012 TIMEOUT only.** Cancelled locally; may still have reached the server and filled. Never resent — blind resend is the classic double-position bug |
| `RC_SPEC_ERROR` | 10013–10016, 10019, 10030, 10038 — our bug. Never retried; logged with the offending values |
| `RC_ENVIRONMENT` | Market closed, trading disabled, long/short only — adjust behaviour, do not retry |

Retries re-derive the stops from the **fresh** price. Resending stale stops
after a requote turns a transient 10004 into a permanent 10016.

### Filling mode is resolved from two properties, not one

Verified directly against the official docs:

- `SYMBOL_FILLING_MODE` carries only **FOK(1) / IOC(2) / BOC(4)**. The
  symbol-properties page states *"Return — No identifier"*, so the absence of
  a RETURN bit says nothing about whether RETURN is legal.
- RETURN's legality comes from `SYMBOL_TRADE_EXEMODE` instead: permitted under
  Request / Instant / Exchange, and *"disabled regardless of the symbol
  settings"* under **Market**.

So under Market execution only the advertised FOK/IOC bits are legal, and a
symbol advertising neither has **no legal filling mode** for a market order.
`ResolveFilling` returns false there and `OnInit` fails, rather than sending
an illegal mode on every tick — which presents as a strategy that never
trades, not as a configuration bug.

BOC is never selected: it is a passive Depth-of-Market policy, cancelled if it
could execute immediately, which is the opposite of a market entry.

Sources, read directly:
[order properties](https://www.mql5.com/en/docs/constants/tradingconstants/orderproperties) ·
[symbol properties](https://www.mql5.com/en/docs/constants/environment_state/marketinfoconstants)

### `OnTradeTransaction` is a doorbell, not a ledger

MetaQuotes documents these events as unordered, droppable (a 1024-entry queue
whose older entries can be superseded), and fan-out — *"you cannot rely on
'one request — one Trade event'"*. Any state machine assuming ordered,
complete delivery is wrong by construction.

The handler therefore records only that **something** happened. Authoritative
state is re-read from `PositionSelect` on the next tick.

*(This is from the research record and has not been independently re-read;
the design is conservative either way — treating the events as unreliable
costs nothing if they turn out to be reliable.)*

### Netting and hedging are different products

On a netting account a second buy **averages into** the open position instead
of opening another, so "max concurrent positions > 1" cannot mean what it
says. `OnInit` reads `ACCOUNT_MARGIN_MODE`, logs which model is in force, and
clamps the limit to 1 on non-hedging accounts rather than silently
misbehaving.

### Positions are filtered by symbol **and** magic

Magic alone breaks when the same EA runs on several charts. Symbol alone lets
the EA close a human's manual trade. Closing loops iterate **downwards**,
because the collection shrinks as positions close.

### State persists; EA memory does not

Day-start equity, peak equity and the day stamp live in terminal global
variables. A restart mid-drawdown must not re-anchor to the drawn-down equity.
The day stamp is `YYYYMMDD` rather than day-of-year, which repeats across
years.

In the Strategy Tester those anchors are **deleted at init**, so one
optimization pass cannot inherit a halt flag from the previous one and make
results depend on pass order.

### Logging silences itself during optimization

`Print` dominates runtime across thousands of optimization passes. `CLogger`
checks `MQL_OPTIMIZATION` at init and goes silent, so nobody has to remember.

---

## Language boundary

**MQL5 owns everything that runs inside the terminal at trade time. Python
owns tooling that reads output afterwards. Nothing crosses the boundary in the
live direction.**

No sockets, no pipes, no DLLs in the trade path. A DLL adds latency, adds a
failure mode where the EA holds a position and its sizer is unreachable,
requires a permission the user must grant, and breaks MQL5 Cloud Network
agents.

Python's current scope is the linter and its tests. Backtest report parsing,
walk-forward planning and Monte Carlo belong here too when there is a strategy
to validate.

---

## Deliberately not built yet

Listed so their absence is a decision rather than an oversight:

- **A trade journal.** Needs `FILE_COMMON`, or tester output scatters across
  per-agent folders. Worth doing when there are trades worth journalling.
- **Trailing stops / break-even.** `CSignalBase::ManageOpen` is the hook and
  defaults to "no change".
- **A strategy registry.** One signal exists; an enum-to-class map is
  premature.
- **A Windows CI runner.** Would add the compile layer. Needs a machine with
  MT5 and a logged-in demo account.
- **A real strategy.** See `docs/STATUS.md` → open questions.
