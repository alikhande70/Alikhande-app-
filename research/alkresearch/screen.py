"""The screening battery: run every computable gate and record the result.

This is the unit of work the scheduled research cycle performs. One call takes
a strategy and an instrument and produces a ledger record containing the
hypothesis, the evidence, every gate outcome, and the verdict - including when
the verdict is "eliminated", which is the common case and the point.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import engine, metrics as M, tournament as T
from .data import Series
from .ledger import Experiment, Ledger, Status, Tier
from .strategies.null import AlwaysLong, RandomEntry

#: In-sample / out-of-sample split, fixed here rather than chosen per run.
#: The last 30% of history is never used for development.
OOS_FRACTION = 0.30
RANDOM_SEEDS = tuple(range(1, 11))


@dataclass
class NullBaseline:
    always_long_exp: float
    random_lo: float
    random_hi: float
    random_mean: float
    random_trades_mean: float

    def to_dict(self) -> dict:
        return {
            "always_long_expectancy_r": round(self.always_long_exp, 4),
            "random_entry_band_r": [round(self.random_lo, 4), round(self.random_hi, 4)],
            "random_entry_mean_r": round(self.random_mean, 4),
            "random_entry_mean_trades": round(self.random_trades_mean, 1),
            "note": (
                "A candidate must beat the long-only benchmark (else it is measuring "
                "instrument drift) AND sit outside the random-entry band (else its entry "
                "rule carries no information)."
            ),
        }


def null_baseline(series: Series, costs: engine.CostModel,
                  sl_atr: float, tp_atr: float) -> NullBaseline:
    """Benchmarks matched to the candidate's own exit structure.

    Matching matters: comparing a 2xATR-stop candidate against a 1xATR-stop
    benchmark measures the stop, not the entry.
    """
    al = engine.run(series, AlwaysLong(sl_atr=sl_atr, tp_atr=tp_atr), costs)
    al_exp = M.compute(al.r_series).expectancy_r

    exps, counts = [], []
    for seed in RANDOM_SEEDS:
        r = engine.run(series, RandomEntry(prob=0.05, sl_atr=sl_atr, tp_atr=tp_atr,
                                           seed=seed), costs)
        m = M.compute(r.r_series)
        exps.append(m.expectancy_r)
        counts.append(m.trades)

    return NullBaseline(al_exp, min(exps), max(exps),
                        sum(exps) / len(exps), sum(counts) / len(counts))


def neighbours(strategy_cls, params: dict) -> list[dict]:
    """Parameter sets adjacent to the one under test.

    Each numeric parameter is varied alone, down and up. A real edge survives
    small changes to any one of them; fitted noise does not.
    """
    out = []
    for key, val in params.items():
        if isinstance(val, bool) or not isinstance(val, (int, float)):
            continue
        for factor in (0.8, 1.25):
            nv = max(1, int(round(val * factor))) if isinstance(val, int) else round(val * factor, 4)
            if nv == val:
                continue
            variant = dict(params)
            variant[key] = nv
            out.append(variant)
    return out


def _expectancy(series: Series, strategy_cls, params: dict,
                costs: engine.CostModel) -> tuple[float, int]:
    try:
        res = engine.run(series, strategy_cls(**params), costs)
    except (TypeError, ValueError):
        return (0.0, 0)
    m = M.compute(res.r_series)
    return (m.expectancy_r, m.trades)


def build_null_hypothesis(always_long_exp: float, random_hi: float, is_proxy: bool,
                          symbol: str, proxy_for: str | None, trades: int) -> str:
    """The mundane explanation, written from THIS run's own numbers.

    The ledger requires an H0 on any record claiming the idea survived, and
    screen() previously supplied none - so the first candidate to pass every
    gate raised instead of being recorded. The lab could log failures and could
    not log a success.

    Composed rather than templated so it names the actual benchmarks the result
    has to be explained against. A generic "it might be noise" would satisfy the
    field and defeat its purpose.
    """
    parts = [
        f"The result may be instrument drift rather than an entry edge: a long-only "
        f"benchmark on this data scored {always_long_exp:+.3f}R.",
        f"It may be noise: random entry with the same exit structure reached "
        f"{random_hi:+.3f}R at the top of its band.",
    ]
    if trades < 200:
        parts.append(
            f"With {trades} trades the estimate is loose, so part of any advantage is "
            "sampling variation.")
    if is_proxy:
        parts.append(
            f"The data is a PROXY: {symbol} stands in for {proxy_for}, so anything found "
            "here may be a property of the proxy rather than of the traded instrument.")
    parts.append(
        "The cost model is an assumption - this data carries no bid/ask - so the edge may "
        "be an artefact of costs set too low.")
    return " ".join(parts)


def screen(series: Series, strategy_cls, params: dict, costs: engine.CostModel,
           hypothesis: str, rejection_criterion: str,
           ledger: Ledger | None = None, run_sweep: bool = True) -> tuple[Experiment, T.TournamentRun]:
    """Run the full battery. Returns the ledger record and the gate results."""
    strategy = strategy_cls(**params)
    result = engine.run(series, strategy, costs)
    m = M.compute(result.r_series)

    sl_atr = float(params.get("sl_atr", 2.0))
    tp_atr = float(params.get("tp_atr", 4.0))
    nulls = null_baseline(series, costs, sl_atr, tp_atr)

    run = T.TournamentRun(strategy.name)
    run.add(T.g1_sanity(m, result.warnings))
    run.add(T.g2_sample(m))
    run.add(T.g3_beats_null(m, nulls.always_long_exp, (nulls.random_lo, nulls.random_hi)))

    # Cost stress
    stressed_costs = costs.scaled(T.THRESHOLDS.cost_stress_multiple)
    stressed_exp, _ = _expectancy(series, strategy_cls, params, stressed_costs)
    run.add(T.g4_cost_stress(stressed_exp, T.THRESHOLDS.cost_stress_multiple))

    run.add(T.g5_outlier(m))

    # Parameter plateau
    nb_exps: list[float] = []
    if run_sweep:
        for variant in neighbours(strategy_cls, params):
            e, n = _expectancy(series, strategy_cls, variant, costs)
            if n > 0:
                nb_exps.append(e)
    run.add(T.g6_plateau(nb_exps))

    # In-sample / out-of-sample. The split is fixed by OOS_FRACTION, not chosen.
    split = int(len(series.bars) * (1 - OOS_FRACTION))
    if split > 50 and len(series.bars) - split > 50:
        is_series = Series(series.instrument, series.interval, series.bars[:split], series.fetched_at)
        oos_series = Series(series.instrument, series.interval, series.bars[split:], series.fetched_at)
        is_exp, _ = _expectancy(is_series, strategy_cls, params, costs)
        oos_exp, _ = _expectancy(oos_series, strategy_cls, params, costs)
        run.add(T.g7_oos(is_exp, oos_exp))
    else:
        run.add(T.GateReport("G7_OOS", T.GateResult.SKIP, "not enough bars to split"))

    mc = M.monte_carlo(result.r_series)
    run.add(T.g8_monte_carlo(mc))
    run.add(T.g9_real_instrument())

    # The run's own evidence decides the status. An incomplete ladder yields
    # SCREENED, not CANDIDATE - see TournamentRun.status_for_record.
    status = run.status_for_record()
    payload = m.to_dict()
    payload["monte_carlo"] = mc
    payload["neighbour_expectancies"] = [round(e, 4) for e in nb_exps]
    payload["cost_stress_expectancy_r"] = round(stressed_exp, 4)

    h0 = build_null_hypothesis(
        always_long_exp=nulls.always_long_exp, random_hi=nulls.random_hi,
        is_proxy=bool(series.instrument.is_proxy), symbol=series.instrument.symbol,
        proxy_for=series.instrument.proxy_for, trades=m.trades)

    # What the run actually DID about H0. Named gates rather than a claim, so an
    # empty list is visible as an empty list.
    addressed = [r.gate for r in run.reports
                 if r.gate in ("G3_BEATS_NULL", "G4_COST_STRESS", "G5_OUTLIER",
                               "G6_PLATEAU", "G7_OOS", "G8_MONTE_CARLO")
                 and r.result is T.GateResult.PASS]
    ruled_out = ("passed " + ", ".join(addressed)) if addressed else ""

    exp_record = Experiment(
        hypothesis=hypothesis,
        rejection_criterion=rejection_criterion,
        null_hypothesis=h0,
        h0_ruled_out_by=ruled_out,
        strategy=strategy.name,
        params=params,
        tier=Tier.T0_SCREEN,
        data=series.provenance(),
        costs=costs.describe(),
        metrics=payload,
        gates=run.to_dict(),
        benchmarks=nulls.to_dict(),
        verdict=run.verdict(),
        status=status,
        notes="; ".join(result.warnings),
    )
    if ledger is not None:
        ledger.append(exp_record)
    return exp_record, run
