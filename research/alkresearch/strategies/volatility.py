"""Volatility-regime family.

Shared premise, and the thing to be falsified: that volatility clusters, so a
contraction predicts an expansion, and a position taken in the direction of the
expansion pays.
"""

from __future__ import annotations

from ..engine import ClosedBarView, Intent, Strategy
from .. import indicators as ind


class SqueezeBreakout(Strategy):
    """Enter a breakout only when recent range is compressed.

    Two conditions, deliberately separated: a REGIME condition (current ATR is
    low relative to its own longer average) and a TRIGGER (close beyond the
    recent extreme). Keeping them apart means a failure can be attributed - a
    dead result tells us whether the regime filter or the trigger was wrong,
    which a single fused condition never would.
    """

    name = "squeeze_breakout"

    def __init__(self, atr_fast: int = 10, atr_slow: int = 50, squeeze_ratio: float = 0.85,
                 channel: int = 10, sl_atr: float = 1.5, tp_atr: float = 3.0):
        self.atr_fast, self.atr_slow = atr_fast, atr_slow
        self.squeeze_ratio, self.channel = squeeze_ratio, channel
        self.sl_atr, self.tp_atr = sl_atr, tp_atr

    def params(self) -> dict:
        return {"atr_fast": self.atr_fast, "atr_slow": self.atr_slow,
                "squeeze_ratio": self.squeeze_ratio, "channel": self.channel,
                "sl_atr": self.sl_atr, "tp_atr": self.tp_atr}

    def warmup(self) -> int:
        return self.atr_slow + self.channel + 10

    def evaluate(self, view: ClosedBarView) -> Intent | None:
        fast = ind.atr(view, self.atr_fast, 0)
        slow = ind.atr(view, self.atr_slow, 0)
        if None in (fast, slow) or slow <= 0 or fast <= 0:
            return None

        if fast / slow > self.squeeze_ratio:
            return None                       # not compressed: regime says no

        hi = ind.highest(view, self.channel, 1)
        lo = ind.lowest(view, self.channel, 1)
        if None in (hi, lo):
            return None

        c = view.close(0)
        ratio = fast / slow
        if c > hi:
            return Intent(1, self.sl_atr * fast, self.tp_atr * fast,
                          f"squeeze breakout up (atr ratio {ratio:.2f})")
        if c < lo:
            return Intent(-1, self.sl_atr * fast, self.tp_atr * fast,
                          f"squeeze breakout down (atr ratio {ratio:.2f})")
        return None
