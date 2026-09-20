# VENDORED from the backtest-validation skill, 2026-09-20, unmodified.
#
# These operate on a TRADE LIST, not on bars, and their intended input is an
# MT5 Strategy Tester export - Tier-1 evidence. They are the analysis layer
# for results this environment cannot produce itself.
#
# Unlike the rest of research/, these require numpy and pandas.

#!/usr/bin/env python3
"""
walkforward.py — plan and score a Walk-Forward Analysis.

Two modes.

PLAN: generate the exact in-sample / out-of-sample date windows to run in the
MT5 Strategy Tester, so the schedule is decided before you see any results
(which is the whole point — a schedule chosen after looking at results is
another form of data snooping).

    python walkforward.py plan --start 2019-01-01 --end 2025-12-31 \
        --is-months 12 --oos-months 3 --mode rolling

    python walkforward.py plan --start 2019-01-01 --end 2025-12-31 \
        --is-months 24 --oos-months 6 --mode anchored --csv windows.csv

SCORE: given the results of those runs, compute Walk-Forward Efficiency and
the consistency statistics that say whether the optimization produced real
information or just fitted noise.

    python walkforward.py score results.csv

results.csv columns (header required, extra columns ignored):
    window, is_profit, oos_profit          <- minimum
    is_months, oos_months                  <- optional, improves normalisation
    is_trades, oos_trades                  <- optional, flags thin windows
    oos_maxdd_pct                          <- optional, adds a drawdown view

Interpretation of Walk-Forward Efficiency (WFE):
    WFE = mean OOS return rate / mean IS return rate
    > 0.7   strong — parameters generalise well
    0.5-0.7 acceptable
    0.3-0.5 weak; the optimizer is capturing mostly noise
    < 0.3   the strategy is fitted, not discovered
A WFE above ~1.0 across many windows is usually luck or a favourable regime in
the OOS periods, not evidence the strategy is better out of sample.
"""

import argparse
import csv
import math
import sys
from datetime import date

import pandas as pd


def add_months(d: date, n: int) -> date:
    y = d.year + (d.month - 1 + n) // 12
    m = (d.month - 1 + n) % 12 + 1
    # clamp day to end of target month
    for day in range(d.day, 0, -1):
        try:
            return date(y, m, day)
        except ValueError:
            continue
    return date(y, m, 1)


def plan(args):
    start = pd.to_datetime(args.start).date()
    end = pd.to_datetime(args.end).date()

    windows = []
    is_start = start
    is_months = args.is_months          # mutated in anchored mode; keep the original for the header
    i = 1
    while True:
        is_end = add_months(is_start, is_months)
        oos_end = add_months(is_end, args.oos_months)
        if oos_end > end:
            break
        windows.append({
            "window": i,
            "is_start": is_start.isoformat(),
            "is_end": is_end.isoformat(),
            "oos_start": is_end.isoformat(),
            "oos_end": oos_end.isoformat(),
        })
        i += 1
        if args.mode == "rolling":
            is_start = add_months(is_start, args.oos_months)
        else:  # anchored: IS always begins at the very start and grows each step
            is_start = start
            is_months += args.oos_months

    if not windows:
        raise SystemExit("No complete windows fit in that date range. "
                         "Shorten --is-months / --oos-months or extend the range.")

    is_label = (f"IS {args.is_months}m" if args.mode == "rolling"
                else f"IS growing from {args.is_months}m")
    print(f"Walk-forward plan — {args.mode}, {is_label} / OOS {args.oos_months}m")
    print(f"{'#':>3}  {'IS start':<12}{'IS end':<12}{'OOS start':<12}{'OOS end':<12}")
    for w in windows:
        print(f"{w['window']:>3}  {w['is_start']:<12}{w['is_end']:<12}"
              f"{w['oos_start']:<12}{w['oos_end']:<12}")

    total_oos_months = len(windows) * args.oos_months
    print(f"\n{len(windows)} windows, {total_oos_months} months of out-of-sample data in total.")
    if len(windows) < 5:
        print("WARNING: fewer than 5 windows gives a very noisy WFE. Prefer a longer "
              "history or shorter OOS steps.")
    if total_oos_months < 24:
        print("WARNING: under two years of aggregate OOS is thin for a conclusion.")

    print("\nProcedure for each window:")
    print("  1. Optimize parameters on the IS range ONLY.")
    print("  2. Pick the parameter set by your stated criterion, chosen in advance.")
    print("  3. Run a single test on the OOS range with those parameters. Do not")
    print("     re-optimize, do not peek, do not adjust after seeing the result.")
    print("  4. Record is_profit and oos_profit, then move to the next window.")
    print("  5. Score with:  python walkforward.py score results.csv")

    if args.csv:
        with open(args.csv, "w", newline="") as f:
            wr = csv.DictWriter(f, fieldnames=[
                "window", "is_start", "is_end", "oos_start", "oos_end",
                "is_profit", "oos_profit", "is_trades", "oos_trades", "oos_maxdd_pct"])
            wr.writeheader()
            for w in windows:
                wr.writerow(w)
        print(f"\nTemplate written to {args.csv} — fill in the result columns.")


def score(args):
    df = pd.read_csv(args.csv)
    df.columns = [c.strip().lower() for c in df.columns]

    for req in ("is_profit", "oos_profit"):
        if req not in df.columns:
            raise SystemExit(f"Missing required column '{req}'. Found: {list(df.columns)}")

    df = df.dropna(subset=["is_profit", "oos_profit"])
    if df.empty:
        raise SystemExit("No completed windows in the file.")

    n = len(df)
    is_m = df["is_months"] if "is_months" in df.columns else pd.Series([1.0] * n)
    oos_m = df["oos_months"] if "oos_months" in df.columns else pd.Series([1.0] * n)

    # Normalise to profit per month so IS and OOS are comparable even when the
    # window lengths differ. Without this, WFE is meaningless.
    is_rate = (df["is_profit"].to_numpy() / is_m.to_numpy())
    oos_rate = (df["oos_profit"].to_numpy() / oos_m.to_numpy())

    mean_is = float(is_rate.mean())
    mean_oos = float(oos_rate.mean())
    wfe = mean_oos / mean_is if mean_is != 0 else float("nan")

    positive_oos = int((df["oos_profit"] > 0).sum())
    consistency = positive_oos / n * 100.0
    total_oos = float(df["oos_profit"].sum())

    oos_std = float(oos_rate.std(ddof=1)) if n > 1 else 0.0
    oos_t = (mean_oos / (oos_std / math.sqrt(n))) if oos_std > 0 else float("nan")

    print("=" * 62)
    print("WALK-FORWARD SCORE")
    print("=" * 62)
    print(f"Windows                     : {n}")
    print(f"Mean IS profit / month      : {mean_is:,.2f}")
    print(f"Mean OOS profit / month     : {mean_oos:,.2f}")
    print(f"Walk-Forward Efficiency     : {wfe:.2f}")
    print(f"Profitable OOS windows      : {positive_oos}/{n}  ({consistency:.0f}%)")
    print(f"Total OOS profit            : {total_oos:,.2f}")
    if not math.isnan(oos_t):
        print(f"t-stat of OOS mean vs zero  : {oos_t:.2f}"
              f"   ({'significant' if abs(oos_t) > 2 else 'NOT significant'} at ~95%)")
    if "oos_maxdd_pct" in df.columns and df["oos_maxdd_pct"].notna().any():
        print(f"Worst OOS drawdown          : {df['oos_maxdd_pct'].max():.2f}%")
    if "oos_trades" in df.columns and df["oos_trades"].notna().any():
        thin = int((df["oos_trades"] < 20).sum())
        print(f"Windows with <20 OOS trades : {thin}"
              f"{'  <-- these windows carry little information' if thin else ''}")

    print("-" * 62)
    print("VERDICT")
    if math.isnan(wfe):
        print("  IS profit is zero — cannot compute WFE.")
    elif wfe >= 0.7:
        print(f"  WFE {wfe:.2f} — strong. Parameters generalise out of sample.")
    elif wfe >= 0.5:
        print(f"  WFE {wfe:.2f} — acceptable. Some fitting, but real signal underneath.")
    elif wfe >= 0.3:
        print(f"  WFE {wfe:.2f} — weak. The optimizer is mostly fitting noise.")
        print("  Reduce parameter count or lengthen the IS window before continuing.")
    else:
        print(f"  WFE {wfe:.2f} — the in-sample results do not transfer. Treat this")
        print("  strategy as unvalidated regardless of how good the backtest looked.")

    if consistency < 50:
        print(f"  Only {consistency:.0f}% of OOS windows profitable — the equity curve")
        print("  will be dominated by a few good periods. Expect long flat stretches.")
    if n < 5:
        print("  Fewer than 5 windows: WFE has a wide error bar. Do not over-read it.")
    print("=" * 62)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("plan", help="Generate IS/OOS window schedule")
    p.add_argument("--start", required=True, help="YYYY-MM-DD")
    p.add_argument("--end", required=True, help="YYYY-MM-DD")
    p.add_argument("--is-months", type=int, default=12)
    p.add_argument("--oos-months", type=int, default=3)
    p.add_argument("--mode", choices=["rolling", "anchored"], default="rolling")
    p.add_argument("--csv", help="Write a results template to this path")
    p.set_defaults(func=plan)

    s = sub.add_parser("score", help="Score completed walk-forward results")
    s.add_argument("csv", help="Results CSV")
    s.set_defaults(func=score)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    sys.exit(main())
