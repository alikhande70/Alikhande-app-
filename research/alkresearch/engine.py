"""Tier-0 screening backtest engine.

WHAT THIS IS FOR: killing bad ideas cheaply, so that only ideas which survive
cost real Strategy Tester time. A pass here means "not yet falsified". It is
not evidence of an edge on the owner's instrument and the ledger will not let
it be recorded as one.

Three design choices do most of the work, and each exists because of a
specific way backtests lie:

1. LOOK-AHEAD IS STRUCTURALLY IMPOSSIBLE, not merely discouraged. The strategy
   never receives the bar list. It receives a ClosedBarView that raises on any
   attempt to read a bar it should not be able to see yet. A strategy with a
   look-ahead bug fails loudly instead of producing an excellent equity curve.

2. FILLS HAPPEN ON THE NEXT BAR'S OPEN. A signal computed from a bar that
   closed at 17:00 cannot be filled at that same close - the close is only
   knowable once it has happened. Entering at the signal bar's close is the
   single most common way a screening backtest invents profit.

3. WHEN BOTH STOP AND TARGET ARE REACHABLE INSIDE ONE BAR, THE STOP WINS. The
   bar says the price visited both levels; it does not say in which order.
   Assuming the good one is how "profitable" strategies are manufactured, so
   this engine always assumes the bad one.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict

from .data import Bar, Series


class LookAheadError(RuntimeError):
    """A strategy tried to read a bar that had not closed yet."""


# --------------------------------------------------------------------------
# The view a strategy is allowed to see
# --------------------------------------------------------------------------

class ClosedBarView:
    """Read-only window over bars[0 .. last_closed].

    Indexing is BY SHIFT, matching MQL5's convention so a strategy written here
    translates to the MQL5 side without an off-by-one: shift 0 is the most
    recent CLOSED bar, shift 1 the one before it. There is deliberately no way
    to reach the forming bar, because in this engine it does not exist yet.
    """

    __slots__ = ("_bars", "_last")

    def __init__(self, bars: list[Bar], last_closed: int):
        self._bars = bars
        self._last = last_closed

    def __len__(self) -> int:
        return self._last + 1

    def bar(self, shift: int) -> Bar:
        if shift < 0:
            raise LookAheadError(
                f"shift {shift} is in the future. Shift 0 is the last CLOSED bar."
            )
        idx = self._last - shift
        if idx < 0:
            raise IndexError(f"shift {shift} reaches before the start of history")
        return self._bars[idx]

    def close(self, shift: int) -> float: return self.bar(shift).close
    def open(self, shift: int) -> float:  return self.bar(shift).open
    def high(self, shift: int) -> float:  return self.bar(shift).high
    def low(self, shift: int) -> float:   return self.bar(shift).low

    def closes(self, count: int, shift: int = 0) -> list[float]:
        """`count` closes ending at `shift`, oldest first."""
        return [self.close(shift + i) for i in range(count - 1, -1, -1)]

    def highs(self, count: int, shift: int = 0) -> list[float]:
        return [self.high(shift + i) for i in range(count - 1, -1, -1)]

    def lows(self, count: int, shift: int = 0) -> list[float]:
        return [self.low(shift + i) for i in range(count - 1, -1, -1)]

    def has(self, count: int) -> bool:
        """Enough closed history for a `count`-bar lookback."""
        return len(self) >= count


# --------------------------------------------------------------------------
# Intents, costs, trades
# --------------------------------------------------------------------------

@dataclass
class Intent:
    """What a strategy wants. Distances, never prices - same contract as the
    MQL5 CSignalBase, so the two sides cannot drift apart."""

    direction: int            # +1 long, -1 short
    sl_distance: float        # price delta from entry, must be > 0
    tp_distance: float = 0.0  # price delta from entry, 0 = no target
    reason: str = ""

    def __post_init__(self):
        if self.direction not in (1, -1):
            raise ValueError("direction must be +1 or -1")
        if self.sl_distance <= 0:
            raise ValueError("sl_distance must be > 0: a trade without a stop is not modelled")


@dataclass
class CostModel:
    """Costs as ASSUMPTIONS, stated explicitly.

    The screening data carries no bid/ask, so none of this is measured. The
    defaults are deliberately pessimistic: an edge that only survives optimistic
    costs is not an edge, and finding that out here is free.
    """

    spread: float = 0.0           # price units, full spread (crossed on entry AND exit)
    commission: float = 0.0       # price-equivalent cost per round turn
    slippage: float = 0.0         # price units, applied against us on every fill
    slippage_on_stop: float = 0.0 # extra, applied only on stop exits

    def entry_price(self, direction: int, raw: float) -> float:
        """A buy pays the ask, a sell receives the bid. Slippage always hurts."""
        half = self.spread / 2.0
        return raw + direction * (half + self.slippage)

    def exit_price(self, direction: int, raw: float, on_stop: bool) -> float:
        half = self.spread / 2.0
        slip = self.slippage + (self.slippage_on_stop if on_stop else 0.0)
        return raw - direction * (half + slip)

    def scaled(self, factor: float) -> "CostModel":
        """For cost-stress runs at 1.5x and 2x."""
        return CostModel(self.spread * factor, self.commission * factor,
                         self.slippage * factor, self.slippage_on_stop * factor)

    def describe(self) -> dict:
        return asdict(self)


@dataclass
class Trade:
    entry_ts: int
    exit_ts: int
    direction: int
    entry_price: float
    exit_price: float
    sl_price: float
    tp_price: float
    risk_per_unit: float       # |entry - sl| at entry: the R denominator
    gross_points: float
    cost_points: float
    net_points: float
    r_multiple: float
    exit_reason: str           # "stop" | "target" | "signal" | "end_of_data"
    bars_held: int
    reason: str = ""

    def as_row(self) -> dict:
        return asdict(self)


@dataclass
class BacktestResult:
    strategy: str
    params: dict
    trades: list[Trade] = field(default_factory=list)
    bars_tested: int = 0
    period: tuple[str, str] = ("", "")
    costs: dict = field(default_factory=dict)
    data_provenance: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    @property
    def r_series(self) -> list[float]:
        return [t.r_multiple for t in self.trades]

    def net_r(self) -> float:
        return sum(self.r_series)


# --------------------------------------------------------------------------
# The strategy contract
# --------------------------------------------------------------------------

class Strategy:
    """Mirrors the MQL5 CSignalBase contract deliberately.

    `evaluate` sees only closed bars and returns a distance-based Intent, so a
    strategy that screens well here can be ported to MQL5 without changing what
    it means.
    """

    name = "unnamed"

    def params(self) -> dict:
        """Everything that would change the result. Goes into the ledger, so an
        omission here makes the experiment irreproducible."""
        return {}

    def warmup(self) -> int:
        """Closed bars needed before the first evaluation is meaningful."""
        return 1

    def evaluate(self, view: ClosedBarView) -> Intent | None:
        raise NotImplementedError

    def exit_signal(self, view: ClosedBarView, direction: int, bars_held: int) -> bool:
        """Optional discretionary exit, checked on each bar close while in a
        position. Default: positions leave only via stop or target."""
        return False


# --------------------------------------------------------------------------
# The engine
# --------------------------------------------------------------------------

def run(series: Series, strategy: Strategy, costs: CostModel | None = None,
        max_bars_in_trade: int = 0) -> BacktestResult:
    """Walk the series once, bar by bar, honouring the three rules above."""
    costs = costs or CostModel()
    bars = series.bars
    res = BacktestResult(
        strategy=strategy.name,
        params=strategy.params(),
        bars_tested=len(bars),
        period=series.period,
        costs=costs.describe(),
        data_provenance=series.provenance(),
    )

    if series.instrument.is_proxy:
        res.warnings.append(
            f"PROXY INSTRUMENT: {series.instrument.symbol} stands in for "
            f"{series.instrument.proxy_for}. {series.instrument.caveat}"
        )
    if costs.spread <= 0 and costs.commission <= 0:
        res.warnings.append(
            "ZERO COST MODEL: results are gross and cannot be compared against "
            "anything tradable."
        )

    warmup = max(1, strategy.warmup())

    # Open position state
    in_pos = False
    direction = 0
    entry_price = sl_price = tp_price = risk_unit = 0.0
    entry_ts = 0
    entry_idx = 0
    entry_reason = ""

    # i indexes the bar being EXECUTED in. Signals come from bar i-1, which has
    # closed. This offset is the whole of rule 2 and is not configurable.
    for i in range(warmup + 1, len(bars)):
        bar = bars[i]

        if in_pos:
            bars_held = i - entry_idx
            exit_px = None
            exit_why = ""

            hit_stop = (bar.low <= sl_price) if direction > 0 else (bar.high >= sl_price)
            hit_tp = False
            if tp_price > 0:
                hit_tp = (bar.high >= tp_price) if direction > 0 else (bar.low <= tp_price)

            if hit_stop:
                # A gap through the stop fills at the open, not at the stop. This
                # is where real money is lost and where optimistic engines pretend
                # the stop held.
                gapped = (bar.open < sl_price) if direction > 0 else (bar.open > sl_price)
                raw = bar.open if gapped else sl_price
                exit_px = costs.exit_price(direction, raw, on_stop=True)
                exit_why = "stop"
            elif hit_tp:
                exit_px = costs.exit_price(direction, tp_price, on_stop=False)
                exit_why = "target"
            elif max_bars_in_trade and bars_held >= max_bars_in_trade:
                exit_px = costs.exit_price(direction, bar.close, on_stop=False)
                exit_why = "max_bars"
            else:
                view = ClosedBarView(bars, i - 1)
                if strategy.exit_signal(view, direction, bars_held):
                    exit_px = costs.exit_price(direction, bar.close, on_stop=False)
                    exit_why = "signal"

            if exit_px is not None:
                res.trades.append(_close(
                    entry_ts, bar.ts, direction, entry_price, exit_px,
                    sl_price, tp_price, risk_unit, costs, exit_why, bars_held,
                    entry_reason))
                in_pos = False
                continue        # one action per bar; no same-bar re-entry

        if not in_pos:
            view = ClosedBarView(bars, i - 1)
            if not view.has(warmup):
                continue
            intent = strategy.evaluate(view)
            if intent is None:
                continue

            direction = intent.direction
            # Filled at THIS bar's open, which is the first price available
            # after the signal bar closed.
            entry_price = costs.entry_price(direction, bar.open)
            risk_unit = intent.sl_distance
            sl_price = entry_price - direction * intent.sl_distance
            tp_price = (entry_price + direction * intent.tp_distance
                        if intent.tp_distance > 0 else 0.0)
            entry_ts = bar.ts
            entry_idx = i
            entry_reason = intent.reason
            in_pos = True

            # THE ENTRY BAR'S OWN RANGE STILL COUNTS. The position was opened at
            # this bar's open, so the rest of this bar can take out the stop or
            # the target before the bar closes. Skipping the entry bar makes
            # every position immune to its own first bar, which quietly removes
            # the worst same-bar outcomes and flatters the result.
            #
            # No gap handling here: we entered at the open, so price reached the
            # stop by travelling to it, not by gapping past it.
            hit_stop = (bar.low <= sl_price) if direction > 0 else (bar.high >= sl_price)
            hit_tp = False
            if tp_price > 0:
                hit_tp = (bar.high >= tp_price) if direction > 0 else (bar.low <= tp_price)

            if hit_stop or hit_tp:
                # Same ambiguity, same pessimistic answer: the bar does not say
                # which came first, so assume the stop.
                if hit_stop:
                    px = costs.exit_price(direction, sl_price, on_stop=True)
                    why = "stop"
                else:
                    px = costs.exit_price(direction, tp_price, on_stop=False)
                    why = "target"
                res.trades.append(_close(
                    entry_ts, bar.ts, direction, entry_price, px, sl_price, tp_price,
                    risk_unit, costs, why, 0, entry_reason))
                in_pos = False

    if in_pos:
        last = bars[-1]
        exit_px = costs.exit_price(direction, last.close, on_stop=False)
        res.trades.append(_close(
            entry_ts, last.ts, direction, entry_price, exit_px, sl_price, tp_price,
            risk_unit, costs, "end_of_data", len(bars) - 1 - entry_idx, entry_reason))
        res.warnings.append("Final position closed at end of data, not by the rules.")

    return res


def _close(entry_ts, exit_ts, direction, entry_px, exit_px, sl, tp,
           risk_unit, costs: CostModel, why, bars_held, reason) -> Trade:
    gross = (exit_px - entry_px) * direction
    net = gross - costs.commission
    # R is measured against the risk the strategy ASKED for. Measuring against
    # the realised loss would flatter every gapped stop, because a stop that
    # slipped would report a smaller R loss than it actually cost.
    r = net / risk_unit if risk_unit > 0 else 0.0
    return Trade(
        entry_ts=entry_ts, exit_ts=exit_ts, direction=direction,
        entry_price=entry_px, exit_price=exit_px, sl_price=sl, tp_price=tp,
        risk_per_unit=risk_unit, gross_points=gross, cost_points=costs.commission,
        net_points=net, r_multiple=r, exit_reason=why, bars_held=bars_held,
        reason=reason,
    )
