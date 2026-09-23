"""Strategy destruction.

The cell that uses this does not invent strategies. It takes the strongest
surviving candidate and tries to prove it false, and it is scored on whether it
succeeds. That inversion is the point: the person who built a strategy is the
worst person to validate it, not through dishonesty but because they already
know which answer would be nice.

Each attack isolates one explanation that would produce the observed result
with no edge present.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

from . import engine, metrics as M
from .data import Bar, Series


@dataclass
class AttackResult:
    attack: str
    survived: bool
    detail: str
    baseline_r: float = 0.0
    attacked_r: float = 0.0
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"attack": self.attack, "survived": self.survived, "detail": self.detail,
                "baseline_expectancy_r": round(self.baseline_r, 4),
                "attacked_expectancy_r": round(self.attacked_r, 4), "extra": self.extra}


def _expectancy(series: Series, cls, params: dict, costs: engine.CostModel) -> tuple[float, int]:
    try:
        res = engine.run(series, cls(**params), costs)
    except (TypeError, ValueError):
        return (0.0, 0)
    m = M.compute(res.r_series)
    return (m.expectancy_r, m.trades)


# --------------------------------------------------------------------------
# Attacks
# --------------------------------------------------------------------------

def attack_delayed_execution(series: Series, cls, params: dict,
                             costs: engine.CostModel, baseline: float) -> AttackResult:
    """Fill one bar later than the engine does.

    A real edge is not destroyed by being a bar late. A pattern that depends on
    acting instantly at a specific bar usually reflects something about the
    data rather than something about the market - and live execution is never
    instant anyway.
    """
    shifted = Series(series.instrument, series.interval, series.bars[:], series.fetched_at)

    class Delayed(cls):
        _pending = None

        def evaluate(self, view):
            out, self._pending = self._pending, super().evaluate(view)
            return out

    Delayed.__name__ = f"{cls.__name__}Delayed"
    exp, n = _expectancy(shifted, Delayed, params, costs)
    survived = exp > 0 and exp >= baseline * 0.5
    return AttackResult(
        "delayed_execution", survived,
        f"expectancy {exp:+.3f}R with a one-bar execution delay, against a baseline of "
        f"{baseline:+.3f}R over {n} trades. "
        + ("Survives being late." if survived
           else "Collapses when late: the result depended on acting at one exact bar."),
        baseline, exp, {"trades": n},
    )


def attack_adverse_costs(series: Series, cls, params: dict,
                         costs: engine.CostModel, baseline: float,
                         multiples=(1.5, 2.0, 3.0)) -> AttackResult:
    """Widen every cost. Finds the multiple at which the edge dies."""
    death = None
    trail = {}
    for mult in multiples:
        exp, _ = _expectancy(series, cls, params, costs.scaled(mult))
        trail[f"{mult:g}x"] = round(exp, 4)
        if exp <= 0 and death is None:
            death = mult
    survived = death is None or death > 2.0
    return AttackResult(
        "adverse_costs", survived,
        (f"dies at {death:g}x assumed cost" if death else
         f"still positive at {max(multiples):g}x assumed cost")
        + ". Spread doubling is a normal day around a data release, so surviving 2x is "
          "the minimum that means anything.",
        baseline, trail.get("2x", 0.0), trail,
    )


def attack_shuffled_returns(series: Series, cls, params: dict, costs: engine.CostModel,
                            baseline: float, sims: int = 20, seed: int = 4242) -> AttackResult:
    """Destroy the time structure, keep the return distribution.

    Bar-to-bar returns are shuffled and a synthetic price path rebuilt from
    them. Volatility and the shape of the return distribution survive; every
    pattern, trend and cluster does not. A strategy that scores as well on
    shuffled data as on real data is reading the distribution, not the market.
    """
    rng = random.Random(seed)
    bars = series.bars
    rets = [(bars[i].close / bars[i - 1].close) - 1.0
            for i in range(1, len(bars)) if bars[i - 1].close > 0]
    if len(rets) < 100:
        return AttackResult("shuffled_returns", True, "too few bars to shuffle", baseline, 0.0)

    ranges = [(b.high - b.low) / b.close for b in bars if b.close > 0]
    avg_range = sum(ranges) / len(ranges)

    exps = []
    for s in range(sims):
        local = random.Random(seed + s)
        order = rets[:]
        local.shuffle(order)
        px = bars[0].close
        synth = []
        for i, r in enumerate(order):
            nxt = px * (1.0 + r)
            hi = max(px, nxt) * (1.0 + avg_range / 2.0)
            lo = min(px, nxt) * (1.0 - avg_range / 2.0)
            synth.append(Bar(bars[i].ts, px, hi, lo, nxt, 0.0))
            px = nxt
        exp, n = _expectancy(Series(series.instrument, series.interval, synth,
                                    series.fetched_at), cls, params, costs)
        if n > 0:
            exps.append(exp)

    if not exps:
        return AttackResult("shuffled_returns", True, "no trades on shuffled data", baseline, 0.0)

    beaten = sum(1 for e in exps if e >= baseline)
    p = beaten / len(exps)
    survived = p < 0.10
    return AttackResult(
        "shuffled_returns", survived,
        f"{beaten}/{len(exps)} shuffled paths matched or beat the real result "
        f"(p≈{p:.2f}). "
        + ("Real structure appears to matter." if survived
           else "The result is reproducible on data with no time structure at all, so it "
                "is reading the return distribution rather than the market."),
        baseline, sum(exps) / len(exps), {"p_value_approx": round(p, 4), "sims": len(exps)},
    )


def attack_period_split(series: Series, cls, params: dict, costs: engine.CostModel,
                        baseline: float, chunks: int = 4) -> AttackResult:
    """Expectancy per sub-period. A regime-dependent result shows up here."""
    n = len(series.bars)
    size = n // chunks
    if size < 100:
        return AttackResult("period_split", True, "history too short to split", baseline, 0.0)

    per = []
    for i in range(chunks):
        lo = i * size
        hi = n if i == chunks - 1 else (i + 1) * size
        sub = Series(series.instrument, series.interval, series.bars[lo:hi], series.fetched_at)
        exp, cnt = _expectancy(sub, cls, params, costs)
        per.append({"period": f"{sub.bars[0].date_str}..{sub.bars[-1].date_str}",
                    "expectancy_r": round(exp, 4), "trades": cnt})

    positive = sum(1 for p in per if p["expectancy_r"] > 0)
    survived = positive >= chunks - 1
    return AttackResult(
        "period_split", survived,
        f"{positive}/{chunks} sub-periods positive. "
        + ("Broadly consistent across the history." if survived
           else "Concentrated in some periods and absent in others, which is regime "
                "dependence rather than an edge."),
        baseline, sum(p["expectancy_r"] for p in per) / chunks, {"periods": per},
    )


def attack_other_instrument(other: Series, cls, params: dict,
                            other_costs: engine.CostModel, baseline: float) -> AttackResult:
    """The same rules on a different market.

    A premise about how markets behave should not be true of exactly one
    symbol. This is weak evidence either way - instruments genuinely differ -
    but a rule that works on one and fails on every other is usually fitted.

    TAKES THE OTHER INSTRUMENT'S OWN COST MODEL, and the parameter is separate
    from the baseline's for a reason. The first version of this attack reused
    the caller's costs and applied gold's 0.50 spread to EURUSD at 1.14 - a 44%
    spread - producing an expectancy of -41.5R and a confident, entirely false
    verdict that the candidate had been destroyed. Costs are denominated in the
    instrument's own price units and never transfer.
    """
    if other_costs.spread > 0 and other.bars:
        ratio = other_costs.spread / other.bars[-1].close
        if ratio > 0.01:
            return AttackResult(
                "other_instrument", True,
                f"SKIPPED: the supplied cost model implies a spread of {ratio:.1%} of price "
                f"on {other.instrument.symbol}, which is not a plausible cost. Pass that "
                "instrument's own cost model.",
                baseline, 0.0, {"instrument": other.instrument.key, "skipped": True},
            )

    exp, n = _expectancy(other, cls, params, other_costs)
    survived = exp > 0
    return AttackResult(
        "other_instrument", survived,
        f"expectancy {exp:+.3f}R over {n} trades on {other.instrument.symbol}. "
        + ("The premise is not unique to one symbol." if survived
           else "Does not transfer; the rule may be fitted to one instrument's history."),
        baseline, exp, {"instrument": other.instrument.key, "trades": n},
    )


def attack_parameter_instability(series: Series, cls, params: dict,
                                 costs: engine.CostModel, baseline: float) -> AttackResult:
    """Dispersion across the parameter neighbourhood.

    A plateau means neighbours behave similarly. Wide dispersion around a good
    centre means the centre was selected, not discovered.
    """
    from .screen import neighbours
    exps = []
    for variant in neighbours(cls, params):
        exp, n = _expectancy(series, cls, variant, costs)
        if n > 0:
            exps.append(exp)
    if not exps:
        return AttackResult("parameter_instability", True, "no neighbours produced trades",
                            baseline, 0.0)

    mean = sum(exps) / len(exps)
    spread = max(exps) - min(exps)
    positive = sum(1 for e in exps if e > 0)
    # A centre standing well above its own neighbourhood is a spike.
    survived = positive >= 0.6 * len(exps) and baseline <= mean + spread * 0.5
    return AttackResult(
        "parameter_instability", survived,
        f"{positive}/{len(exps)} neighbours positive; neighbourhood mean {mean:+.3f}R, "
        f"spread {spread:.3f}R, centre {baseline:+.3f}R. "
        + ("The centre sits on a plateau." if survived
           else "The centre stands above its own neighbourhood: a spike, i.e. a selected "
                "parameter rather than a discovered one."),
        baseline, mean, {"neighbours": len(exps), "spread_r": round(spread, 4)},
    )


# --------------------------------------------------------------------------
# Campaign
# --------------------------------------------------------------------------

def run_campaign(series: Series, cls, params: dict, costs: engine.CostModel,
                 other: Series | None = None,
                 other_costs: engine.CostModel | None = None) -> dict:
    """Every attack. A candidate is only as strong as its weakest survival.

    `other_costs` must be the OTHER instrument's cost model. Omitting it skips
    the cross-instrument attack rather than running it with the wrong costs -
    a skipped attack is honest, a wrong one is worse than none.
    """
    baseline, n = _expectancy(series, cls, params, costs)

    attacks = [
        attack_adverse_costs(series, cls, params, costs, baseline),
        attack_delayed_execution(series, cls, params, costs, baseline),
        attack_shuffled_returns(series, cls, params, costs, baseline),
        attack_period_split(series, cls, params, costs, baseline),
        attack_parameter_instability(series, cls, params, costs, baseline),
    ]
    if other is not None:
        if other_costs is None:
            attacks.append(AttackResult(
                "other_instrument", True,
                "SKIPPED: no cost model supplied for the other instrument. Reusing this "
                "instrument's costs would produce a false verdict.",
                baseline, 0.0, {"skipped": True}))
        else:
            attacks.append(attack_other_instrument(other, cls, params, other_costs, baseline))

    failed = [a for a in attacks if not a.survived]
    return {
        "baseline_expectancy_r": round(baseline, 4),
        "baseline_trades": n,
        "attacks": [a.to_dict() for a in attacks],
        "survived_all": not failed,
        "failed_attacks": [a.attack for a in failed],
        "weakest_point": (failed[0].detail if failed else
                          "survived every attack run; the weakest point is that none of "
                          "this is Tier-1 evidence on the real instrument"),
    }
