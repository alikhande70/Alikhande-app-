#!/usr/bin/env python3
"""Run the Tier-0 screening battery and record the results.

    python3 research/run_screen.py --instrument GOLD --all
    python3 research/run_screen.py --instrument EURUSD --strategy donchian_breakout
    python3 research/run_screen.py --standings

Every run appends to research/experiments/ledger.jsonl. Nothing is overwritten,
so a failed idea stays visible and does not get retried by accident.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from alkresearch import data, engine, metrics as M          # noqa: E402
from alkresearch.ledger import Ledger                        # noqa: E402
from alkresearch.screen import screen                        # noqa: E402
from alkresearch.strategies import ALL                       # noqa: E402

#: Cost assumptions per instrument, in price units. These are ASSUMPTIONS -
#: the screening data carries no bid/ask - and they are set pessimistically.
COSTS = {
    "GOLD":   engine.CostModel(spread=0.50, commission=0.10, slippage=0.10, slippage_on_stop=0.20),
    "SILVER": engine.CostModel(spread=0.030, commission=0.005, slippage=0.005, slippage_on_stop=0.010),
    "EURUSD": engine.CostModel(spread=0.00012, commission=0.00007, slippage=0.00003, slippage_on_stop=0.00006),
}

#: The hypothesis for each family, written before the run.
HYPOTHESES = {
    "ema_cross": (
        "A fast EMA crossing a slow EMA identifies trend changes early enough that the "
        "continuation pays more than costs.",
        "Eliminated if expectancy fails to beat the long-only benchmark by 0.05R, or sits "
        "inside the random-entry band, or the sample is too small to be conclusive.",
    ),
    "donchian_breakout": (
        "Price closing beyond its N-bar extreme signals continuation often enough to pay "
        "for the losing breakouts.",
        "Same elimination criteria: must beat long-only and exceed the random-entry band.",
    ),
    "band_fade": (
        "A close beyond 2 standard deviations of a 20-bar mean is a stretch that retraces "
        "toward the mean more often than it extends.",
        "Same elimination criteria. A negative expectancy also falsifies the premise "
        "directly, since the opposite behaviour would then be the tradable one.",
    ),
    "squeeze_breakout": (
        "Volatility clusters, so a contraction in ATR relative to its longer average "
        "predicts an expansion, and entering in the breakout direction pays.",
        "Same elimination criteria. Separating the regime filter from the trigger means a "
        "failure can be attributed to one or the other.",
    ),
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--instrument", default="GOLD", choices=sorted(COSTS))
    ap.add_argument("--strategy", choices=sorted(ALL))
    ap.add_argument("--all", action="store_true", help="screen every registered strategy")
    ap.add_argument("--range", default="10y")
    ap.add_argument("--no-sweep", action="store_true", help="skip the parameter plateau sweep")
    ap.add_argument("--standings", action="store_true", help="print the ledger standings and exit")
    args = ap.parse_args()

    ledger = Ledger()

    if args.standings:
        s = ledger.summary()
        print(f"Ledger: {s['total_records']} records, {s['active_records']} active")
        print(f"By status: {s['by_status']}")
        print(f"Champion: {s['champion'] or 'NONE - requires Tier-1 evidence'}\n")
        for i, r in enumerate(ledger.standings(), 1):
            mm = r["metrics"]
            print(f"{i}. {r['strategy']:20s} {r['status']:11s} "
                  f"exp {mm.get('expectancy_r', 0):+.3f}R  "
                  f"n={mm.get('trades', 0):4d}  [{r['data']['instrument_key']}]")
            print(f"   {r['verdict']}")
        return 0

    if not args.strategy and not args.all:
        ap.error("give --strategy NAME or --all")

    series = data.fetch(args.instrument, "1d", args.range)
    costs = COSTS[args.instrument]
    names = sorted(ALL) if args.all else [args.strategy]

    print(f"Instrument {args.instrument} ({series.instrument.symbol})  "
          f"{series.period[0]} -> {series.period[1]}  bars={len(series)}  "
          f"hash={series.content_hash}")
    if series.instrument.is_proxy:
        print(f"  PROXY for {series.instrument.proxy_for}")
    print(f"Costs (assumed): {costs.describe()}\n")

    for name in names:
        cls = ALL[name]
        params = cls().params()
        prior = ledger.already_tried(name, params, series.content_hash)
        if prior:
            print(f"{name}: already run as {prior['id']} -> {prior['verdict']}\n")
            continue

        hyp, rej = HYPOTHESES.get(name, ("(none recorded)", "(none recorded)"))
        rec, run = screen(series, cls, params, costs, hyp, rej, ledger,
                          run_sweep=not args.no_sweep)
        mm = rec.metrics
        print(f"--- {name} ---")
        print(f"  {M.summary_line(M.Metrics(**{k: v for k, v in mm.items() if k in M.Metrics().to_dict()}))}")
        for gate in run.reports:
            mark = {"PASS": "ok  ", "FAIL": "FAIL", "SKIP": "skip", "BLOCKED": "wall"}[gate.result.value]
            print(f"  [{mark}] {gate.gate:20s} {gate.detail}")
        print(f"  VERDICT: {rec.verdict}")
        print(f"  recorded as {rec.id}\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
