# VENDORED from the backtest-validation skill, 2026-09-20, unmodified.
#
# These operate on a TRADE LIST, not on bars, and their intended input is an
# MT5 Strategy Tester export - Tier-1 evidence. They are the analysis layer
# for results this environment cannot produce itself.
#
# Unlike the rest of research/, these require numpy and pandas.

#!/usr/bin/env python3
"""
analyze_trades.py — honest analysis of a backtest or live trade list.

Takes a CSV of closed trades and produces the numbers that actually decide
whether a strategy is worth capital: risk-adjusted metrics net of costs,
outlier dependence, cost sensitivity, and a Monte Carlo distribution of
drawdown and ruin.

Usage
-----
    python analyze_trades.py trades.csv --balance 10000
    python analyze_trades.py trades.csv --balance 10000 --extra-cost 7 --risk-per-trade 100
    python analyze_trades.py trades.csv --balance 10000 --sims 20000 --json out.json

Input CSV
---------
Required: a profit column (net P/L per closed trade, account currency).
    Auto-detected from: profit, pnl, p/l, net, result, profit_usd
Optional: a time column (close time) -> enables period splits and time stats.
    Auto-detected from: time, close_time, closetime, date, exit_time
Optional: a volume column (lots) -> enables per-lot cost modelling.
    Auto-detected from: volume, lots, size, lot

MT5 "Report" exports work after saving the Deals/Trades table as CSV. If the
column names differ, pass --profit-col / --time-col / --volume-col.

Nothing here is a verdict on its own. Read it together with the walk-forward
and out-of-sample results; a good report on an in-sample-only trade list
means nothing.
"""

import argparse
import json
import math
import sys

import numpy as np
import pandas as pd

PROFIT_CANDIDATES = ["profit", "pnl", "p/l", "p&l", "net", "net_profit",
                     "result", "profit_usd", "pl", "gain"]
TIME_CANDIDATES = ["close_time", "closetime", "time", "date", "exit_time",
                   "close time", "time_close"]
VOLUME_CANDIDATES = ["volume", "lots", "lot", "size", "vol"]


# ----------------------------------------------------------------------
# loading
# ----------------------------------------------------------------------
def _find_col(df, candidates, explicit=None):
    if explicit:
        if explicit not in df.columns:
            raise SystemExit(f"Column '{explicit}' not found. Available: {list(df.columns)}")
        return explicit
    lowered = {str(c).strip().lower(): c for c in df.columns}
    for cand in candidates:
        if cand in lowered:
            return lowered[cand]
    return None


def load_trades(path, profit_col=None, time_col=None, volume_col=None):
    # Try a few separators; MT5 exports are inconsistent about this.
    df = None
    for sep in [None, ",", ";", "\t"]:
        try:
            trial = pd.read_csv(path, sep=sep, engine="python")
            if trial.shape[1] >= 1:
                df = trial
                break
        except Exception:
            continue
    if df is None or df.empty:
        raise SystemExit(f"Could not read any rows from {path}")

    pcol = _find_col(df, PROFIT_CANDIDATES, profit_col)
    if pcol is None:
        raise SystemExit(
            "No profit column found. Pass --profit-col explicitly.\n"
            f"Available columns: {list(df.columns)}"
        )

    profit = pd.to_numeric(
        df[pcol].astype(str).str.replace(r"[ , ]", "", regex=True).str.replace("−", "-"),
        errors="coerce",
    )
    out = pd.DataFrame({"profit": profit})

    tcol = _find_col(df, TIME_CANDIDATES, time_col)
    if tcol is not None:
        out["time"] = pd.to_datetime(df[tcol], errors="coerce", dayfirst=False)

    vcol = _find_col(df, VOLUME_CANDIDATES, volume_col)
    if vcol is not None:
        out["volume"] = pd.to_numeric(df[vcol], errors="coerce")

    out = out.dropna(subset=["profit"])
    # Drop rows that are clearly not trades (balance operations show as 0 volume
    # with a large profit, deposits, etc.). Keep it conservative: only drop exact
    # zero-profit rows if they carry no volume information.
    if "volume" in out.columns:
        out = out[~((out["profit"] == 0) & (out["volume"].fillna(0) == 0))]

    out = out.reset_index(drop=True)
    if len(out) == 0:
        raise SystemExit("No usable trades after parsing.")
    return out


# ----------------------------------------------------------------------
# metrics
# ----------------------------------------------------------------------
def max_drawdown(equity):
    """Return (max_dd_absolute, max_dd_pct_of_peak, longest_dd_length_in_trades)."""
    peak = np.maximum.accumulate(equity)
    dd = peak - equity
    max_dd = float(dd.max()) if len(dd) else 0.0
    with np.errstate(divide="ignore", invalid="ignore"):
        dd_pct = np.where(peak > 0, dd / peak, 0.0)
    max_dd_pct = float(np.nanmax(dd_pct)) * 100.0 if len(dd_pct) else 0.0

    longest, current = 0, 0
    for i in range(len(equity)):
        if dd[i] > 1e-12:
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return max_dd, max_dd_pct, longest


def core_metrics(profits, balance, risk_per_trade=None):
    p = np.asarray(profits, dtype=float)
    n = len(p)
    wins = p[p > 0]
    losses = p[p < 0]

    gross_profit = float(wins.sum())
    gross_loss = float(-losses.sum())
    net = float(p.sum())

    pf = gross_profit / gross_loss if gross_loss > 0 else math.inf
    win_rate = len(wins) / n * 100.0 if n else 0.0
    avg_win = float(wins.mean()) if len(wins) else 0.0
    avg_loss = float(-losses.mean()) if len(losses) else 0.0
    payoff = avg_win / avg_loss if avg_loss > 0 else math.inf
    expectancy = float(p.mean()) if n else 0.0

    equity = balance + np.cumsum(p)
    max_dd, max_dd_pct, dd_len = max_drawdown(equity)

    std = float(p.std(ddof=1)) if n > 1 else 0.0
    # Per-trade Sharpe-like ratio; annualisation needs a trade frequency, which
    # is reported separately. Quoting it per-trade avoids a fake annual number.
    sharpe_trade = expectancy / std if std > 0 else 0.0
    downside = p[p < 0]
    dstd = float(downside.std(ddof=1)) if len(downside) > 1 else 0.0
    sortino_trade = expectancy / dstd if dstd > 0 else 0.0
    # Van Tharp SQN
    sqn = sharpe_trade * math.sqrt(n) if n > 0 else 0.0

    ret_pct = net / balance * 100.0 if balance > 0 else 0.0
    calmar = ret_pct / max_dd_pct if max_dd_pct > 0 else math.inf
    recovery = net / max_dd if max_dd > 0 else math.inf

    # Consecutive streaks
    max_win_streak = max_loss_streak = cur_w = cur_l = 0
    for x in p:
        if x > 0:
            cur_w += 1
            cur_l = 0
        elif x < 0:
            cur_l += 1
            cur_w = 0
        max_win_streak = max(max_win_streak, cur_w)
        max_loss_streak = max(max_loss_streak, cur_l)

    m = {
        "trades": n,
        "net_profit": net,
        "return_pct": ret_pct,
        "gross_profit": gross_profit,
        "gross_loss": gross_loss,
        "profit_factor": pf,
        "win_rate_pct": win_rate,
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "payoff_ratio": payoff,
        "expectancy_per_trade": expectancy,
        "std_per_trade": std,
        "sharpe_per_trade": sharpe_trade,
        "sortino_per_trade": sortino_trade,
        "sqn": sqn,
        "max_drawdown": max_dd,
        "max_drawdown_pct": max_dd_pct,
        "max_dd_length_trades": dd_len,
        "calmar_like": calmar,
        "recovery_factor": recovery,
        "largest_win": float(p.max()) if n else 0.0,
        "largest_loss": float(p.min()) if n else 0.0,
        "max_consecutive_wins": max_win_streak,
        "max_consecutive_losses": max_loss_streak,
    }
    if risk_per_trade and risk_per_trade > 0:
        m["expectancy_R"] = expectancy / risk_per_trade
        m["max_drawdown_R"] = max_dd / risk_per_trade
    return m


def outlier_dependence(profits, balance, top_n=5):
    """How much of the result rests on a handful of trades."""
    p = np.asarray(profits, dtype=float)
    if len(p) <= top_n:
        return None
    order = np.argsort(p)[::-1]
    keep = np.ones(len(p), dtype=bool)
    keep[order[:top_n]] = False
    stripped = p[keep]
    return {
        "top_n": top_n,
        "top_n_profit": float(p[order[:top_n]].sum()),
        "top_n_share_of_gross_profit_pct": (
            float(p[order[:top_n]].sum()) / float(p[p > 0].sum()) * 100.0
            if p[p > 0].sum() > 0 else 0.0
        ),
        "net_without_top_n": float(stripped.sum()),
        "profit_factor_without_top_n": core_metrics(stripped, balance)["profit_factor"],
    }


def cost_stress(profits, balance, extra_cost_per_trade, multipliers=(1.0, 1.5, 2.0)):
    """Re-run the headline metrics with additional round-turn cost per trade."""
    rows = []
    for mult in multipliers:
        c = extra_cost_per_trade * mult
        adj = np.asarray(profits, dtype=float) - c
        m = core_metrics(adj, balance)
        rows.append({
            "cost_multiplier": mult,
            "cost_per_trade": c,
            "net_profit": m["net_profit"],
            "profit_factor": m["profit_factor"],
            "expectancy_per_trade": m["expectancy_per_trade"],
            "max_drawdown_pct": m["max_drawdown_pct"],
        })
    return rows


# ----------------------------------------------------------------------
# Monte Carlo
# ----------------------------------------------------------------------
def monte_carlo(profits, balance, sims=10000, method="bootstrap",
                ruin_pct=50.0, seed=42):
    """
    Randomise the trade sequence to estimate the distribution of outcomes.

    method="shuffle"   : reorder the same trades (tests sequence luck only)
    method="bootstrap" : resample with replacement (also tests sample luck)

    Bootstrap is the more honest default: the historical trade set is itself a
    sample, and the next N trades will not be the same N trades in a new order.
    """
    rng = np.random.default_rng(seed)
    p = np.asarray(profits, dtype=float)
    n = len(p)
    ruin_level = balance * (1.0 - ruin_pct / 100.0)

    finals = np.empty(sims)
    max_dds = np.empty(sims)
    max_dd_pcts = np.empty(sims)
    ruined = 0

    for i in range(sims):
        if method == "shuffle":
            seq = rng.permutation(p)
        else:
            seq = p[rng.integers(0, n, n)]
        equity = balance + np.cumsum(seq)
        finals[i] = equity[-1]
        dd, dd_pct, _ = max_drawdown(equity)
        max_dds[i] = dd
        max_dd_pcts[i] = dd_pct
        if equity.min() <= ruin_level:
            ruined += 1

    def q(a, x):
        return float(np.percentile(a, x))

    return {
        "sims": sims,
        "method": method,
        "final_equity": {
            "p05": q(finals, 5), "p25": q(finals, 25), "median": q(finals, 50),
            "p75": q(finals, 75), "p95": q(finals, 95),
            "mean": float(finals.mean()),
        },
        "max_drawdown_pct": {
            "median": q(max_dd_pcts, 50), "p75": q(max_dd_pcts, 75),
            "p90": q(max_dd_pcts, 90), "p95": q(max_dd_pcts, 95),
            "worst": float(max_dd_pcts.max()),
        },
        "prob_profitable_pct": float((finals > balance).mean() * 100.0),
        "prob_ruin_pct": ruined / sims * 100.0,
        "ruin_defined_as_pct_loss": ruin_pct,
    }


# ----------------------------------------------------------------------
# period split (in-sample vs out-of-sample sanity check)
# ----------------------------------------------------------------------
def split_halves(df, balance):
    """Compare the first and second half of the trade list chronologically."""
    n = len(df)
    if n < 40:
        return None
    if "time" in df.columns and df["time"].notna().all():
        df = df.sort_values("time").reset_index(drop=True)
    mid = n // 2
    first = core_metrics(df["profit"].iloc[:mid], balance)
    second = core_metrics(df["profit"].iloc[mid:], balance)
    return {"first_half": first, "second_half": second}


# ----------------------------------------------------------------------
# reporting
# ----------------------------------------------------------------------
def fmt(x, nd=2):
    if x is None:
        return "n/a"
    if isinstance(x, float):
        if math.isinf(x):
            return "inf"
        if math.isnan(x):
            return "nan"
        return f"{x:,.{nd}f}"
    return str(x)


def print_report(res, currency="USD"):
    m = res["metrics"]
    print("=" * 66)
    print("TRADE LIST ANALYSIS")
    print("=" * 66)
    print(f"Trades                 : {m['trades']}")
    if res.get("period"):
        print(f"Period                 : {res['period']}")
    print(f"Net profit             : {fmt(m['net_profit'])} {currency}   ({fmt(m['return_pct'])}% of start balance)")
    print(f"Profit factor          : {fmt(m['profit_factor'])}")
    print(f"Win rate               : {fmt(m['win_rate_pct'])}%")
    print(f"Payoff (avgW/avgL)     : {fmt(m['payoff_ratio'])}")
    print(f"Expectancy / trade     : {fmt(m['expectancy_per_trade'])} {currency}", end="")
    if "expectancy_R" in m:
        print(f"   ({fmt(m['expectancy_R'], 3)} R)")
    else:
        print()
    print(f"Std dev / trade        : {fmt(m['std_per_trade'])}")
    print(f"Sharpe (per trade)     : {fmt(m['sharpe_per_trade'], 3)}")
    print(f"Sortino (per trade)    : {fmt(m['sortino_per_trade'], 3)}")
    print(f"SQN                    : {fmt(m['sqn'], 2)}")
    print("-" * 66)
    print(f"Max drawdown           : {fmt(m['max_drawdown'])} {currency}  ({fmt(m['max_drawdown_pct'])}%)", end="")
    if "max_drawdown_R" in m:
        print(f"   ({fmt(m['max_drawdown_R'], 1)} R)")
    else:
        print()
    print(f"Longest DD (trades)    : {m['max_dd_length_trades']}")
    print(f"Return / MaxDD         : {fmt(m['calmar_like'], 2)}")
    print(f"Recovery factor        : {fmt(m['recovery_factor'], 2)}")
    print(f"Largest win / loss     : {fmt(m['largest_win'])} / {fmt(m['largest_loss'])}")
    print(f"Max consec win / loss  : {m['max_consecutive_wins']} / {m['max_consecutive_losses']}")

    if res.get("outliers"):
        o = res["outliers"]
        print("-" * 66)
        print(f"OUTLIER DEPENDENCE (remove top {o['top_n']} winners)")
        print(f"  Top {o['top_n']} contributed  : {fmt(o['top_n_profit'])} "
              f"({fmt(o['top_n_share_of_gross_profit_pct'])}% of gross profit)")
        print(f"  Net without them   : {fmt(o['net_without_top_n'])}")
        print(f"  PF without them    : {fmt(o['profit_factor_without_top_n'])}")
        if o["net_without_top_n"] <= 0:
            print("  >> WARNING: the entire result rests on a few outlier trades.")

    if res.get("cost_stress"):
        print("-" * 66)
        print("COST SENSITIVITY (extra cost applied per trade)")
        print(f"  {'mult':>5}  {'cost/trade':>11}  {'net':>13}  {'PF':>7}  {'exp/trade':>11}  {'maxDD%':>8}")
        for r in res["cost_stress"]:
            print(f"  {r['cost_multiplier']:>5.1f}  {fmt(r['cost_per_trade']):>11}  "
                  f"{fmt(r['net_profit']):>13}  {fmt(r['profit_factor']):>7}  "
                  f"{fmt(r['expectancy_per_trade'], 3):>11}  {fmt(r['max_drawdown_pct']):>8}")
        if res["cost_stress"][-1]["net_profit"] <= 0:
            print("  >> WARNING: the edge does not survive doubled costs.")

    if res.get("halves"):
        h = res["halves"]
        print("-" * 66)
        print("STABILITY (first half vs second half, chronological)")
        print(f"  {'':<22}{'first':>14}{'second':>14}")
        for key, label in [("trades", "trades"), ("profit_factor", "profit factor"),
                           ("expectancy_per_trade", "expectancy"),
                           ("win_rate_pct", "win rate %"),
                           ("max_drawdown_pct", "max DD %")]:
            print(f"  {label:<22}{fmt(h['first_half'][key]):>14}{fmt(h['second_half'][key]):>14}")
        if h["second_half"]["expectancy_per_trade"] <= 0 < h["first_half"]["expectancy_per_trade"]:
            print("  >> WARNING: edge present early, absent later. Classic decay or fit-to-early-data.")

    if res.get("monte_carlo"):
        mc = res["monte_carlo"]
        print("-" * 66)
        print(f"MONTE CARLO ({mc['sims']:,} sims, {mc['method']})")
        fe = mc["final_equity"]
        print(f"  Final equity  p05 {fmt(fe['p05'])} | median {fmt(fe['median'])} | p95 {fmt(fe['p95'])}")
        dd = mc["max_drawdown_pct"]
        print(f"  Max DD %      median {fmt(dd['median'])} | p90 {fmt(dd['p90'])} "
              f"| p95 {fmt(dd['p95'])} | worst {fmt(dd['worst'])}")
        print(f"  P(profitable) : {fmt(mc['prob_profitable_pct'])}%")
        print(f"  P(lose {fmt(mc['ruin_defined_as_pct_loss'],0)}%)  : {fmt(mc['prob_ruin_pct'])}%")
        print("  >> Size the account for the p95 drawdown, not the historical one.")

    print("-" * 66)
    print("SAMPLE ADEQUACY")
    n = m["trades"]
    if n < 30:
        print(f"  {n} trades — statistically meaningless. Do not draw conclusions.")
    elif n < 100:
        print(f"  {n} trades — too few. Confidence intervals are very wide.")
    elif n < 200:
        print(f"  {n} trades — minimum viable. Treat conclusions as provisional.")
    else:
        print(f"  {n} trades — adequate sample size, provided it spans multiple regimes.")
    # Standard error of the mean gives a blunt but honest confidence band.
    if n > 1 and m["std_per_trade"] > 0:
        se = m["std_per_trade"] / math.sqrt(n)
        lo = m["expectancy_per_trade"] - 1.96 * se
        hi = m["expectancy_per_trade"] + 1.96 * se
        print(f"  95% CI on expectancy per trade: [{fmt(lo, 3)}, {fmt(hi, 3)}]")
        if lo <= 0 <= hi:
            print("  >> The confidence interval includes zero: this sample cannot")
            print("     distinguish the strategy from a coin flip. More data needed.")
    print("=" * 66)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", help="Trade list CSV")
    ap.add_argument("--balance", type=float, default=10000.0, help="Starting balance")
    ap.add_argument("--currency", default="USD")
    ap.add_argument("--risk-per-trade", type=float, default=None,
                    help="Money risked per trade, to express results in R")
    ap.add_argument("--extra-cost", type=float, default=0.0,
                    help="Extra round-turn cost per trade for the stress test")
    ap.add_argument("--sims", type=int, default=10000, help="Monte Carlo simulations")
    ap.add_argument("--mc-method", choices=["bootstrap", "shuffle"], default="bootstrap")
    ap.add_argument("--ruin-pct", type=float, default=50.0,
                    help="Equity loss %% that counts as ruin")
    ap.add_argument("--no-mc", action="store_true", help="Skip Monte Carlo")
    ap.add_argument("--profit-col"), ap.add_argument("--time-col"), ap.add_argument("--volume-col")
    ap.add_argument("--json", help="Also write results to this JSON path")
    args = ap.parse_args()

    df = load_trades(args.csv, args.profit_col, args.time_col, args.volume_col)
    profits = df["profit"].to_numpy()

    res = {"metrics": core_metrics(profits, args.balance, args.risk_per_trade)}

    if "time" in df.columns and df["time"].notna().any():
        t = df["time"].dropna()
        res["period"] = f"{t.min():%Y-%m-%d} .. {t.max():%Y-%m-%d}"
        days = max((t.max() - t.min()).days, 1)
        res["metrics"]["trades_per_month"] = len(df) / (days / 30.44)

    res["outliers"] = outlier_dependence(profits, args.balance)
    if args.extra_cost > 0:
        res["cost_stress"] = cost_stress(profits, args.balance, args.extra_cost)
    res["halves"] = split_halves(df, args.balance)
    if not args.no_mc:
        res["monte_carlo"] = monte_carlo(profits, args.balance, args.sims,
                                         args.mc_method, args.ruin_pct)

    print_report(res, args.currency)

    if args.json:
        with open(args.json, "w") as f:
            json.dump(res, f, indent=2, default=str)
        print(f"\nJSON written to {args.json}")


if __name__ == "__main__":
    sys.exit(main())
