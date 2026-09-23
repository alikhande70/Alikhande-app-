"""Indicators over a ClosedBarView.

Every function here takes the view and a shift, so it is impossible to compute
an indicator from a bar that has not closed. That is the point: an indicator
helper that takes a raw price list is exactly where look-ahead sneaks back in.
"""

from __future__ import annotations

import math

from .engine import ClosedBarView


def sma(view: ClosedBarView, period: int, shift: int = 0) -> float | None:
    if not view.has(period + shift):
        return None
    return sum(view.closes(period, shift)) / period


def ema(view: ClosedBarView, period: int, shift: int = 0) -> float | None:
    """Seeded with an SMA over the first `period` bars, then smoothed forward.

    Uses 3x the period of history so the seed has decayed to insignificance;
    an EMA seeded on too little history differs materially from the same EMA in
    MetaTrader, and then a screened result will not reproduce there.
    """
    span = period * 3
    if not view.has(span + shift):
        return None
    closes = view.closes(span, shift)
    k = 2.0 / (period + 1.0)
    val = sum(closes[:period]) / period
    for c in closes[period:]:
        val = c * k + val * (1.0 - k)
    return val


def true_range(view: ClosedBarView, shift: int = 0) -> float | None:
    if not view.has(shift + 2):
        return None
    h, l = view.high(shift), view.low(shift)
    prev_c = view.close(shift + 1)
    return max(h - l, abs(h - prev_c), abs(l - prev_c))


def atr(view: ClosedBarView, period: int, shift: int = 0) -> float | None:
    """Simple average of true ranges. Wilder smoothing differs slightly; the
    simple form is used here and stated, so the MQL5 side can match it."""
    if not view.has(period + shift + 2):
        return None
    trs = [true_range(view, shift + i) for i in range(period)]
    if any(t is None for t in trs):
        return None
    return sum(trs) / period


def stdev(view: ClosedBarView, period: int, shift: int = 0) -> float | None:
    if not view.has(period + shift):
        return None
    xs = view.closes(period, shift)
    m = sum(xs) / period
    return math.sqrt(sum((x - m) ** 2 for x in xs) / period)


def highest(view: ClosedBarView, period: int, shift: int = 0) -> float | None:
    if not view.has(period + shift):
        return None
    return max(view.highs(period, shift))


def lowest(view: ClosedBarView, period: int, shift: int = 0) -> float | None:
    if not view.has(period + shift):
        return None
    return min(view.lows(period, shift))


def roc(view: ClosedBarView, period: int, shift: int = 0) -> float | None:
    """Rate of change over `period` bars, as a fraction."""
    if not view.has(period + shift + 1):
        return None
    now = view.close(shift)
    then = view.close(shift + period)
    return (now - then) / then if then else None
