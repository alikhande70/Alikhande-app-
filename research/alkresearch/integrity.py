"""The Research Sentinel's scanner.

Looks for the ways a research process quietly stops being trustworthy. Most of
these are not dramatic: nobody fakes a result. What happens is that a benchmark
goes missing, a record ages past the code that produced it, or a number that
should have been checked against drift gets compared against zero instead - and
a month later the lab is confidently wrong.

Every check returns a finding that maps onto a queue item, so the Sentinel's
output is work rather than commentary.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .ledger import Ledger, Status
from .queue import Queue, QueueItem

REPO = Path(__file__).resolve().parent.parent.parent

#: An expectancy above this on screening data is treated as a suspect rather
#: than a success. Real edges on daily bars net of costs are small; a large one
#: is usually look-ahead, leakage or a data artefact, and checking costs less
#: than believing it.
SUSPICIOUS_EXPECTANCY_R = 0.60

#: A record whose code version is this far behind HEAD may have been produced
#: by an engine that has since been fixed. Two engine bugs have already been
#: found, so this is not hypothetical.
STALE_COMMITS = 15


@dataclass
class Finding:
    check: str
    severity: int          # 1 highest
    title: str
    detail: str
    queue: Queue
    information_gain: str

    def to_item(self) -> QueueItem:
        return QueueItem(
            title=self.title,
            queue=self.queue,
            priority=self.severity,
            information_gain=self.information_gain,
            rationale=self.detail,
            source=f"sentinel:{self.check}",
        )


def _commits_since(sha: str) -> int | None:
    if not sha or sha == "unknown":
        return None
    try:
        out = subprocess.run(["git", "rev-list", "--count", f"{sha}..HEAD"],
                             capture_output=True, text=True, timeout=10, cwd=REPO)
        return int(out.stdout.strip()) if out.returncode == 0 else None
    except Exception:
        return None


def _committed_records(path: Path, root: Path) -> dict[str, str] | None:
    """The ledger as HEAD has it: experiment id -> canonical record text.

    Returns None when git cannot answer - no repository, no commit yet, or the
    file simply is not in HEAD. A ledger git has never seen has no committed
    records to lose, so there is nothing to compare and nothing to report.
    """
    try:
        rel = path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return None
    try:
        out = subprocess.run(["git", "show", f"HEAD:{rel}"],
                             capture_output=True, text=True, timeout=10, cwd=root)
    except Exception:
        return None
    if out.returncode != 0:
        return None

    records: dict[str, str] = {}
    for line in out.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue          # an unreadable committed line is not evidence of loss
        rid = rec.get("id")
        if rid:
            records[rid] = json.dumps(rec, sort_keys=True)
    return records


# --------------------------------------------------------------------------
# Checks over the ledger
# --------------------------------------------------------------------------

def check_duplicates(ledger: Ledger) -> list[Finding]:
    """The same strategy, parameters and data run twice.

    Not an error in itself - a rerun after an engine fix is correct - but an
    unexplained duplicate means a cell forgot to consult the ledger, which is
    the thing that stops failed ideas being retried forever.
    """
    seen: dict[tuple, list[dict]] = {}
    for r in ledger.active():
        key = (r["strategy"], repr(sorted(r["params"].items())),
               r["data"].get("content_hash", ""))
        seen.setdefault(key, []).append(r)

    out = []
    for (strategy, _params, _hash), records in seen.items():
        if len(records) < 2:
            continue
        versions = {r["code_version"] for r in records}
        if len(versions) > 1:
            continue          # reran after a code change: legitimate
        out.append(Finding(
            "duplicate_experiment", 3,
            f"Duplicate experiment for {strategy} with identical params, data and code",
            f"{len(records)} records ({', '.join(r['id'] for r in records)}) share "
            "strategy, parameters, data hash AND code version. Either a cell skipped "
            "the already_tried() check, or one should supersede the other.",
            Queue.ENGINE_AUDIT,
            "whether the ledger's duplicate guard is actually being consulted",
        ))
    return out


def check_missing_evidence(ledger: Ledger) -> list[Finding]:
    """A surviving candidate that never faced the benchmarks it had to beat."""
    out = []
    for r in ledger.active():
        if r["status"] not in (Status.CANDIDATE.value, Status.CHALLENGER.value,
                               Status.CHAMPION.value):
            continue
        if not r.get("benchmarks"):
            out.append(Finding(
                "missing_benchmarks", 1,
                f"Candidate {r['strategy']} ({r['id']}) has no benchmark record",
                "A live candidate with no long-only and random-entry comparison has not "
                "been shown to beat drift or noise. That comparison is the gate that "
                "eliminated every candidate tested so far.",
                Queue.RED_TEAM,
                "whether this candidate survives the comparison that killed the others",
            ))
        if not r.get("null_hypothesis", "").strip():
            out.append(Finding(
                "missing_h0", 1,
                f"Candidate {r['strategy']} ({r['id']}) has no stated null hypothesis",
                "H0 is what keeps a promising number honest. Its absence on a live "
                "candidate means nobody wrote down the mundane explanation.",
                Queue.RED_TEAM,
                "what mundane explanation could produce this result with no edge",
            ))
    return out


def check_drift_mistaken_for_edge(ledger: Ledger) -> list[Finding]:
    """A candidate that did not beat simply holding the instrument."""
    out = []
    for r in ledger.active():
        bm = r.get("benchmarks") or {}
        al = bm.get("always_long_expectancy_r")
        exp = (r.get("metrics") or {}).get("expectancy_r")
        if al is None or exp is None:
            continue
        if r["status"] in (Status.CANDIDATE.value, Status.CHALLENGER.value,
                           Status.CHAMPION.value) and exp <= al:
            out.append(Finding(
                "drift_as_edge", 1,
                f"Live candidate {r['strategy']} ({r['id']}) is beaten by buy-and-hold",
                f"expectancy {exp:+.3f}R against a long-only benchmark of {al:+.3f}R. "
                "Whatever it measured, it was not an entry edge.",
                Queue.RED_TEAM,
                "whether this candidate has any advantage over passive exposure",
            ))
    return out


def check_random_equivalent(ledger: Ledger) -> list[Finding]:
    """A candidate whose result sits inside the no-information band."""
    out = []
    for r in ledger.active():
        bm = r.get("benchmarks") or {}
        band = bm.get("random_entry_band_r")
        exp = (r.get("metrics") or {}).get("expectancy_r")
        if not band or exp is None:
            continue
        if r["status"] in (Status.CANDIDATE.value, Status.CHALLENGER.value,
                           Status.CHAMPION.value) and exp <= band[1]:
            out.append(Finding(
                "random_equivalent", 1,
                f"Live candidate {r['strategy']} ({r['id']}) is inside the random-entry band",
                f"expectancy {exp:+.3f}R against a random-entry range of "
                f"[{band[0]:+.3f}, {band[1]:+.3f}]. Its entry rule is not distinguishable "
                "from carrying no information at all.",
                Queue.RED_TEAM,
                "whether the entry rule contributes anything over a coin flip",
            ))
    return out


def check_suspicious_results(ledger: Ledger) -> list[Finding]:
    """Treat a very strong screening result as a bug report."""
    out = []
    for r in ledger.active():
        exp = (r.get("metrics") or {}).get("expectancy_r")
        if exp is None or exp < SUSPICIOUS_EXPECTANCY_R:
            continue
        out.append(Finding(
            "suspicious_result", 1,
            f"Suspiciously strong result: {r['strategy']} at {exp:+.3f}R ({r['id']})",
            f"Expectancy {exp:+.3f}R exceeds the {SUSPICIOUS_EXPECTANCY_R:+.2f}R suspicion "
            "threshold. Check look-ahead, leakage, a cost error and a data artefact BEFORE "
            "believing it. Two engine bugs have already been found this way.",
            Queue.RED_TEAM,
            "whether this result is an edge or a defect in the measurement",
        ))
    return out


def check_stale_records(ledger: Ledger) -> list[Finding]:
    """Records produced by an engine that has since changed."""
    out = []
    stale: list[str] = []
    dirty: list[str] = []
    for r in ledger.active():
        if r.get("tree_dirty"):
            dirty.append(r["id"])
        behind = _commits_since(r.get("code_version", ""))
        if behind is not None and behind > STALE_COMMITS:
            stale.append(f"{r['id']}({behind} behind)")

    if stale:
        out.append(Finding(
            "stale_experiment", 3,
            f"{len(stale)} experiment record(s) predate the current engine by >{STALE_COMMITS} commits",
            "Records: " + ", ".join(stale[:8]) + ". The engine has changed since these ran; "
            "at least one past change altered results. Re-running the survivors would say "
            "whether the conclusions still hold.",
            Queue.RETEST,
            "whether past conclusions survive the current engine",
        ))
    if dirty:
        out.append(Finding(
            "dirty_tree_record", 2,
            f"{len(dirty)} record(s) were produced from an uncommitted working tree",
            "Records: " + ", ".join(dirty[:8]) + ". Their code_version does not identify "
            "the code that actually ran, so they are not reproducible.",
            Queue.ENGINE_AUDIT,
            "whether these results can be reproduced at all",
        ))
    return out


def check_ledger_append_only(ledger: Ledger, root: Path | None = None) -> list[Finding]:
    """Committed ledger records that have gone missing or changed underneath us.

    The ledger is append-only because negative results are the ones that quietly
    stop being mentioned. Every other check here reads the ledger and trusts it
    to be complete - so a record that vanishes is not merely lost, it silently
    disables the checks that would have used it.

    This is not hypothetical. On 2026-09-22 an `rm -f` during an unrelated
    verification destroyed eight records and nothing in this scanner noticed;
    they came back only because git happened to have them. Comparing the working
    file against HEAD is what turns that luck into a check: append freely, but
    losing or rewriting a record that was already committed is a defect.
    """
    root = root or REPO
    committed = _committed_records(ledger.path, root)
    if not committed:
        return []

    working: dict[str, str] = {}
    for r in ledger.all():
        rid = r.get("id")
        if rid:
            working[rid] = json.dumps(r, sort_keys=True)

    lost = [rid for rid in committed if rid not in working]
    changed = [rid for rid, text in committed.items()
               if rid in working and working[rid] != text]

    out = []
    if lost:
        out.append(Finding(
            "ledger_records_lost", 1,
            f"{len(lost)} committed experiment record(s) are missing from the ledger",
            "Records: " + ", ".join(sorted(lost)[:8]) + ". These ids are in "
            "HEAD and are not in the working file. The ledger is append-only; a record "
            "that disappears takes an eliminated idea with it, and the idea then gets "
            "retried as if it were new. Restore them from git before anything else "
            "writes to the file.",
            Queue.ENGINE_AUDIT,
            "which results were destroyed, and what removed them - so the next run "
            "does not repeat an experiment the lab has already paid for",
        ))
    if changed:
        out.append(Finding(
            "ledger_records_mutated", 1,
            f"{len(changed)} committed experiment record(s) have been edited in place",
            "Records: " + ", ".join(sorted(changed)[:8]) + ". These ids exist in "
            "both HEAD and the working file with different content. A correction is "
            "supposed to be a NEW record that supersedes the old one; editing the old "
            "one leaves no trace that the earlier conclusion was ever held.",
            Queue.ENGINE_AUDIT,
            "what was changed and by whom, and whether the original conclusion still "
            "stands - `git diff` on the ledger answers it",
        ))
    return out


# --------------------------------------------------------------------------
# Checks over the source and the docs
# --------------------------------------------------------------------------

_SHIFT_ZERO = re.compile(r"\.(?:close|open|high|low)\s*\(\s*0\s*\)")


def check_strategy_lookahead(root: Path | None = None) -> list[Finding]:
    """Strategies reading shift 0.

    Shift 0 is the last CLOSED bar in this engine, so it is legitimate - but it
    is also the line where a port to MQL5 goes wrong, because shift 0 there is
    the FORMING bar. Flagged as a review item, not a defect.
    """
    root = root or (REPO / "research" / "alkresearch" / "strategies")
    if not root.exists():
        return []
    hits = []
    for path in sorted(root.glob("*.py")):
        if path.name in ("__init__.py", "null.py"):
            continue
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            code = line.split("#", 1)[0]
            if _SHIFT_ZERO.search(code):
                hits.append(f"{path.name}:{i}")
    if not hits:
        return []
    return [Finding(
        "shift_zero_review", 4,
        f"{len(hits)} shift-0 read(s) in strategy code to confirm against the MQL5 port",
        "Sites: " + ", ".join(hits[:10]) + ". In this engine shift 0 is the last CLOSED "
        "bar and is correct. In MQL5 shift 0 is the FORMING bar. A direct translation of "
        "these lines would introduce look-ahead.",
        Queue.ENGINE_AUDIT,
        "whether the Python and MQL5 sides agree on what shift 0 means",
    )]


def check_docs_agree(ledger: Ledger, root: Path | None = None) -> list[Finding]:
    """Documentation asserting something the ledger does not support."""
    root = root or REPO
    out = []
    status_path = root / "docs" / "STATUS.md"
    if not status_path.exists():
        return out
    text = status_path.read_text(encoding="utf-8")

    champ = ledger.champion()
    claims_champion = re.search(r"champion\s*[:=]\s*(?!NONE)\w", text, re.I)
    if claims_champion and champ is None:
        out.append(Finding(
            "docs_champion_mismatch", 1,
            "Documentation refers to a champion but the ledger has none",
            "No record carries CHAMPION status, and none can without Tier-1 evidence. "
            "Documentation asserting otherwise is the kind of drift that turns into a "
            "trading decision.",
            Queue.ENGINE_AUDIT,
            "whether the documented state matches the recorded evidence",
        ))

    m = re.search(r"(\d+)\s+tests?\b", text)
    if m:
        claimed = int(m.group(1))
        try:
            proc = subprocess.run(["python3", "-m", "pytest", "tests/", "-q", "--co"],
                                  capture_output=True, text=True, timeout=120, cwd=root)
            found = re.search(r"(\d+)\s+tests? collected", proc.stdout)
            if found and abs(int(found.group(1)) - claimed) > 0:
                out.append(Finding(
                    "docs_test_count", 4,
                    f"STATUS.md says {claimed} tests; the suite collects {found.group(1)}",
                    "A stale count is harmless on its own and a reliable signal that the "
                    "document is no longer being updated with the code.",
                    Queue.ENGINE_AUDIT,
                    "whether documentation is tracking the code",
                ))
        except Exception:
            pass
    return out


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def scan(ledger: Ledger | None = None, root: Path | None = None) -> list[Finding]:
    """Every check, most severe first."""
    ledger = ledger or Ledger()
    findings: list[Finding] = []
    findings += check_duplicates(ledger)
    findings += check_missing_evidence(ledger)
    findings += check_drift_mistaken_for_edge(ledger)
    findings += check_random_equivalent(ledger)
    findings += check_suspicious_results(ledger)
    findings += check_stale_records(ledger)
    findings += check_ledger_append_only(ledger, root)
    findings += check_strategy_lookahead()
    findings += check_docs_agree(ledger, root)
    return sorted(findings, key=lambda f: f.severity)
