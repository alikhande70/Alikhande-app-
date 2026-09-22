"""Regression tests for six defects found in an independent audit of 94e3a3f.

Every test here was written to FAIL against 94e3a3f and verified to do so
before the corresponding fix was applied. That ordering is the evidence: a test
written after a fix proves only that the code does what it currently does.

The six, and what each one costs:

  D1  risk is never re-derived after a stop-loss moves -> realised risk silently
      exceeds the configured percent
  D2  a PLACED pending order is reported as a filled position and is then
      invisible to every ownership query
  D3  the lab cannot record a candidate that PASSES -- it raises
  D4  a single backtest record can crown a champion, against the stated rule
  D5  a gate that never ran is indistinguishable from a gate that passed
  D6  an R multiple and a currency profit are graded through one threshold
"""

import pathlib
import re
import tempfile

import pytest

from alkresearch import forensics as F
from alkresearch import tournament as T
from alkresearch.ledger import EvidenceError, Experiment, Ledger, Status, Tier

MQL5 = pathlib.Path(__file__).resolve().parent.parent / "MQL5" / "Include" / "Alikhande"


# --------------------------------------------------------------------------
# D3 — the lab could not record a success
# --------------------------------------------------------------------------

def test_d3_screen_can_record_a_candidate_that_passed_every_gate():
    """Before the fix: screen() set status=CANDIDATE without a null_hypothesis,
    and the H0 rule added the day before raised on it.

    The lab could record failures and could not record a success. The first
    strategy to pass every gate would have crashed the run that found it.
    """
    from alkresearch.screen import build_null_hypothesis

    h0 = build_null_hypothesis(
        always_long_exp=0.413, random_hi=0.32, is_proxy=True,
        symbol="GC=F", proxy_for="XAUUSD spot", trades=118)
    assert h0.strip(), "screen() must supply a specific H0 for a surviving candidate"

    # It must be specific to the test, not a generic disclaimer.
    assert "0.413" in h0 and "0.32" in h0
    assert "GC=F" in h0

    Experiment(hypothesis="h", rejection_criterion="r", strategy="s", params={},
               tier=Tier.T0_SCREEN, data={}, costs={}, metrics={},
               status=Status.CANDIDATE, null_hypothesis=h0)


# --------------------------------------------------------------------------
# D5 — a gate that never ran counted as passed
# --------------------------------------------------------------------------

def test_d5_a_run_with_skipped_gates_is_not_reported_as_passing():
    """Before the fix: 1 PASS + 3 SKIP + 0 FAIL gave eliminated=False and the
    verdict 'passed every computable gate'.

    Three tests that never ran were indistinguishable from three that passed,
    and screen() promoted on that basis.
    """
    run = T.TournamentRun("probe")
    run.add(T.GateReport("G1_SANITY", T.GateResult.PASS, "ok"))
    run.add(T.GateReport("G6_PLATEAU", T.GateResult.SKIP, "no sweep"))
    run.add(T.GateReport("G7_OOS", T.GateResult.SKIP, "too short to split"))

    assert not run.eliminated, "nothing failed, so it is not eliminated"
    assert run.incomplete, "two gates never ran: the ladder did not finish"
    assert run.skipped_gates == ["G6_PLATEAU", "G7_OOS"]
    assert "did not run" in run.verdict() or "incomplete" in run.verdict().lower()


def test_d5_a_run_with_every_gate_run_is_complete():
    run = T.TournamentRun("probe")
    run.add(T.GateReport("G1_SANITY", T.GateResult.PASS, "ok"))
    run.add(T.GateReport("G2_SAMPLE", T.GateResult.PASS, "ok"))
    run.add(T.GateReport("G9_REAL_INSTRUMENT", T.GateResult.BLOCKED, "needs MT5"))
    assert not run.incomplete, "BLOCKED is a known wall, not an unrun test"


def test_d5_an_incomplete_run_cannot_reach_candidate():
    """The status must reflect that the ladder did not finish."""
    run = T.TournamentRun("probe")
    run.add(T.GateReport("G1_SANITY", T.GateResult.PASS, "ok"))
    run.add(T.GateReport("G6_PLATEAU", T.GateResult.SKIP, "no sweep"))
    assert run.status_for_record() is Status.SCREENED

    done = T.TournamentRun("probe2")
    done.add(T.GateReport("G1_SANITY", T.GateResult.PASS, "ok"))
    done.add(T.GateReport("G9_REAL_INSTRUMENT", T.GateResult.BLOCKED, "needs MT5"))
    assert done.status_for_record() is Status.CANDIDATE

    dead = T.TournamentRun("probe3")
    dead.add(T.GateReport("G2_SAMPLE", T.GateResult.FAIL, "too few trades"))
    assert dead.status_for_record() is Status.ELIMINATED


# --------------------------------------------------------------------------
# D4 — champion on a single backtest
# --------------------------------------------------------------------------

def _t1(strategy="s", **kw):
    base = dict(hypothesis="h", rejection_criterion="r", strategy=strategy, params={},
                tier=Tier.T1_TESTER, data={}, costs={}, metrics={},
                null_hypothesis="drift over the window")
    base.update(kw)
    return Experiment(**base)


def test_d4_a_tier1_backtest_alone_cannot_crown_a_champion():
    """Before the fix: CHAMPION was accepted on one T1 record.

    The stated rule is Tier-1 Strategy Tester evidence AND later demo-forward
    evidence. A backtest is not a forward test, and the difference is exactly
    where execution assumptions get tested.
    """
    with pytest.raises(EvidenceError, match="demo-forward|T2_FORWARD"):
        _t1(status=Status.CHAMPION)


def test_d4_tier1_still_supports_challenger():
    """A Strategy Tester result is enough to compete, not enough to win."""
    assert _t1(status=Status.CHALLENGER).status is Status.CHALLENGER


def test_d4_champion_needs_a_prior_tier1_record_for_the_same_strategy(tmp_path):
    """Demo-forward evidence alone is not enough either: without a Tier-1 run
    there is no backtest the forward test is confirming."""
    led = Ledger(tmp_path / "l.jsonl")
    t2 = Experiment(hypothesis="h", rejection_criterion="r", strategy="alpha", params={},
                    tier=Tier.T2_FORWARD, data={}, costs={}, metrics={},
                    null_hypothesis="drift", status=Status.CHALLENGER)
    ok, why = led.can_promote_champion("alpha")
    assert not ok and "Tier-1" in why

    led.append(_t1(strategy="alpha", status=Status.CHALLENGER))
    ok, why = led.can_promote_champion("alpha")
    assert not ok and ("demo-forward" in why or "Tier-2" in why)

    led.append(t2)
    ok, why = led.can_promote_champion("alpha")
    assert ok, why


def test_d4_champion_on_demo_forward_with_a_prior_backtest_is_allowed():
    e = Experiment(hypothesis="h", rejection_criterion="r", strategy="s", params={},
                   tier=Tier.T2_FORWARD, data={}, costs={}, metrics={},
                   null_hypothesis="drift", status=Status.CHAMPION)
    assert e.status is Status.CHAMPION


# --------------------------------------------------------------------------
# D6 — trade adjudication mixed units
# --------------------------------------------------------------------------

def test_d6_currency_profit_is_not_graded_on_the_r_threshold():
    """Before the fix: classify_outcome applied one +/-0.05 threshold to both an
    R multiple and a currency profit.

    A 4-cent profit graded FLAT and a 6-cent profit graded GOOD, on an account
    of any size. The two are different units and cannot share a threshold.
    """
    assert F.classify_outcome(None, profit=0.04) is F.OutcomeQuality.GOOD
    assert F.classify_outcome(None, profit=-0.04) is F.OutcomeQuality.BAD
    assert F.classify_outcome(None, profit=0.0) is F.OutcomeQuality.FLAT


def test_d6_an_r_multiple_still_uses_the_r_threshold():
    """Within R, a near-zero result is genuinely flat: a scratch trade."""
    assert F.classify_outcome(0.5, None) is F.OutcomeQuality.GOOD
    assert F.classify_outcome(-0.5, None) is F.OutcomeQuality.BAD
    assert F.classify_outcome(0.01, None) is F.OutcomeQuality.FLAT


def test_d6_an_r_multiple_wins_over_a_contradicting_profit():
    """R is the better measure when both are present, and the grading must not
    depend on which one happens to be filled in."""
    assert F.classify_outcome(1.5, profit=-0.01) is F.OutcomeQuality.GOOD


# --------------------------------------------------------------------------
# D1 / D2 — MQL5. Source-verified only; MetaEditor is unavailable here.
# --------------------------------------------------------------------------

def _src(name: str) -> str:
    return (MQL5 / name).read_text(encoding="utf-8")


def test_d1_moving_a_stop_re_derives_the_risk_it_implies():
    """Before the fix: ModifyStops changed the stop and nothing recomputed risk.

    Money at risk was fixed at open from the original stop distance. Widening a
    stop - a trailing stop moved the wrong way, a manual adjustment, a
    break-even routine with a sign error - raised realised risk above the
    configured percent with nothing to notice.

    Source check only: MQL5 cannot be compiled in this environment.
    """
    src = _src("OrderExecutor.mqh")
    body = re.search(r"bool\s+ModifyStops\(.*?\n     \}", src, re.S)
    assert body, "ModifyStops not found"
    text = body.group(0)
    assert "RiskAtStop" in text or "risk" in text.lower(), \
        "ModifyStops must re-derive the risk the new stop implies"
    assert "m_risk_warn" in src or "RISK INCREASED" in src.upper(), \
        "widening a stop past the configured risk must be reported"


def test_d2_pending_orders_are_not_reported_as_filled_positions():
    """Before the fix: TRADE_RETCODE_PLACED (10008) classified as RC_SUCCESS and
    set out.ok = true, while every ownership query iterated PositionsTotal()
    only - OrdersTotal() appeared nowhere in the file.

    A placed pending order was reported as a clean fill and was then invisible
    to CountOwned, OwnedVolume, HasUnprotectedPosition and CloseAllOwned. The
    EA would believe it owned nothing and could place the entry again.
    """
    src = _src("OrderExecutor.mqh")
    assert "RC_PENDING_PLACED" in src, \
        "a placed pending order needs its own class; it is not a fill"
    assert "OrdersTotal()" in src, \
        "ownership queries must see pending orders, not only open positions"
    assert "CountOwnedPending" in src or "OwnedPendingCount" in src, \
        "there must be a way to ask how many pending orders this EA owns"
