"""Mean-reversion family.

Shared premise, and the thing to be falsified: that a stretch away from a
reference tends to retrace by more than costs, often enough to pay.
"""

from __future__ import annotations

from ..engine import ClosedBarView, Intent, Strategy
from .. import indicators as ind


class BandFade(Strategy):
    """Fade a close beyond N standard deviations of an SMA.

    Trades AGAINST the immediate move, so it is structurally the opposite of
    the trend family. Testing both on the same data and the same gates is the
    point: at most one of the two premises can hold on a given instrument and
    timeframe, and possibly neither.
    """

    name = "band_fade"

    def __init__(self, period: int = 20, entry_sd: float = 2.0, atr_period: int = 14,
                 sl_atr: float = 2.0, tp_atr: float = 2.0, exit_at_mean: bool = True):
        self.period, self.entry_sd = period, entry_sd
        self.atr_period, self.sl_atr, self.tp_atr = atr_period, sl_atr, tp_atr
        self.exit_at_mean = exit_at_mean

    def params(self) -> dict:
        return {"period": self.period, "entry_sd": self.entry_sd,
                "atr_period": self.atr_period, "sl_atr": self.sl_atr,
                "tp_atr": self.tp_atr, "exit_at_mean": self.exit_at_mean}

    def warmup(self) -> int:
        return self.period + self.atr_period + 5

    def evaluate(self, view: ClosedBarView) -> Intent | None:
        mid = ind.sma(view, self.period, 0)
        sd = ind.stdev(view, self.period, 0)
        a = ind.atr(view, self.atr_period, 0)
        if None in (mid, sd, a) or sd <= 0 or a <= 0:
            return None

        c = view.close(0)
        upper = mid + self.entry_sd * sd
        lower = mid - self.entry_sd * sd

        if c > upper:
            return Intent(-1, self.sl_atr * a, self.tp_atr * a,
                          f"close {self.entry_sd}sd above SMA{self.period}")
        if c < lower:
            return Intent(1, self.sl_atr * a, self.tp_atr * a,
                          f"close {self.entry_sd}sd below SMA{self.period}")
        return None

    def exit_signal(self, view: ClosedBarView, direction: int, bars_held: int) -> bool:
        if not self.exit_at_mean:
            return False
        mid = ind.sma(view, self.period, 0)
        if mid is None:
            return False
        c = view.close(0)
        return c >= mid if direction > 0 else c <= mid
