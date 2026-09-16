# Alikhande-app-

An automated trading system for **MetaTrader 5**, written in **MQL5**.

> ## Demo and Strategy Tester only
> This system will not start on a real-money account. The refusal is
> structural, not advisory — see [`docs/SAFETY.md`](docs/SAFETY.md).
>
> Out of the box the EA runs in **alert-only** mode: it evaluates, sizes and
> logs signals, and sends nothing.

---

## Status

**Foundation complete, unverified.** The MQL5 sources have **never been
compiled** — MetaEditor is Windows-only and this was built on Linux. No claim
is made that they build. That is the immediate next step, and it belongs to
the owner.

Live detail: [`docs/STATUS.md`](docs/STATUS.md).

---

## What this is

A strategy-agnostic MQL5 foundation — the plumbing that trading code usually
gets wrong, built once and tested where it can be:

- **A four-factor refusal to trade real money**, defeatable only by editing
  source, recompiling, typing an exact phrase, and pinning an account number.
- **A broker-specification cache.** Nothing about an instrument is hardcoded.
  `XAUUSD` is 2 digits on some brokers and 3 on others; contract size is 100 oz
  on most and 10 oz on some.
- **An order layer that classifies retcodes before acting on them** — including
  a dedicated class for `10012 TIMEOUT`, which may or may not have filled and is
  therefore never resent.
- **Risk sizing derived entirely from broker spec**, rounded *down* to the
  volume step, with daily-loss and total-drawdown kill switches whose anchors
  survive a restart.
- **A strategy boundary** that returns a stop *distance*, leaving prices to the
  layer that knows the broker's constraints.
- **A static linter** encoding the MQL5 bug catalogue, with 61 tests of its own,
  running in CI.

What it is **not**: a trading edge. The bundled EMA cross is a reference
implementation of the signal contract with no validated expectancy, and it says
so in its own header.

---

## Quick start

```bash
git clone https://github.com/alikhande70/Alikhande-app-
cd Alikhande-app-
make install-dev
make check          # linter + tests (does NOT prove the MQL5 compiles)
```

Then, on Windows with MetaTrader 5 — see
[`docs/INSTALL.md`](docs/INSTALL.md):

1. Link the three `MQL5/*/Alikhande` folders into your MT5 data folder.
2. Compile, and **report every error and warning**.
3. Run `SymbolSpecDump` on your symbol; check the numbers.
4. Run `RunTests`; confirm `RESULT: PASSED`.
5. Attach the EA in alert-only mode on a **demo** account.

---

## Documentation

| Document | What it covers |
|---|---|
| [`docs/STATUS.md`](docs/STATUS.md) | Current state, open risks, what happens next |
| [`docs/SAFETY.md`](docs/SAFETY.md) | The real-money refusal, risk limits, and the known limits of both |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layout, data flow, and why each decision was made |
| [`docs/TESTING.md`](docs/TESTING.md) | What each test layer proves — and what it does not |
| [`docs/INSTALL.md`](docs/INSTALL.md) | Getting from clone to a running EA |
| [`docs/AUDIT.md`](docs/AUDIT.md) | The baseline audit (point-in-time, not updated) |
| [`docs/research/`](docs/research/) | Dated research records, with provenance headers |

---

## Layout

```
MQL5/Experts/Alikhande/     the EA: events and wiring only
MQL5/Include/Alikhande/     the library: spec, safety, risk, orders, session, signals
MQL5/Scripts/Alikhande/     SymbolSpecDump (broker diagnostics), RunTests (assertions)
tools/mql5lint/             the static linter
tests/                      pytest suite for the linter
docs/                       documentation
```

---

## Contributing

`make check` must pass. It runs exactly what CI runs.

Two rules that are not negotiable:

1. **`ALIKHANDE_ALLOW_LIVE` must never be defined in this repository.** CI fails
   the build if it is, twice over — once via linter rule MQL001 and once via an
   independent `grep`.
2. **Do not claim MQL5 code is verified unless it has been through MetaEditor.**
   Say what was checked and what was not.
