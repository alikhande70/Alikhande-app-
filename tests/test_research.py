"""Tests for metrics, the ledger's Evidence Gate, and the tournament gates."""

import pytest

from alkresearch import metrics as M
from alkresearch import tournament as T
from alkresearch.ledger import EvidenceError, Experiment, Ledger, Status, Tier


# --------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------

def test_expectancy_and_profit_factor_on_known_values():
    m = M.compute([2.0, -1.0, 2.0, -1.0])
    assert m.trades == 4
    assert m.expectancy_r == pytest.approx(0.5)
    assert m.profit_factor == pytest.approx(2.0)
    assert m.win_rate == pytest.approx(0.5)


def test_drawdown_depth_and_duration():
    # +3 then three losses of 1 -> peak 3, trough 0, depth 3 over 3 trades.
    depth, dur = M.max_drawdown([3.0, -1.0, -1.0, -1.0])
    assert depth == pytest.approx(3.0)
    assert dur == 3


def test_a_wide_confidence_interval_is_reported_as_inconclusive():
    """The point of the CI is to say when there is no answer yet.

    'Inconclusive' and 'loses money' are different statements and the system
    must not collapse them.
    """
    m = M.compute([3.0, -1.0, -1.0, 3.0, -1.0, -1.0])
    assert not m.is_conclusive
    assert "INCONCLUSIVE" in M.summary_line(m)


def test_a_tight_positive_sample_is_conclusive():
    m = M.compute([0.5] * 200)
    assert m.is_conclusive


def test_streaks_are_counted_in_trades():
    worst, best = M.streaks([-1, -1, -1, 1, 1, -1, 1, 1, 1, 1])
    assert worst == 3
    assert best == 4


def test_outlier_removal_exposes_a_result_built_on_a_few_trades():
    """Seven small losses and five large wins: positive overall, negative once
    the five are removed."""
    r = [-0.2] * 7 + [10.0] * 5
    m = M.compute(r)
    assert m.expectancy_r > 0
    assert m.expectancy_ex_top5_r < 0


def test_monte_carlo_is_reproducible_for_a_given_seed():
    r = [1.0, -1.0, 2.0, -1.0, -1.0, 1.5] * 5
    a = M.monte_carlo(r, sims=300, seed=7)
    b = M.monte_carlo(r, sims=300, seed=7)
    assert a == b


def test_monte_carlo_declines_on_a_tiny_sample():
    out = M.monte_carlo([1.0, -1.0], sims=100)
    assert out["sims"] == 0


def test_summary_line_always_carries_sample_size_and_drawdown():
    """A return figure without those two is a claim, not a result."""
    line = M.summary_line(M.compute([1.0, -1.0, 2.0] * 40))
    assert "trades" in line and "maxDD" in line


# --------------------------------------------------------------------------
# The Evidence Gate
# --------------------------------------------------------------------------

def _exp(**kw):
    base = dict(hypothesis="h", rejection_criterion="r", strategy="s", params={},
                tier=Tier.T0_SCREEN, data={}, costs={}, metrics={},
                # Any status that asserts the idea survived requires an H0.
                # Supplied here so these tests exercise the evidence gate rather
                # than tripping over the null-hypothesis rule first.
                null_hypothesis="the instrument drifted over the test window")
    base.update(kw)
    return Experiment(**base)


@pytest.mark.parametrize("status", [Status.CHAMPION, Status.CHALLENGER])
def test_screening_evidence_cannot_support_champion_or_challenger(status):
    with pytest.raises(EvidenceError):
        _exp(status=status)


@pytest.mark.parametrize("status", [Status.CANDIDATE, Status.ELIMINATED, Status.SCREENED])
def test_screening_evidence_can_support_the_lower_statuses(status):
    assert _exp(status=status).status is status


def test_tier1_evidence_supports_challenger_but_not_champion():
    """Corrected 2026-09-22. The previous version of this test asserted that a
    Tier-1 backtest could crown a CHAMPION, and it passed - because that was
    audit defect D4, and the test encoded it rather than catching it.

    A Strategy Tester result is enough to compete. It is not enough to win: the
    tester always fills, at zero latency, with no requotes, and applies today's
    symbol spec across all history. Demo-forward evidence is where those
    assumptions meet a real feed. See tests/test_audit_fixes.py for the
    regression that drove the change.
    """
    assert _exp(tier=Tier.T1_TESTER, status=Status.CHALLENGER).status is Status.CHALLENGER
    with pytest.raises(EvidenceError):
        _exp(tier=Tier.T1_TESTER, status=Status.CHAMPION)


def test_an_experiment_needs_a_hypothesis():
    with pytest.raises(ValueError):
        _exp(hypothesis="   ")


def test_an_experiment_needs_a_rejection_criterion():
    """A hypothesis with no way to be wrong is not a hypothesis."""
    with pytest.raises(ValueError):
        _exp(rejection_criterion="")


def test_proxy_data_caveat_is_attached_automatically():
    e = _exp(data={"is_proxy": True, "symbol": "GC=F",
                   "proxy_for": "XAUUSD spot", "caveat": "futures not spot"})
    assert "PROXY DATA" in e.notes
    assert "XAUUSD spot" in e.notes


def test_every_record_pins_the_code_version():
    assert _exp().code_version


# --------------------------------------------------------------------------
# Ledger
# --------------------------------------------------------------------------

def test_ledger_is_append_only_and_queryable(tmp_path):
    led = Ledger(tmp_path / "l.jsonl")
    a = led.append(_exp(strategy="alpha", params={"p": 1},
                        data={"content_hash": "h1"}))
    led.append(_exp(strategy="beta", params={"p": 2}, data={"content_hash": "h2"}))
    assert len(led.all()) == 2
    assert led.already_tried("alpha", {"p": 1}, "h1")["id"] == a.id
    assert led.already_tried("alpha", {"p": 99}, "h1") is None
    assert led.already_tried("alpha", {"p": 1}, "different") is None


def test_superseding_hides_the_old_record_without_deleting_it(tmp_path):
    led = Ledger(tmp_path / "l.jsonl")
    old = led.append(_exp(strategy="alpha"))
    led.append(_exp(strategy="alpha", supersedes=old.id))
    assert len(led.all()) == 2, "the original must still be on disk"
    assert len(led.active()) == 1, "but it must not count as current"


def test_no_champion_without_a_tier1_record(tmp_path):
    led = Ledger(tmp_path / "l.jsonl")
    led.append(_exp(strategy="alpha", status=Status.CANDIDATE))
    assert led.champion() is None
    assert led.summary()["champion"] is None


# --------------------------------------------------------------------------
# Tournament gates
# --------------------------------------------------------------------------

def test_sample_gate_rejects_a_small_sample():
    m = M.compute([1.0, -1.0] * 10)
    assert T.g2_sample(m).result is T.GateResult.FAIL


def test_sample_gate_rejects_a_confidence_interval_spanning_zero():
    m = M.compute(([3.0] + [-1.0] * 3) * 40)      # plenty of trades, wide CI
    r = T.g2_sample(m)
    assert r.result is T.GateResult.FAIL
    assert "spans zero" in r.detail


def test_null_gate_rejects_a_candidate_beaten_by_buy_and_hold():
    """The gold lesson: +0.15R looks fine until long-only scored +0.41R."""
    m = M.compute([0.154] * 200)
    r = T.g3_beats_null(m, always_long_exp=0.413, random_band=(-0.4, 0.3))
    assert r.result is T.GateResult.FAIL
    assert "long-only" in r.detail


def test_null_gate_rejects_a_candidate_inside_the_random_entry_band():
    m = M.compute([0.20] * 200)
    r = T.g3_beats_null(m, always_long_exp=0.0, random_band=(-0.4, 0.32))
    assert r.result is T.GateResult.FAIL
    assert "random-entry" in r.detail


def test_null_gate_passes_a_candidate_clear_of_both():
    m = M.compute([0.50] * 200)
    r = T.g3_beats_null(m, always_long_exp=0.10, random_band=(-0.3, 0.30))
    assert r.result is T.GateResult.PASS


def test_cost_gate_rejects_an_edge_that_dies_at_double_cost():
    assert T.g4_cost_stress(-0.02, 2.0).result is T.GateResult.FAIL
    assert T.g4_cost_stress(0.08, 2.0).result is T.GateResult.PASS


def test_plateau_gate_rejects_a_spike():
    assert T.g6_plateau([0.2, -0.1, -0.3, -0.2, -0.1]).result is T.GateResult.FAIL
    assert T.g6_plateau([0.2, 0.15, 0.18, -0.02, 0.1]).result is T.GateResult.PASS


def test_plateau_gate_skips_when_no_sweep_was_run():
    assert T.g6_plateau([]).result is T.GateResult.SKIP


# --- G7 regressions. The gate originally manufactured passes here. -------

def test_oos_gate_refuses_a_ratio_against_a_near_zero_in_sample():
    """+0.009R in-sample and +0.492R out-of-sample is not 5325% retention.

    It is two numbers, one of which is zero within error. Reporting it as a
    percentage turned nothing into a pass.
    """
    r = T.g7_oos(is_exp=0.009, oos_exp=0.492)
    assert r.result is T.GateResult.FAIL
    assert "indistinguishable from zero" in r.detail


def test_oos_gate_treats_out_of_sample_far_better_than_in_sample_as_suspicious():
    """Robustness looks like similar numbers, not a tenfold jump."""
    r = T.g7_oos(is_exp=0.045, oos_exp=0.455)
    assert r.result is T.GateResult.FAIL
    assert "different markets" in r.detail


def test_oos_gate_rejects_a_negative_in_sample_rescued_out_of_sample():
    r = T.g7_oos(is_exp=-0.053, oos_exp=0.494)
    assert r.result is T.GateResult.FAIL


def test_oos_gate_rejects_decay():
    assert T.g7_oos(is_exp=0.40, oos_exp=0.05).result is T.GateResult.FAIL


def test_oos_gate_passes_similar_numbers():
    r = T.g7_oos(is_exp=0.30, oos_exp=0.24)
    assert r.result is T.GateResult.PASS


def test_monte_carlo_gate_rejects_a_high_probability_of_ending_negative():
    assert T.g8_monte_carlo({"sims": 1000, "prob_negative": 0.58,
                             "dd_p95_r": 18.7}).result is T.GateResult.FAIL
    assert T.g8_monte_carlo({"sims": 1000, "prob_negative": 0.11,
                             "dd_p95_r": 20.3}).result is T.GateResult.PASS


def test_the_real_instrument_gate_is_always_blocked_here():
    """It needs MetaTrader 5. Nothing in this environment can satisfy it, and
    nothing becomes champion without it."""
    assert T.g9_real_instrument().result is T.GateResult.BLOCKED


def test_a_run_reports_the_gate_it_died_at():
    run = T.TournamentRun("x")
    run.add(T.GateReport("G1", T.GateResult.PASS, "fine"))
    run.add(T.GateReport("G2", T.GateResult.FAIL, "too few trades"))
    run.add(T.GateReport("G3", T.GateResult.FAIL, "also bad"))
    assert run.eliminated
    assert run.first_failure.gate == "G2"
    assert "ELIMINATED at G2" in run.verdict()


# --- The anti-confirmation-bias protocol ---------------------------------

def test_a_surviving_candidate_must_state_its_null_hypothesis():
    """H0 is what keeps a promising number honest: the mundane explanation
    that would produce the same result with no edge at all."""
    with pytest.raises(ValueError, match="null_hypothesis"):
        Experiment(hypothesis="h", rejection_criterion="r", strategy="s", params={},
                   tier=Tier.T0_SCREEN, data={}, costs={}, metrics={},
                   status=Status.CANDIDATE)


def test_an_eliminated_idea_needs_no_null_hypothesis():
    """Recording a failure must stay cheap, or failures stop being recorded."""
    e = Experiment(hypothesis="h", rejection_criterion="r", strategy="s", params={},
                   tier=Tier.T0_SCREEN, data={}, costs={}, metrics={},
                   status=Status.ELIMINATED)
    assert e.status is Status.ELIMINATED


def test_h0_ruled_out_by_may_be_empty_and_that_is_honest():
    """Admitting H0 has not been ruled out is the point of the field. What it
    must not do is disappear."""
    e = _exp(status=Status.CANDIDATE)
    assert e.h0_ruled_out_by == ""
    assert e.null_hypothesis
