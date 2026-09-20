# Tier-1 validation scripts

Vendored from the `backtest-validation` skill on 2026-09-20, unmodified.

These take a **trade list**, not bars. Their intended input is an MT5 Strategy
Tester export — Tier-1 evidence, which this environment cannot produce. They
are here so that when the owner runs a Strategy Tester backtest, the analysis
is already built and standard.

```bash
python3 research/validation/analyze_trades.py trades.csv --balance 10000 --extra-cost 7
python3 research/validation/walkforward.py plan --start 2019-01-01 --end 2025-12-31 \
        --is-months 12 --oos-months 3 --csv windows.csv
python3 research/validation/walkforward.py score windows.csv
```

`walkforward.py plan` generates the exact in-sample/out-of-sample window
schedule to run in the Strategy Tester; `score` computes Walk-Forward
Efficiency from the completed results.

Unlike the rest of `research/`, these need numpy and pandas
(`make install-dev`). The screening engine is deliberately dependency-free so
it runs in any scheduled session without an install step.
