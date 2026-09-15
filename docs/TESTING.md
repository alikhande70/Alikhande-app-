# Testing

The honest summary first:

> **Nothing in this repository has been compiled.** MetaEditor is a Windows
> application; the development environment is Linux. No claim is made that the
> `.mq5` / `.mqh` sources build. That verification belongs to the owner, in
> MetaEditor.

Everything below is built around that constraint rather than around it.

---

## The four layers, and what each one actually proves

| Layer | Runs where | Automated? | Proves | Does **not** prove |
|---|---|---|---|---|
| **1. Static lint** | Linux, CI, every push | Yes | No known bug pattern from the MQL5 catalogue is present | Anything about compilation, types, or behaviour |
| **2. Tooling tests** | Linux, CI, every push | Yes | The linter itself is correct | Anything about the MQL5 code |
| **3. Compile** | Windows, MetaEditor | No | The code is valid MQL5 and types check | Anything about behaviour |
| **4. In-terminal assertions** | Windows, MetaTrader | No | The core library's arithmetic and policy are correct | Fills, slippage, latency, broker behaviour |

A green CI badge means **layers 1 and 2 passed**. It does not mean the EA
builds, and it never will — a Linux runner cannot run MetaEditor.

---

## Layer 1 — `mql5lint`

```bash
make lint                       # strict: MEDIUM findings block
python3 -m mql5lint MQL5        # default: only CRITICAL and HIGH block
python3 -m mql5lint MQL5 --format json
```

Twelve rules, each tied to a failure a reviewer can describe as a losing
trade, not to a style preference:

| Rule | Severity | Catches |
|---|---|---|
| MQL001 | CRITICAL | `#define ALIKHANDE_ALLOW_LIVE` — the real-money gate compiled in |
| MQL002 | HIGH | `CopyBuffer` with `start_pos = 0` — reading the forming bar |
| MQL003 | HIGH | `CopyBuffer`'s return value discarded |
| MQL004 | HIGH | Indicator handle created inside `OnTick` / `OnCalculate` / `OnTimer` |
| MQL005 | HIGH | `CopyBuffer` into an array never passed to `ArraySetAsSeries` |
| MQL006 | MEDIUM | `iClose` / `iHigh` / … reading shift 0 |
| MQL007 | MEDIUM | Doubles compared with `==` or `!=` |
| MQL008 | MEDIUM | A hardcoded instrument name |
| MQL009 | HIGH | A ticket in a type narrower than `ulong` |
| MQL010 | HIGH | `OrderSend` outside the execution layer |
| MQL011 | MEDIUM | Upward iteration over a shrinking `PositionsTotal()` |
| MQL012 | MEDIUM | `GlobalVariable*` outside the state module |
| MQL013 | MEDIUM | A suppression written without a justification |

**Comments and string literals are blanked before any rule runs**, with line
and column offsets preserved. Without that, a comment mentioning `CopyBuffer`
becomes a finding and the output stops being trusted.

### Suppressing a finding

A rule that cannot be suppressed locally gets disabled globally instead, so
suppression is supported — with a mandatory reason:

```mql5
// mql5lint: allow MQL006 - bar 0's open time is the new-bar signal itself,
// not a price read; the strategy reads shift >= 1.
datetime t = iTime(_Symbol, PERIOD_CURRENT, 0);
```

It silences **one rule** on the **next line containing code** — intervening
comment and blank lines are skipped, so the justification may run to several
lines. A suppression with no reason silences nothing and is reported as
MQL013.

---

## Layer 2 — the tooling test suite

```bash
make test
```

61 tests over the linter: source blanking, scope tracking, every rule's
positive **and negative** case, the suppression machinery, and the CLI's exit
codes. The negative cases are the important half — a rule that fires on
correct code trains people to ignore the output.

This layer has already earned its place. It caught a false positive where
MQL007 collected `double` declarations file-wide, so `EqualD(double actual,
…)` made `EqualI(long actual, …)` look like a double comparison. Declarations
are now scope-aware.

---

## Layer 3 — compilation (owner, Windows)

1. Open `MQL5/Experts/Alikhande/AlikhandeEA.mq5` in MetaEditor.
2. Compile (F7).
3. **Report every error and warning.** Treat warnings as errors — MQL5's
   compiler catches implicit narrowing and possible-loss-of-data cases that
   are exactly the numeric bugs the pitfall catalogue warns about.

See `docs/INSTALL.md` for getting the repository into the MT5 data folder.

Two traps if this is ever scripted:

- `metaeditor64.exe /compile` pointed at a **folder** compiles that folder
  only — subfolders are not included. Enumerate targets explicitly.
- Exit codes on compile failure are not documented. Parse the `/log:` file
  and fail on any `error` line; do not trust the return code.

*(Both noted as UNVERIFIED in `docs/research/2026-09-15-mt5-platform-state.md`
— confirm against `metaeditor64.exe /?` on the installed build before relying
on either.)*

---

## Layer 4 — in-terminal assertions

1. Compile `MQL5/Scripts/Alikhande/RunTests.mq5`.
2. Attach it to any chart.
3. Read the Experts tab. The last line is `RESULT: PASSED` or `RESULT: FAILED`.

Every failing line begins with `FAIL`, so a headless harness can parse the
log.

Assertions run against **synthetic** symbol specs built from explicit numbers,
not from whichever broker is connected — a test whose expected value depends
on the broker proves nothing and fails for the wrong reasons.

Covered: volume normalization (rounds down, float residue, min/max, hard cap,
aggregate limit, zero below minimum); minimum stop distance including the
spread and the dynamic `stops_level == 0` case; risk arithmetic on 2-digit and
3-digit gold, which must agree on the money and differ only in point count;
retcode classification, with `10012 TIMEOUT` pinned to `AMBIGUOUS` and a sweep
asserting no spec error is ever retryable; symbol trade-mode guards; session
windows including those that wrap midnight; and the safety gate.

**Not covered, and not pretended to be:** order submission, fills, partial
fills, slippage, requotes, latency, and anything requiring a trade server.

---

## Layer 5 — strategy validation (not yet applicable)

There is no validated strategy to test. The bundled EMA cross is a reference
implementation of the signal contract, **not an edge**, and it says so in its
own header.

When a real strategy exists, the protocol is:

1. Real ticks, realistic spread, correct commission, correct swap.
2. A locked out-of-sample period not looked at until the end.
3. At least ~200 in-sample trades, spanning more than one market regime.
4. Walk-forward across the history, not one static split.
5. Cost stress at 1.5× and 2× spread and commission.
6. A parameter neighbourhood scan — the chosen values must sit on a plateau,
   not a spike.
7. Monte Carlo on the trade sequence.
8. Cross-broker tick data check.

**Write the pass/fail criteria before running step 4.** A threshold chosen
after seeing results is negotiation, not validation.

Two things the tester will not tell you, worth repeating: it always fills,
with zero latency and no requotes; and it applies **today's** symbol spec,
swap rates and stops level across all history.

---

## Running everything locally

```bash
make install-dev   # pytest
make check         # test + lint, exactly what CI runs
```

`make check` prints a reminder that it does not prove the MQL5 compiles.
