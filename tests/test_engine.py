"""Tests for the screening engine.

The three properties tested first are the three that decide whether a backtest
is honest or fiction: no look-ahead, fills after the signal, and the pessimistic
choice when a bar is ambiguous. Everything else is arithmetic.
"""

import pytest

from alkresearch.data import Bar, Instrument, Series
from alkresearch.engine import (ClosedBarView, CostModel, Intent, LookAheadError,
                                Strategy, run)

INST = Instrument(key="TEST", source="test", symbol="TEST", description="synthetic")


def mk_series(rows):
    """rows: (open, high, low, close) tuples, one per day."""
    bars = [Bar(1_600_000_000 + i * 86400, o, h, l, c, 0.0)
            for i, (o, h, l, c) in enumerate(rows)]
    return Series(INST, "1d", bars, "test")


def flat(n, price=100.0):
    return [(price, price + 0.5, price - 0.5, price)] * n


# --------------------------------------------------------------------------
# The look-ahead guarantee
# --------------------------------------------------------------------------

def test_view_refuses_negative_shift():
    """Shift -1 is the forming bar. Asking for it is the bug this prevents."""
    view = ClosedBarView([Bar(0, 1, 2, 0.5, 1.5)], 0)
    with pytest.raises(LookAheadError):
        view.bar(-1)


def test_view_cannot_reach_past_the_last_closed_bar():
    bars = [Bar(i, 1, 2, 0.5, 1.5) for i in range(10)]
    view = ClosedBarView(bars, 4)
    assert len(view) == 5
    assert view.bar(0) is bars[4]      # shift 0 is the last CLOSED bar
    assert view.bar(4) is bars[0]
    with pytest.raises(IndexError):
        view.bar(5)


def test_view_shift_matches_mql5_convention():
    """Shift 0 = most recent closed, shift 1 = the one before.

    If this drifts, a strategy screened here means something different when
    ported to MQL5, which is worse than not screening it at all.
    """
    bars = [Bar(i, 0, 0, 0, float(i)) for i in range(5)]
    view = ClosedBarView(bars, 4)
    assert view.close(0) == 4.0
    assert view.close(1) == 3.0
    assert view.closes(3) == [2.0, 3.0, 4.0]     # oldest first


def test_a_strategy_reading_the_future_fails_loudly():
    class Cheater(Strategy):
        name = "cheater"
        def warmup(self): return 2
        def evaluate(self, view):
            view.bar(-1)                          # tomorrow's bar
            return None

    with pytest.raises(LookAheadError):
        run(mk_series(flat(10)), Cheater())


# --------------------------------------------------------------------------
# Fills happen after the signal
# --------------------------------------------------------------------------

class BuyOnce(Strategy):
    name = "buy_once"

    def __init__(self, sl=1.0, tp=0.0):
        self.fired = False
        self.sl, self.tp = sl, tp

    def warmup(self): return 2

    def evaluate(self, view):
        if self.fired:
            return None
        self.fired = True
        return Intent(1, self.sl, self.tp, "test")


def test_entry_uses_the_next_bar_open_not_the_signal_close():
    """The signal bar closes at 100; the next bar opens at 110.

    An engine that fills at 100 is inventing 10 points that were never
    available, which is the commonest way a screening backtest manufactures an
    edge.
    """
    rows = flat(3) + [(110.0, 111.0, 109.0, 110.5)] + flat(5, 110.0)
    res = run(mk_series(rows), BuyOnce(sl=50.0))
    assert len(res.trades) == 1
    assert res.trades[0].entry_price == pytest.approx(110.0)


def test_stop_wins_when_both_levels_are_inside_one_bar():
    """The bar visited both the stop and the target. It does not say in which
    order, so the engine must assume the bad one."""
    rows = flat(3) + [(100.0, 106.0, 94.0, 100.0)] + flat(5)
    res = run(mk_series(rows), BuyOnce(sl=5.0, tp=5.0))
    assert len(res.trades) == 1
    assert res.trades[0].exit_reason == "stop"
    assert res.trades[0].r_multiple < 0


def test_a_gap_through_the_stop_fills_at_the_open_not_the_stop():
    """Entry at 100, stop at 95, and the next bar opens at 80.

    Reality fills at 80. An engine that fills at 95 hides the worst thing that
    actually happens to stops.
    """
    rows = flat(3) + [(100.0, 100.5, 99.5, 100.0)] + [(80.0, 81.0, 79.0, 80.0)] + flat(3, 80.0)
    res = run(mk_series(rows), BuyOnce(sl=5.0))
    t = res.trades[0]
    assert t.exit_reason == "stop"
    assert t.exit_price < 95.0, "filled at the stop price despite a gap through it"
    assert t.r_multiple < -1.0, "a gapped stop must cost more than 1R"


# --------------------------------------------------------------------------
# Costs
# --------------------------------------------------------------------------

def test_costs_always_work_against_the_trade():
    c = CostModel(spread=1.0, slippage=0.5)
    assert c.entry_price(1, 100.0) == pytest.approx(101.0)    # buy pays more
    assert c.entry_price(-1, 100.0) == pytest.approx(99.0)    # sell receives less
    assert c.exit_price(1, 100.0, on_stop=False) == pytest.approx(99.0)
    assert c.exit_price(-1, 100.0, on_stop=False) == pytest.approx(101.0)


def test_stop_exits_carry_extra_slippage():
    c = CostModel(spread=0.0, slippage=0.1, slippage_on_stop=0.4)
    normal = c.exit_price(1, 100.0, on_stop=False)
    stopped = c.exit_price(1, 100.0, on_stop=True)
    assert stopped < normal


def test_scaling_costs_scales_every_component():
    c = CostModel(spread=1.0, commission=2.0, slippage=3.0, slippage_on_stop=4.0).scaled(2.0)
    assert (c.spread, c.commission, c.slippage, c.slippage_on_stop) == (2.0, 4.0, 6.0, 8.0)


def test_zero_cost_run_is_flagged():
    res = run(mk_series(flat(20)), BuyOnce(sl=1.0), CostModel())
    assert any("ZERO COST" in w for w in res.warnings)


def test_proxy_instrument_is_flagged_on_every_result():
    proxy = Instrument(key="P", source="t", symbol="GC=F", description="d",
                       proxy_for="XAUUSD spot", caveat="futures not spot")
    series = Series(proxy, "1d", mk_series(flat(20)).bars, "test")
    res = run(series, BuyOnce(sl=1.0), CostModel(spread=0.1))
    assert any("PROXY INSTRUMENT" in w for w in res.warnings)


# --------------------------------------------------------------------------
# Contract
# --------------------------------------------------------------------------

def test_an_intent_without_a_stop_is_refused():
    with pytest.raises(ValueError):
        Intent(1, 0.0)
    with pytest.raises(ValueError):
        Intent(1, -5.0)


def test_direction_must_be_long_or_short():
    with pytest.raises(ValueError):
        Intent(0, 1.0)


def test_r_is_measured_against_requested_risk_not_realised_loss():
    """A gapped stop must report worse than -1R.

    Measuring R against the realised loss would make every gap look like a
    clean -1R, hiding exactly the risk that gaps represent.
    """
    rows = flat(3) + [(100.0, 100.5, 99.5, 100.0)] + [(70.0, 71.0, 69.0, 70.0)] + flat(3, 70.0)
    res = run(mk_series(rows), BuyOnce(sl=5.0))
    assert res.trades[0].risk_per_unit == pytest.approx(5.0)
    assert res.trades[0].r_multiple < -5.0
