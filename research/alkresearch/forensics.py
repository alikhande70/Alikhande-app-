"""Trade forensics: judging decisions separately from outcomes.

THE STRUCTURAL GUARANTEE IN THIS MODULE
---------------------------------------
`classify_decision` is given a DecisionFacts object, which physically cannot
hold the profit, the exit price or the result. Decision quality is therefore
assessed from what was knowable before the trade, because it is impossible for
it to be assessed from anything else.

This is not fussiness. Hindsight is not a bias one can decide not to have:
once the outcome is known it reorganises the memory of the reasoning, and the
trader who reviews a winning trade concludes the plan was sound. Separating the
two into different types makes the correct review the only possible one - the
same approach as SafetyGate.mqh and the ledger's Evidence Gate.

The 2x2 that follows is the whole point of a journal. A good decision with a
bad outcome is the cost of doing business and must not be "fixed". A bad
decision with a good outcome is the most dangerous cell in the grid, because
it pays the trader for doing the wrong thing and the lesson lands backwards.
"""

from __future__ import annotations

import json
import statistics
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

FORENSICS_PATH = Path(__file__).resolve().parent.parent / "experiments" / "trades.jsonl"


class DecisionQuality(str, Enum):
    GOOD = "GOOD_DECISION"
    BAD = "BAD_DECISION"
    UNKNOWN = "UNKNOWN"      # not enough pre-trade information recorded


class OutcomeQuality(str, Enum):
    GOOD = "GOOD_OUTCOME"
    BAD = "BAD_OUTCOME"
    FLAT = "FLAT_OUTCOME"


class FailureKind(str, Enum):
    """Why a trade went wrong, which is a different question from whether it lost.

    Most losses belong in STATISTICAL: a strategy with a 40% win rate produces
    losses as designed, and treating those as failures is how a working system
    gets tinkered to death.
    """

    NONE = "NONE"
    STATISTICAL = "STATISTICAL"        # an ordinary loss from a correctly taken trade
    STRATEGY = "STRATEGY_FAILURE"      # the rules fired and the premise did not hold
    EXECUTION = "EXECUTION_FAILURE"    # slippage, latency, a missed or mis-sent order
    RISK = "RISK_ERROR"                # wrong size, exceeded exposure
    TIMING = "TIMING_ERROR"            # right idea, entered too early or late
    EXIT = "EXIT_ERROR"                # managed the exit against the plan
    RULE_VIOLATION = "RULE_VIOLATION"  # the plan was not followed at all


@dataclass
class DecisionFacts:
    """Everything knowable BEFORE the outcome. Deliberately contains no result.

    Adding a profit field here would silently destroy the guarantee this module
    exists to provide.
    """

    followed_rules: bool | None = None       # did the trade match its stated setup
    planned_entry: float | None = None
    actual_entry: float | None = None
    planned_stop: float | None = None
    actual_stop: float | None = None
    planned_risk_pct: float | None = None
    actual_risk_pct: float | None = None
    setup_name: str = ""
    session: str = ""                        # asian | london | newyork | rollover
    regime: str = ""                         # trend | range | high_vol | low_vol
    atr_at_entry: float | None = None
    spread_at_entry: float | None = None
    entry_slippage: float | None = None
    had_stop: bool | None = None
    notes: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class TradeRecord:
    """One completed trade, from MT5 history, the tester, or the owner's journal."""

    source: str                      # "mt5_history" | "mt5_tester" | "journal"
    symbol: str
    direction: int                   # +1 long, -1 short
    open_time: str
    close_time: str
    volume: float

    decision: DecisionFacts = field(default_factory=DecisionFacts)

    # Outcome side. Never passed to decision classification.
    exit_price: float | None = None
    exit_reason: str = ""
    profit: float | None = None
    r_multiple: float | None = None
    mfe_r: float | None = None       # maximum favourable excursion
    mae_r: float | None = None       # maximum adverse excursion
    exit_slippage: float | None = None
    modifications: int = 0
    duration_minutes: float | None = None

    # Assessment, filled by the classifier
    decision_quality: DecisionQuality = DecisionQuality.UNKNOWN
    outcome_quality: OutcomeQuality = OutcomeQuality.FLAT
    failure_kind: FailureKind = FailureKind.NONE
    assessment_reasons: list[str] = field(default_factory=list)

    id: str = ""
    recorded_at: str = ""

    def __post_init__(self):
        for fld, enum_cls in (("decision_quality", DecisionQuality),
                              ("outcome_quality", OutcomeQuality),
                              ("failure_kind", FailureKind)):
            v = getattr(self, fld)
            if isinstance(v, str):
                setattr(self, fld, enum_cls(v))
        if isinstance(self.decision, dict):
            self.decision = DecisionFacts(**self.decision)
        self.id = self.id or f"trd_{uuid.uuid4().hex[:12]}"
        self.recorded_at = self.recorded_at or datetime.now(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ")

    @property
    def quadrant(self) -> str:
        return f"{self.decision_quality.value} / {self.outcome_quality.value}"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["decision_quality"] = self.decision_quality.value
        d["outcome_quality"] = self.outcome_quality.value
        d["failure_kind"] = self.failure_kind.value
        return d


# --------------------------------------------------------------------------
# Classification
# --------------------------------------------------------------------------

#: How far actual entry/stop/size may drift from plan before it is an error.
ENTRY_TOLERANCE = 0.25      # of the planned stop distance
RISK_TOLERANCE = 0.25       # relative


def classify_decision(facts: DecisionFacts) -> tuple[DecisionQuality, list[str]]:
    """Judge the decision from pre-trade facts ONLY.

    The signature is the guarantee: there is no parameter here through which an
    outcome could arrive.
    """
    reasons: list[str] = []

    if facts.followed_rules is None and not facts.setup_name:
        return (DecisionQuality.UNKNOWN,
                ["no pre-trade plan recorded, so decision quality cannot be judged - "
                 "and judging it from the outcome is precisely what must not happen"])

    bad = False
    if facts.followed_rules is False:
        reasons.append("the trade did not follow its stated setup")
        bad = True

    if facts.had_stop is False:
        reasons.append("no stop loss: unbounded risk regardless of how it ended")
        bad = True

    if (facts.planned_risk_pct and facts.actual_risk_pct
            and facts.planned_risk_pct > 0):
        drift = abs(facts.actual_risk_pct - facts.planned_risk_pct) / facts.planned_risk_pct
        if drift > RISK_TOLERANCE:
            reasons.append(
                f"position size deviated {drift:.0%} from plan "
                f"({facts.actual_risk_pct:.2f}% actual vs {facts.planned_risk_pct:.2f}% planned)")
            bad = True

    if (facts.planned_entry and facts.actual_entry and facts.planned_stop):
        stop_dist = abs(facts.planned_entry - facts.planned_stop)
        if stop_dist > 0:
            drift = abs(facts.actual_entry - facts.planned_entry) / stop_dist
            if drift > ENTRY_TOLERANCE:
                reasons.append(
                    f"entry was {drift:.0%} of the stop distance away from plan - "
                    "the trade taken was not the trade planned")
                bad = True

    if facts.session == "rollover":
        reasons.append("entered during the rollover window, where spreads blow out")
        bad = True

    if not reasons:
        reasons.append("followed the plan: stop present, size and entry within tolerance")
    return (DecisionQuality.BAD if bad else DecisionQuality.GOOD, reasons)


def classify_outcome(r_multiple: float | None, profit: float | None) -> OutcomeQuality:
    v = r_multiple if r_multiple is not None else profit
    if v is None:
        return OutcomeQuality.FLAT
    if v > 0.05:
        return OutcomeQuality.GOOD
    if v < -0.05:
        return OutcomeQuality.BAD
    return OutcomeQuality.FLAT


def classify_failure(trade: TradeRecord) -> tuple[FailureKind, list[str]]:
    """Why it went wrong - asked only of trades that went wrong.

    A good decision that lost is STATISTICAL, not a failure. Getting this wrong
    is how a working system gets optimised into a broken one.
    """
    if trade.outcome_quality is not OutcomeQuality.BAD:
        return (FailureKind.NONE, [])

    d = trade.decision
    if d.followed_rules is False:
        return (FailureKind.RULE_VIOLATION, ["lost on a trade that broke its own rules"])
    if d.had_stop is False:
        return (FailureKind.RISK, ["lost with no stop in place"])

    if (d.planned_risk_pct and d.actual_risk_pct and d.planned_risk_pct > 0
            and abs(d.actual_risk_pct - d.planned_risk_pct) / d.planned_risk_pct > RISK_TOLERANCE):
        return (FailureKind.RISK, ["size deviated materially from plan"])

    if d.entry_slippage is not None and d.atr_at_entry and d.atr_at_entry > 0:
        if abs(d.entry_slippage) > 0.25 * d.atr_at_entry:
            return (FailureKind.EXECUTION,
                    [f"entry slipped {abs(d.entry_slippage)/d.atr_at_entry:.0%} of ATR"])

    if trade.exit_reason and trade.exit_reason not in ("stop", "target", "time"):
        return (FailureKind.EXIT, [f"exited by '{trade.exit_reason}' rather than by the plan"])

    if trade.mfe_r is not None and trade.mfe_r >= 1.5 and (trade.r_multiple or 0) < 0:
        return (FailureKind.EXIT,
                [f"reached {trade.mfe_r:.1f}R in favour before losing: the exit gave it back"])

    if trade.decision_quality is DecisionQuality.GOOD:
        return (FailureKind.STATISTICAL,
                ["a correctly taken trade that lost - the cost of doing business, "
                 "not something to fix"])
    return (FailureKind.STRATEGY, ["the rules fired and the premise did not hold"])


def assess(trade: TradeRecord) -> TradeRecord:
    """Full assessment, in the only safe order: decision first, blind to outcome."""
    dq, reasons = classify_decision(trade.decision)
    trade.decision_quality = dq
    trade.outcome_quality = classify_outcome(trade.r_multiple, trade.profit)
    fk, freasons = classify_failure(trade)
    trade.failure_kind = fk
    trade.assessment_reasons = reasons + freasons
    return trade


# --------------------------------------------------------------------------
# Ledger
# --------------------------------------------------------------------------

class ForensicsLedger:
    """Append-only, like the experiment ledger and for the same reason."""

    def __init__(self, path: Path | None = None):
        self.path = path or FORENSICS_PATH

    def append(self, trade: TradeRecord) -> TradeRecord:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(trade.to_dict(), sort_keys=True) + "\n")
        return trade

    def all(self) -> list[TradeRecord]:
        if not self.path.exists():
            return []
        out = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                out.append(TradeRecord(**json.loads(line)))
        return out

    def quadrants(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for t in self.all():
            counts[t.quadrant] = counts.get(t.quadrant, 0) + 1
        return counts


# --------------------------------------------------------------------------
# Pattern search
# --------------------------------------------------------------------------

#: Below this many trades in a bucket, a difference is not worth reporting.
MIN_BUCKET = 20


def _bucket_stats(rs: list[float]) -> dict:
    return {"n": len(rs), "mean_r": round(statistics.fmean(rs), 4) if rs else 0.0}


def find_patterns(trades: list[TradeRecord]) -> list[dict]:
    """Group expectancy by conditions the owner can act on.

    EVERY RESULT HERE IS A CORRELATION. Nothing in this function can establish
    that a bucket difference is causal - with a dozen dimensions and a few
    hundred trades, some buckets differ by chance alone. The output names the
    question to test next; it does not answer it, and each finding says so.
    """
    out: list[dict] = []
    usable = [t for t in trades if t.r_multiple is not None]
    if len(usable) < MIN_BUCKET * 2:
        return [{"pattern": "insufficient_data",
                 "detail": f"{len(usable)} trades with an R value; at least "
                           f"{MIN_BUCKET * 2} are needed before any split means anything",
                 "causal": False}]

    def split(name: str, keyfn) -> None:
        buckets: dict[str, list[float]] = {}
        for t in usable:
            try:
                k = keyfn(t)
            except Exception:
                continue
            if k is None:
                continue
            buckets.setdefault(str(k), []).append(t.r_multiple)
        big = {k: v for k, v in buckets.items() if len(v) >= MIN_BUCKET}
        if len(big) < 2:
            return
        stats = {k: _bucket_stats(v) for k, v in big.items()}
        best = max(stats, key=lambda k: stats[k]["mean_r"])
        worst = min(stats, key=lambda k: stats[k]["mean_r"])
        gap = stats[best]["mean_r"] - stats[worst]["mean_r"]
        if gap < 0.15:
            return
        out.append({
            "pattern": name,
            "buckets": stats,
            "best": best, "worst": worst, "gap_r": round(gap, 4),
            "causal": False,
            "detail": (f"'{best}' averages {stats[best]['mean_r']:+.3f}R and '{worst}' "
                       f"{stats[worst]['mean_r']:+.3f}R, a gap of {gap:.3f}R. THIS IS A "
                       "CORRELATION. With this many dimensions some gap appears by chance; "
                       "it becomes a finding only if it survives on trades not used to "
                       "discover it."),
        })

    split("session", lambda t: t.decision.session or None)
    split("regime", lambda t: t.decision.regime or None)
    split("direction", lambda t: "long" if t.direction > 0 else "short")
    split("setup", lambda t: t.decision.setup_name or None)
    split("rule_compliance", lambda t: (None if t.decision.followed_rules is None
                                        else ("followed" if t.decision.followed_rules else "broken")))
    split("day_of_week", lambda t: datetime.fromisoformat(
        t.open_time.replace("Z", "+00:00")).strftime("%a"))
    split("hour_of_day", lambda t: f"{datetime.fromisoformat(t.open_time.replace('Z','+00:00')).hour:02d}h")
    split("duration", lambda t: (None if t.duration_minutes is None else
                                 ("under_1h" if t.duration_minutes < 60 else
                                  "1h_to_1d" if t.duration_minutes < 1440 else "over_1d")))
    split("modified", lambda t: "modified" if t.modifications > 0 else "untouched")

    # Sequence effects: what the trader did AFTER a win or a loss.
    ordered = sorted(usable, key=lambda t: t.open_time)
    after: dict[str, list[float]] = {"after_win": [], "after_loss": []}
    for prev, cur in zip(ordered, ordered[1:]):
        key = "after_win" if (prev.r_multiple or 0) > 0 else "after_loss"
        after[key].append(cur.r_multiple)
    if all(len(v) >= MIN_BUCKET for v in after.values()):
        stats = {k: _bucket_stats(v) for k, v in after.items()}
        gap = abs(stats["after_win"]["mean_r"] - stats["after_loss"]["mean_r"])
        if gap >= 0.15:
            out.append({
                "pattern": "sequence_effect", "buckets": stats, "gap_r": round(gap, 4),
                "causal": False,
                "detail": (f"trades after a win average {stats['after_win']['mean_r']:+.3f}R "
                           f"and after a loss {stats['after_loss']['mean_r']:+.3f}R. If real, "
                           "this is about the trader rather than the market - revenge trading "
                           "or hesitation. CORRELATION ONLY until tested prospectively."),
            })
    return out
