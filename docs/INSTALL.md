# Installation

## What you need

- **Windows** — MetaTrader 5 and MetaEditor are Windows applications. MetaQuotes
  ships an official Linux install script that runs the platform under Wine, but
  there is no native Linux build, and the headless compile workflow under Wine
  is community practice rather than documented behaviour. If you use it, verify
  every step yourself.
- **MetaTrader 5**, logged into a **demo account**. The EA refuses to start on a
  real account — see `docs/SAFETY.md`.
- **Python 3.11+** only if you want to run the linter and its tests locally.

---

## 1. Find the MT5 data folder

In MetaTrader: **File → Open Data Folder**. It opens something like

```
C:\Users\<you>\AppData\Roaming\MetaQuotes\Terminal\<32-hex-id>\
```

Do not guess this path — the hex id is per-installation. Everything below goes
under its `MQL5\` subdirectory.

---

## 2. Link the repository in

Clone anywhere you like, then link the three namespace folders into the data
folder. **Link rather than copy**: with a copy, the file you edit is not the
file that compiles, and that costs an afternoon the first time it bites.

From an **Administrator** Command Prompt:

```bat
set REPO=C:\path\to\Alikhande-app-
set DATA=C:\Users\<you>\AppData\Roaming\MetaQuotes\Terminal\<32-hex-id>

mklink /J "%DATA%\MQL5\Experts\Alikhande"  "%REPO%\MQL5\Experts\Alikhande"
mklink /J "%DATA%\MQL5\Include\Alikhande"  "%REPO%\MQL5\Include\Alikhande"
mklink /J "%DATA%\MQL5\Scripts\Alikhande"  "%REPO%\MQL5\Scripts\Alikhande"
```

> **Link the three `Alikhande` leaves, never `MQL5\` itself.** That directory
> also holds the MetaQuotes standard library (`Include\Trade\Trade.mqh` and the
> rest), `Libraries`, `Profiles` and `Logs`. Replacing it destroys the standard
> library this project includes from.

If junction creation is blocked on your machine, copy the three folders
instead — and remember that edits in the data folder are then the real source
and will be lost on the next copy.

*Junctions into `MQL5\` are widespread community practice, not documented by
MetaQuotes. Verify by compiling, and fall back to copying if MetaEditor
misbehaves with the linked `.mqh` files.*

---

## 3. Compile

In MetaEditor, open and compile each of:

| File | What it is |
|---|---|
| `Scripts\Alikhande\SymbolSpecDump.mq5` | Broker diagnostics — compile this first |
| `Scripts\Alikhande\RunTests.mq5` | The assertion suite |
| `Experts\Alikhande\AlikhandeEA.mq5` | The EA |

**Report every error and warning.** None of this code has been through a
compiler — the development environment is Linux, where MQL5 cannot be built.
Treat warnings as errors; MQL5's compiler catches implicit narrowing and
possible-loss-of-data cases that are exactly the numeric bugs that cost money.

---

## 4. Verify before trusting anything

**First, dump the broker specification.** Attach `SymbolSpecDump` to the chart
of the symbol you intend to trade and read the Experts tab. It prints digits,
point, tick value, contract size, volume min/max/step, stops level, freeze
level, execution mode, the advertised filling modes, and a worked position-size
example against your actual equity.

Check the numbers look sane. A tick value of 0 means the symbol is not in
Market Watch, and every lot size derived from it would be wrong.

**Then run the tests.** Attach `RunTests` to any chart. The last line must read
`RESULT: PASSED`. If anything fails, every failing line begins with `FAIL` and
names the expected and actual values — send those lines.

---

## 5. Run the EA in alert-only mode

Attach `AlikhandeEA` to a chart. `InpExecutionMode` defaults to
`EXEC_ALERT_ONLY`: it evaluates signals, sizes them, logs exactly what it would
do, alerts — and **sends nothing**.

Leave it there and watch the signals against the chart for a while. Only switch
to `EXEC_TRADE` once the timing looks right to you, and only on a demo account.

Inputs worth setting before anything else:

| Input | Default | Note |
|---|---|---|
| `InpMagic` | 20260915 | **Must be unique per strategy + symbol.** Two EAs sharing a magic will manage each other's positions. |
| `InpRiskPercent` | 0.50 | Percent of equity risked per trade |
| `InpDailyLossPct` | 3.00 | Daily kill switch; 0 disables it |
| `InpSessionStart` / `InpSessionEnd` | 8 / 21 | **Broker server hours, not your local time.** The journal prints the derived GMT offset at init. |
| `InpLogLevel` | `ALOG_INFO` | `ALOG_DEBUG` for diagnosis; never for a long test |

---

## 6. Local tooling (optional, any OS)

```bash
make install-dev   # installs pytest
make check         # linter + tests, exactly what CI runs
```

`make check` does **not** prove the MQL5 compiles. See `docs/TESTING.md`.
