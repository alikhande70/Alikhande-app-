"""Elimination gates.

Thresholds are declared HERE, as constants, and changing one is a reviewable
diff with a date attached. That is the whole mechanism: a threshold adjusted
after seeing a result is not validation, it is negotiation with the data, and
the only defence against it is procedural.

Gate order matters. Cheap, highly discriminating gates run first, so that
expensive analysis is never spent on a candidate that was never going to pass.

G3 (beats the null benchmarks) is placed early because it turned out, on the
first real run of this system, to be the gate that kills almost everything: on
ten years of daily gold, random entry with the same exit structure produced
expectancies from -0.41R to +0.32R, and a long-only benchmark produced +0.41R
because gold tripled. A candidate scoring +0.15R against those is noise, not
an edge, and no amount of later analysis would have revealed that.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class GateResult(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    SKIP = "SKIP"      # not computable with what is available
    BLOCKED = "BLOCKED"  # needs the owner / MetaTrader


@dataclass(frozen=True)
class Thresholds:
    """Fixed before results are seen. Last reviewed 2026-09-20."""

    min_trades: int = 100
    #: Margin by which a candidate must beat the long-only benchmark, in R per
    #: trade. Not zero: beating a benchmark by a hair is within estimation error.
    null_margin_r: float = 0.05
    #: Cost multiple the edge must survive. Spread doubling is a normal Tuesday
    #: around a data release.
    cost_stress_multiple: float = 2.0
    #: Expectancy must stay positive with the five best trades removed.
    min_expectancy_ex_outliers_r: float = 0.0
    #: Fraction of neighbouring parameter sets that must also be positive.
    min_plateau_fraction: float = 0.6
    #: Out-of-sample must retain this fraction of in-sample expectancy.
    min_oos_retention: float = 0.5
    #: Monte Carlo: probability of ending negative must be below this.
    max_prob_negative: float = 0.30
    #: The confidence interval on expectancy must exclude zero.
    require_conclusive: bool = True


THRESHOLDS = Thresholds()


@dataclass
class GateReport:
    gate: str
    result: GateResult
    detail: str
    value: float | None = None
    threshold: float | None = None

    def to_dict(self) -> dict:
        return {"gate": self.gate, "result": self.result.value, "detail": self.detail,
                "value": self.value, "threshold": self.threshold}


@dataclass
class TournamentRun:
    strategy: str
    reports: list[GateReport] = field(default_factory=list)

    def add(self, r: GateReport) -> None:
        self.reports.append(r)

    @property
    def eliminated(self) -> bool:
        return any(r.result == GateResult.FAIL for r in self.reports)

    @property
    def first_failure(self) -> GateReport | None:
        for r in self.reports:
            if r.result == GateResult.FAIL:
                return r
        return None

    @property
    def blocked_at(self) -> GateReport | None:
        for r in self.reports:
            if r.result == GateResult.BLOCKED:
                return r
        return None

    def to_dict(self) -> dict:
        return {r.gate: r.to_dict() for r in self.reports}

    def verdict(self) -> str:
        f = self.first_failure
        if f:
            return f"ELIMINATED at {f.gate}: {f.detail}"
        b = self.blocked_at
        if b:
            return f"SURVIVED screening; blocked at {b.gate}: {b.detail}"
        return "passed every computable gate"


# --------------------------------------------------------------------------
# Gates
# --------------------------------------------------------------------------

def g1_sanity(metrics, warnings: list[str], t: Thresholds = THRESHOLDS) -> GateReport:
    """Did the run produce a trade list that could be checked at all?"""
    if metrics.trades == 0:
        return GateReport("G1_SANITY", GateResult.FAIL,
                          "no trades: the rules never triggered on this data")
    blocking = [w for w in warnings if w.startswith("ZERO COST")]
    if blocking:
        return GateReport("G1_SANITY", GateResult.FAIL,
                          "gross result with no cost model; not comparable to anything tradable")
    return GateReport("G1_SANITY", GateResult.PASS,
                      f"{metrics.trades} trades produced", float(metrics.trades))


def g2_sample(metrics, t: Thresholds = THRESHOLDS) -> GateReport:
    """Enough trades that the result means something, and a CI that excludes zero."""
    if metrics.trades < t.min_trades:
        return GateReport("G2_SAMPLE", GateResult.FAIL,
                          f"{metrics.trades} trades is below the {t.min_trades} minimum; "
                          "the confidence interval swallows any result",
                          float(metrics.trades), float(t.min_trades))
    if t.require_conclusive and not metrics.is_conclusive:
        return GateReport("G2_SAMPLE", GateResult.FAIL,
                          f"expectancy CI [{metrics.expectancy_ci_low:+.3f}, "
                          f"{metrics.expectancy_ci_high:+.3f}] spans zero: no conclusion "
                          "is available, which is different from 'it loses money'",
                          metrics.expectancy_r)
    return GateReport("G2_SAMPLE", GateResult.PASS,
                      f"{metrics.trades} trades, CI excludes zero", float(metrics.trades))


def g3_beats_null(metrics, always_long_exp: float, random_band: tuple[float, float],
                  t: Thresholds = THRESHOLDS) -> GateReport:
    """The gate that does the most work.

    Two separate questions, and a candidate must answer both:
      - does it beat simply holding the instrument? (instrument drift is not edge)
      - is it outside the range that no-information entries produce? (noise is not edge)
    """
    exp = metrics.expectancy_r
    need = always_long_exp + t.null_margin_r

    if exp < need:
        return GateReport("G3_BEATS_NULL", GateResult.FAIL,
                          f"expectancy {exp:+.3f}R does not beat the long-only benchmark "
                          f"{always_long_exp:+.3f}R by the required {t.null_margin_r:.2f}R. "
                          "On a trending instrument this usually means the result was drift.",
                          exp, need)

    lo, hi = random_band
    if exp <= hi:
        return GateReport("G3_BEATS_NULL", GateResult.FAIL,
                          f"expectancy {exp:+.3f}R sits inside the random-entry range "
                          f"[{lo:+.3f}, {hi:+.3f}]: indistinguishable from no information "
                          "in the entry rule",
                          exp, hi)

    return GateReport("G3_BEATS_NULL", GateResult.PASS,
                      f"expectancy {exp:+.3f}R beats long-only {always_long_exp:+.3f}R "
                      f"and exceeds the random-entry band top {hi:+.3f}R", exp, need)


def g4_cost_stress(stressed_expectancy: float, multiple: float,
                   t: Thresholds = THRESHOLDS) -> GateReport:
    """An edge that dies at 2x cost lives inside normal market conditions."""
    if stressed_expectancy <= 0:
        return GateReport("G4_COST_STRESS", GateResult.FAIL,
                          f"expectancy {stressed_expectancy:+.3f}R at {multiple:g}x assumed "
                          "cost: the edge is inside normal cost variation",
                          stressed_expectancy, 0.0)
    return GateReport("G4_COST_STRESS", GateResult.PASS,
                      f"still {stressed_expectancy:+.3f}R at {multiple:g}x cost",
                      stressed_expectancy, 0.0)


def g5_outlier(metrics, t: Thresholds = THRESHOLDS) -> GateReport:
    """Remove the five best trades. If the edge leaves with them it was luck."""
    v = metrics.expectancy_ex_top5_r
    if v <= t.min_expectancy_ex_outliers_r:
        return GateReport("G5_OUTLIER", GateResult.FAIL,
                          f"expectancy without the top 5 winners is {v:+.3f}R: the result "
                          "rests on a handful of trades, not a process",
                          v, t.min_expectancy_ex_outliers_r)
    return GateReport("G5_OUTLIER", GateResult.PASS,
                      f"{v:+.3f}R without the top 5 winners", v)


def g6_plateau(neighbour_expectancies: list[float], t: Thresholds = THRESHOLDS) -> GateReport:
    """Real edges sit on plateaus; fitted noise sits on spikes."""
    if not neighbour_expectancies:
        return GateReport("G6_PLATEAU", GateResult.SKIP, "no parameter sweep supplied")
    positive = sum(1 for e in neighbour_expectancies if e > 0)
    frac = positive / len(neighbour_expectancies)
    if frac < t.min_plateau_fraction:
        return GateReport("G6_PLATEAU", GateResult.FAIL,
                          f"only {positive}/{len(neighbour_expectancies)} neighbouring "
                          f"parameter sets are positive ({frac:.0%}): a spike, not a plateau",
                          frac, t.min_plateau_fraction)
    return GateReport("G6_PLATEAU", GateResult.PASS,
                      f"{positive}/{len(neighbour_expectancies)} neighbours positive ({frac:.0%})",
                      frac, t.min_plateau_fraction)


#: Below this, an in-sample expectancy is treated as indistinguishable from
#: zero and a retention RATIO against it carries no information.
_IS_RATIO_FLOOR_R = 0.02

#: An out-of-sample result this many times the in-sample one is not robustness.
#: It means the two periods were different markets, and the out-of-sample one
#: happened to be the kind this strategy likes.
_OOS_SUSPICION_MULTIPLE = 2.0


def g7_oos(is_exp: float, oos_exp: float, t: Thresholds = THRESHOLDS) -> GateReport:
    """Out-of-sample, looked at once. Looking, adjusting and looking again makes
    it in-sample, and that is the most violated rule in the field.

    Two traps this gate originally fell into, both found by reading its own
    output rather than by a test:

    1. A RATIO AGAINST A NEAR-ZERO DENOMINATOR IS NOISE. An in-sample
       expectancy of +0.009R and an out-of-sample of +0.455R is not "1014%
       retention" - it is two numbers, one of which is zero within error.
       Reporting it as a percentage manufactured a pass out of nothing.

    2. OUT-OF-SAMPLE MUCH BETTER THAN IN-SAMPLE IS A WARNING, NOT A TRIUMPH.
       Robustness looks like similar numbers. A large jump means the two
       periods were different markets - and since the out-of-sample period is
       the RECENT one, it usually means the recent regime flattered the
       strategy. That is the opposite of evidence it will keep working.
    """
    if oos_exp <= 0:
        return GateReport("G7_OOS", GateResult.FAIL,
                          f"out-of-sample expectancy {oos_exp:+.3f}R is not positive "
                          f"(in-sample {is_exp:+.3f}R)", oos_exp, 0.0)

    if abs(is_exp) < _IS_RATIO_FLOOR_R:
        return GateReport("G7_OOS", GateResult.FAIL,
                          f"in-sample expectancy {is_exp:+.3f}R is indistinguishable from "
                          f"zero, so the out-of-sample {oos_exp:+.3f}R rests on a period "
                          "the strategy was never shown to work in. Not a retention "
                          "ratio - two unrelated numbers.",
                          is_exp, _IS_RATIO_FLOOR_R)

    if is_exp <= 0:
        return GateReport("G7_OOS", GateResult.FAIL,
                          f"in-sample expectancy {is_exp:+.3f}R is negative; a positive "
                          f"out-of-sample {oos_exp:+.3f}R is a regime difference, not an edge",
                          is_exp, 0.0)

    retention = oos_exp / is_exp

    if retention > _OOS_SUSPICION_MULTIPLE:
        return GateReport("G7_OOS", GateResult.FAIL,
                          f"out-of-sample {oos_exp:+.3f}R is {retention:.1f}x in-sample "
                          f"{is_exp:+.3f}R. Robustness looks like similar numbers; a jump "
                          "this size means the two periods were different markets and the "
                          "recent one suited the strategy.",
                          retention, _OOS_SUSPICION_MULTIPLE)

    if retention < t.min_oos_retention:
        return GateReport("G7_OOS", GateResult.FAIL,
                          f"out-of-sample {oos_exp:+.3f}R retains {retention:.0%} of "
                          f"in-sample {is_exp:+.3f}R: the difference is the fitting",
                          retention, t.min_oos_retention)

    return GateReport("G7_OOS", GateResult.PASS,
                      f"out-of-sample {oos_exp:+.3f}R vs in-sample {is_exp:+.3f}R "
                      f"({retention:.0%} retention)", retention, t.min_oos_retention)


def g8_monte_carlo(mc: dict, t: Thresholds = THRESHOLDS) -> GateReport:
    """The historical drawdown is one draw from a distribution, usually a kind one."""
    if not mc or mc.get("sims", 0) == 0:
        return GateReport("G8_MONTE_CARLO", GateResult.SKIP,
                          mc.get("note", "not computed"))
    pn = mc["prob_negative"]
    if pn > t.max_prob_negative:
        return GateReport("G8_MONTE_CARLO", GateResult.FAIL,
                          f"{pn:.0%} of resampled sequences end negative "
                          f"(limit {t.max_prob_negative:.0%}); p95 drawdown "
                          f"{mc['dd_p95_r']:.1f}R",
                          pn, t.max_prob_negative)
    return GateReport("G8_MONTE_CARLO", GateResult.PASS,
                      f"{pn:.0%} of sequences end negative; p95 drawdown "
                      f"{mc['dd_p95_r']:.1f}R", pn, t.max_prob_negative)


def g9_real_instrument() -> GateReport:
    """The wall. Everything before this runs here; this one needs MetaTrader 5,
    broker tick data, and the real instrument rather than a proxy."""
    return GateReport("G9_REAL_INSTRUMENT", GateResult.BLOCKED,
                      "requires the MetaTrader 5 Strategy Tester on the real instrument "
                      "with broker tick data. Cannot run in this environment. No candidate "
                      "becomes champion without it.")
