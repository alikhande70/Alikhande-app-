"""Performance metrics, computed in R (risk multiples).

Everything is in R rather than currency on purpose. R is comparable across
instruments, account sizes and position-sizing schemes, and it cannot be
inflated by quietly increasing leverage - which is the easiest way to make a
mediocre strategy produce an impressive-looking currency return.

Pure standard library so the gates always run, with no dependency that could
fail to install in a scheduled session. Monte Carlo uses `random` with an
explicit seed so a recorded result is reproducible.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, asdict


@dataclass
class Metrics:
    trades: int = 0
    wins: int = 0
    losses: int = 0
    win_rate: float = 0.0

    expectancy_r: float = 0.0          # mean R per trade - the headline number
    expectancy_ci_low: float = 0.0     # 95% CI; if it spans 0 there is no result
    expectancy_ci_high: float = 0.0
    total_r: float = 0.0
    stdev_r: float = 0.0

    profit_factor: float = 0.0
    avg_win_r: float = 0.0
    avg_loss_r: float = 0.0
    largest_win_r: float = 0.0
    largest_loss_r: float = 0.0

    max_drawdown_r: float = 0.0
    max_drawdown_trades: int = 0       # duration, in trades
    return_over_dd: float = 0.0

    longest_loss_streak: int = 0
    longest_win_streak: int = 0

    # Robustness
    expectancy_ex_top5_r: float = 0.0  # outlier dependence
    first_half_r: float = 0.0          # stability across the sample
    second_half_r: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)

    @property
    def is_conclusive(self) -> bool:
        """A confidence interval spanning zero means no conclusion is available.

        Saying so is the correct answer, and it is a different statement from
        'the strategy loses money'.
        """
        return not (self.expectancy_ci_low <= 0.0 <= self.expectancy_ci_high)


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def _stdev(xs: list[float]) -> float:
    if len(xs) < 2:
        return 0.0
    m = _mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def max_drawdown(r_series: list[float]) -> tuple[float, int]:
    """Peak-to-trough on the cumulative R curve. Returns (depth, duration)."""
    peak = 0.0
    equity = 0.0
    peak_idx = 0
    worst = 0.0
    worst_len = 0
    for i, r in enumerate(r_series):
        equity += r
        if equity > peak:
            peak, peak_idx = equity, i
        dd = peak - equity
        if dd > worst:
            worst, worst_len = dd, i - peak_idx
    return worst, worst_len


def streaks(r_series: list[float]) -> tuple[int, int]:
    """(longest losing run, longest winning run), counted in trades."""
    worst = best = cur_l = cur_w = 0
    for r in r_series:
        if r < 0:
            cur_l += 1
            cur_w = 0
        elif r > 0:
            cur_w += 1
            cur_l = 0
        else:
            cur_l = cur_w = 0
        worst = max(worst, cur_l)
        best = max(best, cur_w)
    return worst, best


def compute(r_series: list[float]) -> Metrics:
    m = Metrics()
    n = len(r_series)
    m.trades = n
    if n == 0:
        return m

    wins = [r for r in r_series if r > 0]
    losses = [r for r in r_series if r < 0]
    m.wins, m.losses = len(wins), len(losses)
    m.win_rate = m.wins / n

    m.total_r = sum(r_series)
    m.expectancy_r = _mean(r_series)
    m.stdev_r = _stdev(r_series)

    # 95% CI on the mean. The width is what says whether n is big enough, and
    # it is the number most often omitted from a backtest report.
    if n > 1 and m.stdev_r > 0:
        se = m.stdev_r / math.sqrt(n)
        m.expectancy_ci_low = m.expectancy_r - 1.96 * se
        m.expectancy_ci_high = m.expectancy_r + 1.96 * se
    else:
        m.expectancy_ci_low = m.expectancy_ci_high = m.expectancy_r

    gross_win = sum(wins)
    gross_loss = abs(sum(losses))
    m.profit_factor = (gross_win / gross_loss) if gross_loss > 0 else (
        float("inf") if gross_win > 0 else 0.0)

    m.avg_win_r = _mean(wins)
    m.avg_loss_r = _mean(losses)
    m.largest_win_r = max(wins) if wins else 0.0
    m.largest_loss_r = min(losses) if losses else 0.0

    m.max_drawdown_r, m.max_drawdown_trades = max_drawdown(r_series)
    m.return_over_dd = (m.total_r / m.max_drawdown_r) if m.max_drawdown_r > 0 else 0.0

    m.longest_loss_streak, m.longest_win_streak = streaks(r_series)

    # Remove the five best trades. If the edge goes with them it was a handful
    # of lucky days, not a process.
    if n > 5:
        trimmed = sorted(r_series)[:-5]
        m.expectancy_ex_top5_r = _mean(trimmed)
    else:
        m.expectancy_ex_top5_r = m.expectancy_r

    half = n // 2
    m.first_half_r = sum(r_series[:half])
    m.second_half_r = sum(r_series[half:])
    return m


def monte_carlo(r_series: list[float], sims: int = 5000, seed: int = 12345) -> dict:
    """Bootstrap-resample the trade sequence.

    The historical drawdown is ONE draw from a distribution, and it usually sits
    at the optimistic end of it. Sizing an account for the historical figure is
    how people get surprised by a drawdown the strategy was always capable of.
    """
    if len(r_series) < 10:
        return {"sims": 0, "note": "too few trades for a meaningful resample"}

    rng = random.Random(seed)
    n = len(r_series)
    dds, totals = [], []
    for _ in range(sims):
        sample = [r_series[rng.randrange(n)] for _ in range(n)]
        dd, _ = max_drawdown(sample)
        dds.append(dd)
        totals.append(sum(sample))

    dds.sort()
    totals.sort()

    def pct(xs, p):
        return xs[min(len(xs) - 1, max(0, int(p * len(xs))))]

    return {
        "sims": sims,
        "seed": seed,
        "dd_median_r": pct(dds, 0.50),
        "dd_p95_r": pct(dds, 0.95),
        "dd_p99_r": pct(dds, 0.99),
        "total_r_p05": pct(totals, 0.05),
        "total_r_median": pct(totals, 0.50),
        "prob_negative": sum(1 for t in totals if t < 0) / len(totals),
    }


def summary_line(m: Metrics, label: str = "") -> str:
    """One line carrying sample size and drawdown alongside the return.

    A return figure without those two is a claim, not a result.
    """
    prefix = f"{label}: " if label else ""
    if m.trades == 0:
        return f"{prefix}no trades"
    return (
        f"{prefix}{m.trades} trades | exp {m.expectancy_r:+.3f}R "
        f"[{m.expectancy_ci_low:+.3f}, {m.expectancy_ci_high:+.3f}] | "
        f"PF {m.profit_factor:.2f} | total {m.total_r:+.1f}R | "
        f"maxDD {m.max_drawdown_r:.1f}R | R/DD {m.return_over_dd:.2f} | "
        f"win {m.win_rate:.1%} | "
        f"{'CONCLUSIVE' if m.is_conclusive else 'INCONCLUSIVE (CI spans 0)'}"
    )
