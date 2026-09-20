"""Trend / momentum-continuation family.

Shared premise, and the thing to be falsified: that a move which has already
happened is more likely than chance to continue, by enough to pay costs.
"""

from __future__ import annotations

from ..engine import ClosedBarView, Intent, Strategy
from .. import indicators as ind


class EmaCross(Strategy):
    """Fast EMA crossing slow EMA, ATR-sized stop.

    Present as the REFERENCE, not a contender. It is the strategy already in
    the MQL5 tree, and including it lets the tournament answer a question worth
    answering: is the thing we already built any better than the alternatives?
    """

    name = "ema_cross"

    def __init__(self, fast: int = 20, slow: int = 50, atr_period: int = 14,
                 sl_atr: float = 1.5, tp_atr: float = 3.0):
        self.fast, self.slow = fast, slow
        self.atr_period, self.sl_atr, self.tp_atr = atr_period, sl_atr, tp_atr

    def params(self) -> dict:
        return {"fast": self.fast, "slow": self.slow, "atr_period": self.atr_period,
                "sl_atr": self.sl_atr, "tp_atr": self.tp_atr}

    def warmup(self) -> int:
        return self.slow * 3 + 5

    def evaluate(self, view: ClosedBarView) -> Intent | None:
        f0, s0 = ind.ema(view, self.fast, 0), ind.ema(view, self.slow, 0)
        f1, s1 = ind.ema(view, self.fast, 1), ind.ema(view, self.slow, 1)
        a = ind.atr(view, self.atr_period, 0)
        if None in (f0, s0, f1, s1, a) or a <= 0:
            return None

        up = f1 <= s1 and f0 > s0
        dn = f1 >= s1 and f0 < s0
        if not (up or dn):
            return None

        d = 1 if up else -1
        return Intent(d, self.sl_atr * a, self.tp_atr * a,
                      f"EMA{self.fast} crossed {'above' if up else 'below'} EMA{self.slow}")


class DonchianBreakout(Strategy):
    """Close beyond the N-bar extreme of the PRIOR window.

    The lookback starts at shift 1 so the signal bar's own high cannot be part
    of the level it is breaking - otherwise every bar trivially 'breaks' a
    window that includes itself, and the backtest fills with phantom entries.
    """

    name = "donchian_breakout"

    def __init__(self, channel: int = 20, atr_period: int = 14,
                 sl_atr: float = 2.0, tp_atr: float = 4.0, exit_channel: int = 10):
        self.channel, self.atr_period = channel, atr_period
        self.sl_atr, self.tp_atr = sl_atr, tp_atr
        self.exit_channel = exit_channel

    def params(self) -> dict:
        return {"channel": self.channel, "atr_period": self.atr_period,
                "sl_atr": self.sl_atr, "tp_atr": self.tp_atr,
                "exit_channel": self.exit_channel}

    def warmup(self) -> int:
        return self.channel + self.atr_period + 5

    def evaluate(self, view: ClosedBarView) -> Intent | None:
        hi = ind.highest(view, self.channel, 1)
        lo = ind.lowest(view, self.channel, 1)
        a = ind.atr(view, self.atr_period, 0)
        if None in (hi, lo, a) or a <= 0:
            return None

        c = view.close(0)
        if c > hi:
            return Intent(1, self.sl_atr * a, self.tp_atr * a,
                          f"close above {self.channel}-bar high")
        if c < lo:
            return Intent(-1, self.sl_atr * a, self.tp_atr * a,
                          f"close below {self.channel}-bar low")
        return None

    def exit_signal(self, view: ClosedBarView, direction: int, bars_held: int) -> bool:
        """Leave on an opposite break of a shorter channel - the classic
        turtle-style exit, kept so the family is tested as it is actually used."""
        if direction > 0:
            lo = ind.lowest(view, self.exit_channel, 1)
            return lo is not None and view.close(0) < lo
        hi = ind.highest(view, self.exit_channel, 1)
        return hi is not None and view.close(0) > hi
