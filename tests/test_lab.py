"""Tests for the four work cells' infrastructure: queue, sentinel, red team, forensics."""

import pathlib
import tempfile

import pytest

from alkresearch import engine, redteam
from alkresearch import forensics as F
from alkresearch import integrity
from alkresearch.data import Bar, Instrument, Series
from alkresearch.ledger import Experiment, Ledger, Status, Tier
from alkresearch.queue import ItemState, Queue, QueueItem, ResearchQueue

INST = Instrument(key="T", source="t", symbol="T", description="synthetic")


def tmp_queue():
    return ResearchQueue(pathlib.Path(tempfile.mkdtemp()) / "q.json")


def tmp_ledger():
    return Ledger(pathlib.Path(tempfile.mkdtemp()) / "l.jsonl")


def item(title, queue=Queue.NEW_HYPOTHESIS, priority=3, **kw):
    kw.setdefault("information_gain", "whether X holds")
    return QueueItem(title, queue, priority, **kw)


# --------------------------------------------------------------------------
# Research Queue
# --------------------------------------------------------------------------

def test_an_item_must_say_what_would_be_learned():
    """An item whose information gain cannot be stated is busywork with a ticket."""
    with pytest.raises(ValueError):
        QueueItem("do something", Queue.NEW_HYPOTHESIS, 1, information_gain="  ")


def test_closing_an_item_requires_a_resolution():
    with pytest.raises(ValueError):
        QueueItem("t", Queue.NEW_HYPOTHESIS, 1, information_gain="x", state=ItemState.DROPPED)
    ok = QueueItem("t", Queue.NEW_HYPOTHESIS, 1, information_gain="x",
                   state=ItemState.DROPPED, resolution="superseded by a better test")
    assert ok.state is ItemState.DROPPED


def test_hourly_rescans_do_not_flood_the_queue():
    """The Sentinel runs 24 times a day and would otherwise re-raise everything."""
    q = tmp_queue()
    assert q.add(item("Fix the gate")) is not None
    assert q.add(item("fix the GATE")) is None
    assert len(q.open_items()) == 1


def test_the_measurement_apparatus_outranks_new_ideas_at_equal_priority():
    """An experiment run on a broken engine gives a confident wrong answer."""
    q = tmp_queue()
    q.add(item("New idea", Queue.NEW_HYPOTHESIS, 2))
    q.add(item("Audit engine", Queue.ENGINE_AUDIT, 2))
    assert q.next_item().queue is Queue.ENGINE_AUDIT


def test_a_blocked_item_is_skipped_but_not_lost():
    q = tmp_queue()
    q.add(item("Compile in MetaEditor", Queue.ENGINE_AUDIT, 1, blocked_reason="needs the owner"))
    q.add(item("Screen a new family", Queue.NEW_HYPOTHESIS, 3))
    assert q.next_item().queue is Queue.NEW_HYPOTHESIS
    assert len(q.open_items()) == 2


def test_a_queue_with_only_blocked_items_counts_as_blocked():
    q = tmp_queue()
    q.add(item("Owner action", Queue.TRADE_FORENSICS, 1, blocked_reason="no trades yet"))
    assert Queue.TRADE_FORENSICS in q.blocked_queues()


def test_a_cell_can_exclude_its_own_queue_and_still_find_work():
    q = tmp_queue()
    q.add(item("Red team the leader", Queue.RED_TEAM, 1))
    q.add(item("Check data", Queue.DATA_QUALITY, 2))
    assert q.next_item(exclude={Queue.RED_TEAM}).queue is Queue.DATA_QUALITY


def test_the_queue_round_trips_through_disk():
    path = pathlib.Path(tempfile.mkdtemp()) / "q.json"
    q = ResearchQueue(path)
    q.add(item("Persisted", Queue.DATA_QUALITY, 1))
    q.save()
    assert ResearchQueue(path).open_items()[0].title == "Persisted"


# --------------------------------------------------------------------------
# Sentinel
# --------------------------------------------------------------------------

def _rec(**kw):
    base = dict(hypothesis="h", rejection_criterion="r", strategy="s", params={},
                tier=Tier.T0_SCREEN, data={"content_hash": "h1"}, costs={}, metrics={})
    base.update(kw)
    return Experiment(**base)


def test_a_live_candidate_with_no_benchmarks_is_flagged():
    led = tmp_ledger()
    led.append(_rec(status=Status.CANDIDATE, null_hypothesis="could be drift",
                    metrics={"expectancy_r": 0.2}))
    checks = {f.check for f in integrity.check_missing_evidence(led)}
    assert "missing_benchmarks" in checks


def test_an_eliminated_record_is_not_asked_for_benchmarks():
    """Recording failures must stay cheap or they stop being recorded."""
    led = tmp_ledger()
    led.append(_rec(status=Status.ELIMINATED))
    assert integrity.check_missing_evidence(led) == []


def test_a_candidate_beaten_by_buy_and_hold_is_flagged():
    """The finding that killed the first promising result on this project."""
    led = tmp_ledger()
    led.append(_rec(status=Status.CANDIDATE, null_hypothesis="drift",
                    metrics={"expectancy_r": 0.154},
                    benchmarks={"always_long_expectancy_r": 0.413,
                                "random_entry_band_r": [-0.4, 0.3]}))
    checks = {f.check for f in integrity.check_drift_mistaken_for_edge(led)}
    assert "drift_as_edge" in checks


def test_a_candidate_inside_the_random_band_is_flagged():
    led = tmp_ledger()
    led.append(_rec(status=Status.CANDIDATE, null_hypothesis="noise",
                    metrics={"expectancy_r": 0.20},
                    benchmarks={"always_long_expectancy_r": 0.0,
                                "random_entry_band_r": [-0.4, 0.32]}))
    checks = {f.check for f in integrity.check_random_equivalent(led)}
    assert "random_equivalent" in checks


def test_a_very_strong_result_is_treated_as_a_suspect():
    led = tmp_ledger()
    led.append(_rec(status=Status.ELIMINATED, metrics={"expectancy_r": 1.2}))
    findings = integrity.check_suspicious_results(led)
    assert findings and findings[0].queue is Queue.RED_TEAM


def test_an_ordinary_result_is_not_flagged_as_suspicious():
    led = tmp_ledger()
    led.append(_rec(status=Status.ELIMINATED, metrics={"expectancy_r": 0.12}))
    assert integrity.check_suspicious_results(led) == []


def test_an_identical_rerun_on_the_same_code_is_flagged_as_duplicate():
    led = tmp_ledger()
    for _ in range(2):
        led.append(_rec(code_version="abc1234"))
    assert {f.check for f in integrity.check_duplicates(led)} == {"duplicate_experiment"}


def test_a_rerun_after_a_code_change_is_legitimate():
    """Re-running after an engine fix is correct and must not be nagged about."""
    led = tmp_ledger()
    led.append(_rec(code_version="abc1234"))
    led.append(_rec(code_version="def5678"))
    assert integrity.check_duplicates(led) == []


def test_every_finding_converts_to_an_actionable_queue_item():
    led = tmp_ledger()
    led.append(_rec(status=Status.ELIMINATED, metrics={"expectancy_r": 1.5}))
    for f in integrity.check_suspicious_results(led):
        it = f.to_item()
        assert it.information_gain and it.source.startswith("sentinel:")


# --------------------------------------------------------------------------
# Red team
# --------------------------------------------------------------------------

def mk_series(n=400, inst=INST):
    bars, px = [], 100.0
    for i in range(n):
        px *= 1.0 + (0.004 if i % 3 else -0.005)
        bars.append(Bar(1_600_000_000 + i * 86400, px, px * 1.01, px * 0.99, px, 0.0))
    return Series(inst, "1d", bars, "test")


class Dummy(engine.Strategy):
    name = "dummy"

    def __init__(self, lookback: int = 5, sl_atr: float = 2.0, tp_atr: float = 4.0):
        self.lookback, self.sl_atr, self.tp_atr = lookback, sl_atr, tp_atr

    def params(self):
        return {"lookback": self.lookback, "sl_atr": self.sl_atr, "tp_atr": self.tp_atr}

    def warmup(self):
        return self.lookback + 5

    def evaluate(self, view):
        if not view.has(self.lookback + 1):
            return None
        if view.close(0) > max(view.highs(self.lookback, 1)):
            return engine.Intent(1, view.close(0) * 0.02, view.close(0) * 0.04, "up")
        return None


def test_the_cross_instrument_attack_refuses_an_implausible_cost_model():
    """The bug this guards against produced a confident, entirely false verdict.

    Gold's 0.50 spread applied to EURUSD at 1.14 is a 44% spread, and it
    reported the candidate destroyed at -41.5R per trade.
    """
    fx = Instrument(key="FX", source="t", symbol="FX", description="cheap instrument")
    series = mk_series(inst=fx)
    for b in series.bars:
        object.__setattr__(b, "close", 1.14)
    gold_costs = engine.CostModel(spread=0.50)
    res = redteam.attack_other_instrument(series, Dummy, Dummy().params(), gold_costs, 0.1)
    assert res.extra.get("skipped") is True
    assert "not a plausible cost" in res.detail


def test_a_campaign_without_the_other_instrument_costs_skips_rather_than_guesses():
    s = mk_series()
    out = redteam.run_campaign(s, Dummy, Dummy().params(), engine.CostModel(spread=0.1),
                               other=mk_series())
    other = [a for a in out["attacks"] if a["attack"] == "other_instrument"][0]
    assert other["extra"].get("skipped") is True


def test_a_campaign_names_a_weakest_point_even_when_everything_survives():
    s = mk_series()
    out = redteam.run_campaign(s, Dummy, Dummy().params(), engine.CostModel(spread=0.1))
    assert out["weakest_point"]
    if out["survived_all"]:
        assert "Tier-1" in out["weakest_point"]


def test_the_shuffled_returns_attack_always_explains_itself():
    """Three legitimate outcomes, and each must say which one it is.

    Producing no trades on structureless data is itself informative - it means
    the rule needs real structure to fire - so it is a result, not an error.
    """
    s = mk_series()
    r = redteam.attack_shuffled_returns(s, Dummy, Dummy().params(),
                                        engine.CostModel(spread=0.1), 0.1, sims=5)
    assert ("p_value_approx" in r.extra
            or "too few bars" in r.detail
            or "no trades on shuffled data" in r.detail)
    assert r.detail


# --------------------------------------------------------------------------
# Forensics — the structural hindsight guard
# --------------------------------------------------------------------------

def test_decision_facts_physically_cannot_hold_an_outcome():
    """The guarantee is the type, not the discipline.

    If a profit field ever appears here, hindsight can reach the decision
    classifier and this module stops doing the one thing it exists for.
    """
    fields = set(F.DecisionFacts.__dataclass_fields__)
    assert not fields & {"profit", "r_multiple", "exit_price", "result", "outcome"}


def test_identical_decisions_classify_identically_whatever_the_outcome():
    """A winner and a loser taken the same way get the same decision grade."""
    facts = F.DecisionFacts(followed_rules=True, had_stop=True, setup_name="x",
                            planned_risk_pct=1.0, actual_risk_pct=1.0)
    win = F.assess(F.TradeRecord("journal", "S", 1, "2026-01-01T10:00:00Z",
                                 "2026-01-01T12:00:00Z", 0.1, decision=facts, r_multiple=3.0))
    loss = F.assess(F.TradeRecord("journal", "S", 1, "2026-01-02T10:00:00Z",
                                  "2026-01-02T12:00:00Z", 0.1, decision=facts, r_multiple=-1.0))
    assert win.decision_quality is loss.decision_quality is F.DecisionQuality.GOOD
    assert win.outcome_quality is F.OutcomeQuality.GOOD
    assert loss.outcome_quality is F.OutcomeQuality.BAD


def test_a_rule_break_that_won_is_still_a_bad_decision():
    """The most dangerous cell in the grid: it pays for doing the wrong thing."""
    t = F.assess(F.TradeRecord("journal", "S", 1, "2026-01-01T10:00:00Z",
                               "2026-01-01T12:00:00Z", 0.1,
                               decision=F.DecisionFacts(followed_rules=False, had_stop=True,
                                                        setup_name="x"),
                               r_multiple=5.0))
    assert t.quadrant == "BAD_DECISION / GOOD_OUTCOME"


def test_trading_without_a_stop_is_a_bad_decision_however_it_ends():
    t = F.assess(F.TradeRecord("journal", "S", 1, "2026-01-01T10:00:00Z",
                               "2026-01-01T11:00:00Z", 0.1,
                               decision=F.DecisionFacts(followed_rules=True, had_stop=False,
                                                        setup_name="x"),
                               r_multiple=2.0))
    assert t.decision_quality is F.DecisionQuality.BAD


def test_an_unplanned_trade_is_unknown_not_good():
    """Absent a plan, the honest answer is that we cannot tell - and inferring
    it from the result is the exact failure this module prevents."""
    t = F.assess(F.TradeRecord("mt5_history", "S", 1, "2026-01-01T10:00:00Z",
                               "2026-01-01T11:00:00Z", 0.1, r_multiple=4.0))
    assert t.decision_quality is F.DecisionQuality.UNKNOWN


def test_oversizing_is_caught_even_on_a_winner():
    t = F.assess(F.TradeRecord("journal", "S", 1, "2026-01-01T10:00:00Z",
                               "2026-01-01T11:00:00Z", 0.1,
                               decision=F.DecisionFacts(followed_rules=True, had_stop=True,
                                                        setup_name="x", planned_risk_pct=0.5,
                                                        actual_risk_pct=2.0),
                               r_multiple=1.0))
    assert t.decision_quality is F.DecisionQuality.BAD
    assert any("deviated" in r for r in t.assessment_reasons)


def test_an_ordinary_loss_on_a_good_decision_is_not_a_failure():
    """A 40%-win-rate system produces losses as designed. Calling those failures
    is how a working system gets tinkered to death."""
    t = F.assess(F.TradeRecord("journal", "S", 1, "2026-01-01T10:00:00Z",
                               "2026-01-01T11:00:00Z", 0.1,
                               decision=F.DecisionFacts(followed_rules=True, had_stop=True,
                                                        setup_name="x"),
                               r_multiple=-1.0, exit_reason="stop"))
    assert t.failure_kind is F.FailureKind.STATISTICAL


def test_giving_back_a_large_open_profit_is_classed_as_an_exit_error():
    t = F.assess(F.TradeRecord("journal", "S", 1, "2026-01-01T10:00:00Z",
                               "2026-01-01T11:00:00Z", 0.1,
                               decision=F.DecisionFacts(followed_rules=True, had_stop=True,
                                                        setup_name="x"),
                               r_multiple=-1.0, mfe_r=2.5, exit_reason="stop"))
    assert t.failure_kind is F.FailureKind.EXIT


def test_a_winning_trade_has_no_failure_kind():
    t = F.assess(F.TradeRecord("journal", "S", 1, "2026-01-01T10:00:00Z",
                               "2026-01-01T11:00:00Z", 0.1,
                               decision=F.DecisionFacts(followed_rules=True, had_stop=True,
                                                        setup_name="x"),
                               r_multiple=2.0))
    assert t.failure_kind is F.FailureKind.NONE


def test_the_forensics_ledger_is_append_only():
    led = F.ForensicsLedger(pathlib.Path(tempfile.mkdtemp()) / "t.jsonl")
    for r in (1.0, -1.0):
        led.append(F.assess(F.TradeRecord(
            "journal", "S", 1, "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z", 0.1,
            decision=F.DecisionFacts(followed_rules=True, had_stop=True, setup_name="x"),
            r_multiple=r)))
    assert len(led.all()) == 2
    assert sum(led.quadrants().values()) == 2


def test_pattern_search_declines_on_too_little_data():
    out = F.find_patterns([])
    assert out[0]["pattern"] == "insufficient_data"


def test_every_pattern_is_labelled_correlation_not_cause():
    """With a dozen dimensions and a few hundred trades, some bucket differs by
    chance. The output must never let that read as a finding."""
    trades = []
    for i in range(120):
        long = i % 2 == 0
        trades.append(F.assess(F.TradeRecord(
            "journal", "S", 1 if long else -1,
            f"2026-01-{(i % 28) + 1:02d}T10:00:00Z", f"2026-01-{(i % 28) + 1:02d}T11:00:00Z",
            0.1, decision=F.DecisionFacts(followed_rules=True, had_stop=True, setup_name="x",
                                          session="london" if long else "asian"),
            r_multiple=1.0 if long else -1.0)))
    patterns = F.find_patterns(trades)
    assert patterns
    for p in patterns:
        assert p["causal"] is False
        assert "CORRELATION" in p["detail"].upper()
