"""Null-hypothesis strategies. These exist to be compared against, not traded.

THE MOST IMPORTANT FILE IN THE STRATEGIES DIRECTORY.

A backtest result means nothing in isolation. The question is never "did it
make money" but "did it make more money than the same risk structure with no
information in the entry". Random entry with identical stops, targets, sizing
and costs isolates exactly that: whatever it earns is what the EXIT STRUCTURE
and the cost model produce on this data, with zero predictive content.

A candidate that cannot beat random entry has no entry edge, however good its
equity curve looks on its own.
"""

from __future__ import annotations

import random

from ..engine import ClosedBarView, Intent, Strategy
from .. import indicators as ind


class RandomEntry(Strategy):
    """Enter in a random direction with a fixed probability per bar.

    Matched to a candidate's ATR-based stop and target so the comparison
    isolates the entry rule and nothing else. Seeded, so a recorded result is
    reproducible.
    """

    name = "null_random_entry"

    def __init__(self, prob: float = 0.05, atr_period: int = 14,
                 sl_atr: float = 2.0, tp_atr: float = 4.0, seed: int = 1):
        self.prob = prob
        self.atr_period, self.sl_atr, self.tp_atr = atr_period, sl_atr, tp_atr
        self.seed = seed
        self._rng = random.Random(seed)

    def params(self) -> dict:
        return {"prob": self.prob, "atr_period": self.atr_period,
                "sl_atr": self.sl_atr, "tp_atr": self.tp_atr, "seed": self.seed}

    def warmup(self) -> int:
        return self.atr_period + 5

    def evaluate(self, view: ClosedBarView) -> Intent | None:
        a = ind.atr(view, self.atr_period, 0)
        if a is None or a <= 0:
            return None
        if self._rng.random() >= self.prob:
            return None
        d = 1 if self._rng.random() < 0.5 else -1
        return Intent(d, self.sl_atr * a, self.tp_atr * a, f"random entry (seed {self.seed})")


class AlwaysLong(Strategy):
    """Buy-and-hold-ish benchmark, re-entering after every stop or target.

    Separates "the strategy has an edge" from "the instrument went up". On a
    decade of gold that distinction is not academic.
    """

    name = "null_always_long"

    def __init__(self, atr_period: int = 14, sl_atr: float = 2.0, tp_atr: float = 4.0):
        self.atr_period, self.sl_atr, self.tp_atr = atr_period, sl_atr, tp_atr

    def params(self) -> dict:
        return {"atr_period": self.atr_period, "sl_atr": self.sl_atr, "tp_atr": self.tp_atr}

    def warmup(self) -> int:
        return self.atr_period + 5

    def evaluate(self, view: ClosedBarView) -> Intent | None:
        a = ind.atr(view, self.atr_period, 0)
        if a is None or a <= 0:
            return None
        return Intent(1, self.sl_atr * a, self.tp_atr * a, "always long")
