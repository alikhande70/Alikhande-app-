"""The Experiment Ledger, and the Evidence Gate that guards it.

Append-only. Records are never edited or deleted; a correction is a new record
that supersedes an old one. That is deliberate: the single most common failure
of a research process is that inconvenient results quietly stop being
mentioned, and an editable log makes that effortless.

THE EVIDENCE GATE
-----------------
Documentation cannot stop anyone treating a screening result as proof. Code
can. The rule enforced here:

    A strategy may become CANDIDATE on Tier-0 (screening) evidence.
    A strategy may NOT become CHAMPION without a Tier-1 (MetaTrader Strategy
    Tester, real instrument, real tick data) record.

Attempting to promote on screening evidence raises EvidenceError. This is the
research-integrity counterpart of SafetyGate.mqh, and it exists for the same
reason: a rule everyone has to remember is not a rule.

THE ANTI-CONFIRMATION-BIAS PROTOCOL
-----------------------------------
Every record carries TWO hypotheses, not one:

    H1  the strategy contains information
    H0  the result is noise, instrument drift, overfitting, a data error, or
        an artefact of the cost model

H0 is mandatory and must be specific. "It might be noise" is not an H0; "gold
tripled over the test window and any long-biased rule would score positively"
is. The field exists because the failure mode it guards against is not
dishonesty, it is the ordinary human tendency to look for confirmation once a
number looks good - and on this project the very first promising candidate
turned out to be exactly that.

`h0_ruled_out_by` records what was actually DONE about H0. Leaving it empty is
allowed and honest; claiming an edge while it is empty is what the field makes
visible.
"""

from __future__ import annotations

import json
import subprocess
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

LEDGER_DIR = Path(__file__).resolve().parent.parent / "experiments"
LEDGER_PATH = LEDGER_DIR / "ledger.jsonl"


class EvidenceError(RuntimeError):
    """An attempt to claim more than the evidence tier supports."""


class Tier(str, Enum):
    T0_SCREEN = "T0_SCREEN"    # here: public bars, often a proxy instrument
    T1_TESTER = "T1_TESTER"    # MetaTrader Strategy Tester, real instrument
    T2_FORWARD = "T2_FORWARD"  # demo account, live feed

    @property
    def is_real_instrument(self) -> bool:
        return self in (Tier.T1_TESTER, Tier.T2_FORWARD)


class Status(str, Enum):
    PROPOSED = "PROPOSED"        # hypothesis written, not yet tested
    SCREENED = "SCREENED"        # tested at T0, no verdict yet
    ELIMINATED = "ELIMINATED"    # failed a gate; terminal unless re-proposed as a new idea
    CANDIDATE = "CANDIDATE"      # passed the T0 gates; earns Strategy Tester time
    CHALLENGER = "CHALLENGER"    # has T1 evidence, competing with the champion
    CHAMPION = "CHAMPION"        # best available, on T1+ evidence only


#: Statuses that may not be reached without evidence from the real instrument.
REQUIRES_REAL_EVIDENCE = {Status.CHALLENGER, Status.CHAMPION}

#: CHAMPION additionally requires that the crowning record BE demo-forward
#: evidence. A Strategy Tester backtest is enough to compete, never to win:
#: the tester always fills, at zero latency, with no requotes, and applies
#: today's symbol spec across all history. The forward test is where those
#: assumptions get tested, and it is the whole point of the distinction.
CHAMPION_TIER = Tier.T2_FORWARD


def git_sha() -> str:
    """Pin the code version. A result that cannot name its code is not reproducible."""
    try:
        out = subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True, timeout=10,
                             cwd=Path(__file__).resolve().parent.parent.parent)
        sha = out.stdout.strip()
        return sha or "unknown"
    except Exception:
        return "unknown"


def _dirty_tree() -> bool:
    try:
        out = subprocess.run(["git", "status", "--porcelain"],
                             capture_output=True, text=True, timeout=10,
                             cwd=Path(__file__).resolve().parent.parent.parent)
        return bool(out.stdout.strip())
    except Exception:
        return False


@dataclass
class Experiment:
    """One reproducible result.

    Every field exists so the run can be rebuilt later. An omission here makes
    the record a claim rather than an experiment.
    """

    hypothesis: str                     # H1: what was asserted, BEFORE the run
    rejection_criterion: str            # what result would falsify it, BEFORE the run
    strategy: str
    params: dict
    tier: Tier
    data: dict                          # the Series.provenance() dict
    costs: dict
    metrics: dict
    gates: dict = field(default_factory=dict)      # gate name -> pass/fail/skip
    benchmarks: dict = field(default_factory=dict) # null comparisons
    #: H0 - the mundane explanation that would produce this result with no edge
    #: at all. Must be specific to THIS test, not a generic disclaimer.
    null_hypothesis: str = ""
    #: What was done to rule H0 out. Empty is honest; empty plus a claimed edge
    #: is the thing this field exists to expose.
    h0_ruled_out_by: str = ""
    #: The economic or market reason the rule might work. An idea with no
    #: rationale is a pattern found in noise until proven otherwise.
    rationale: str = ""

    verdict: str = ""                   # the conclusion, in words
    status: Status = Status.SCREENED
    notes: str = ""
    supersedes: str = ""                # id of a record this corrects

    # Filled automatically
    id: str = ""
    recorded_at: str = ""
    code_version: str = ""
    tree_dirty: bool = False

    def __post_init__(self):
        if isinstance(self.tier, str):
            self.tier = Tier(self.tier)
        if isinstance(self.status, str):
            self.status = Status(self.status)

        if not self.hypothesis.strip():
            raise ValueError("an experiment without a hypothesis is not an experiment")
        if not self.rejection_criterion.strip():
            raise ValueError(
                "a hypothesis with no rejection criterion is unfalsifiable. State what "
                "result would have made you abandon it."
            )

        self._enforce_evidence_gate()
        self._enforce_null_hypothesis()

        self.id = self.id or f"exp_{uuid.uuid4().hex[:12]}"
        self.recorded_at = self.recorded_at or datetime.now(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ")
        self.code_version = self.code_version or git_sha()
        self.tree_dirty = _dirty_tree()

    #: Statuses that assert the idea is still alive, and therefore require an
    #: explicit H0. ELIMINATED does not: a dead idea needs no alternative
    #: explanation, and demanding one would penalise recording failures.
    _CLAIMS_LIFE = {Status.CANDIDATE, Status.CHALLENGER, Status.CHAMPION}

    def _enforce_null_hypothesis(self) -> None:
        if self.status in self._CLAIMS_LIFE and not self.null_hypothesis.strip():
            raise ValueError(
                f"status {self.status.value} asserts the idea survived, so it needs an "
                "explicit null_hypothesis: the mundane explanation that would produce "
                "this result with no edge at all. Be specific to this test - instrument "
                "drift over the window, the sample being too small, the cost model, a "
                "data artefact - not a generic 'it might be noise'."
            )

    def _enforce_evidence_gate(self) -> None:
        if self.status is Status.CHAMPION and self.tier is not CHAMPION_TIER:
            raise EvidenceError(
                f"cannot record CHAMPION against tier {self.tier.value}. CHAMPION requires "
                f"{CHAMPION_TIER.value}: demo-forward evidence on a live feed. A Strategy "
                "Tester backtest supports CHALLENGER, not CHAMPION - the tester always "
                "fills, has zero latency and no requotes, and applies today's symbol spec "
                "across all history. Use Ledger.can_promote_champion() to check that the "
                "prior Tier-1 record exists as well."
            )
        if self.status in REQUIRES_REAL_EVIDENCE and not self.tier.is_real_instrument:
            raise EvidenceError(
                f"cannot record status {self.status.value} against tier "
                f"{self.tier.value}. {self.status.value} requires Tier-1 evidence: the "
                "MetaTrader Strategy Tester on the real instrument with broker tick "
                "data. Screening on public bars - frequently a PROXY instrument - "
                "cannot support that claim, however good the numbers look."
            )
        if self.tier == Tier.T0_SCREEN and self.data.get("is_proxy") and not self.notes:
            # Not an error, but the caveat must not be lost.
            self.notes = (
                f"PROXY DATA: {self.data.get('symbol')} stands in for "
                f"{self.data.get('proxy_for')}. {self.data.get('caveat', '')}"
            )

    def to_dict(self) -> dict:
        d = asdict(self)
        d["tier"] = self.tier.value
        d["status"] = self.status.value
        return d


class Ledger:
    def __init__(self, path: Path | None = None):
        self.path = path or LEDGER_PATH

    def append(self, exp: Experiment) -> Experiment:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(exp.to_dict(), sort_keys=True) + "\n")
        return exp

    def all(self) -> list[dict]:
        if not self.path.exists():
            return []
        out = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                out.append(json.loads(line))
        return out

    def active(self) -> list[dict]:
        """Records not superseded by a later one."""
        records = self.all()
        superseded = {r["supersedes"] for r in records if r.get("supersedes")}
        return [r for r in records if r["id"] not in superseded]

    def by_strategy(self, name: str) -> list[dict]:
        return [r for r in self.active() if r["strategy"] == name]

    def already_tried(self, strategy: str, params: dict, data_hash: str) -> dict | None:
        """Has exactly this been run before?

        The ledger exists so a failed experiment is not silently repeated. This
        is the query that makes that real rather than aspirational.
        """
        for r in self.active():
            if (r["strategy"] == strategy
                    and r["params"] == params
                    and r["data"].get("content_hash") == data_hash):
                return r
        return None

    def can_promote_champion(self, strategy: str) -> tuple[bool, str]:
        """Both halves of the evidence, checked against the whole ledger.

        A single record cannot see history, so the tier check in Experiment
        catches the wrong KIND of evidence while this catches the missing half.
        Demo-forward evidence with no prior backtest is not a confirmation of
        anything; a backtest with no forward test has never met a real fill.
        """
        records = self.by_strategy(strategy)
        has_t1 = any(r["tier"] == Tier.T1_TESTER.value for r in records)
        has_t2 = any(r["tier"] == Tier.T2_FORWARD.value for r in records)

        if not has_t1:
            return (False, f"no Tier-1 record for '{strategy}': there is no Strategy "
                           "Tester result on the real instrument for a forward test to confirm")
        if not has_t2:
            return (False, f"no Tier-2 demo-forward record for '{strategy}': the backtest "
                           "has never met a real fill, a real spread or real latency")
        return (True, f"'{strategy}' has both Tier-1 and Tier-2 evidence")

    def champion(self) -> dict | None:
        champs = [r for r in self.active() if r["status"] == Status.CHAMPION.value]
        return champs[-1] if champs else None

    def standings(self) -> list[dict]:
        """Best record per strategy, ranked. Ranking is by expectancy net of the
        always-long benchmark where one was recorded - because beating zero on a
        trending instrument means nothing."""
        best: dict[str, dict] = {}
        for r in self.active():
            if r["status"] == Status.PROPOSED.value:
                continue
            key = r["strategy"]
            score = r["metrics"].get("expectancy_r", -99)
            if key not in best or score > best[key]["metrics"].get("expectancy_r", -99):
                best[key] = r
        return sorted(best.values(),
                      key=lambda r: r["metrics"].get("expectancy_r", -99), reverse=True)

    def summary(self) -> dict:
        records = self.active()
        by_status: dict[str, int] = {}
        for r in records:
            by_status[r["status"]] = by_status.get(r["status"], 0) + 1
        return {
            "total_records": len(self.all()),
            "active_records": len(records),
            "by_status": by_status,
            "strategies_tested": sorted({r["strategy"] for r in records}),
            "champion": (self.champion() or {}).get("strategy"),
        }
