"""The Research Queue.

The coupling between the work cells. The Sentinel writes to it, the Discovery
Lab and the Red Team read from it. Without it, each scheduled run starts cold,
re-derives the same obvious next step, and the genuinely informative experiment
never gets picked because nobody remembered it.

Items are ranked by EXPECTED INFORMATION GAIN rather than by how promising they
sound. Those are different orderings and the difference matters: "screen one
more trend variant" sounds productive and tells us almost nothing, because the
family has already been eliminated twice. "Find out whether 20 years of history
exists" sounds like housekeeping and could unblock every candidate currently
eliminated for sample size.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

QUEUE_PATH = Path(__file__).resolve().parent.parent / "experiments" / "queue.json"


class Queue(str, Enum):
    """The six work queues.

    Named rather than free-form so that "this queue is blocked, move to
    another" is a mechanical decision instead of a judgement call made afresh
    by every cold session.
    """

    NEW_HYPOTHESIS = "NEW_HYPOTHESIS"    # an untested idea
    RETEST = "RETEST"                    # a prior result a documented change now justifies revisiting
    RED_TEAM = "RED_TEAM"                # an attack to run on a surviving candidate
    DATA_QUALITY = "DATA_QUALITY"        # something wrong or unknown about the data itself
    ENGINE_AUDIT = "ENGINE_AUDIT"        # the measurement apparatus, including the MQL5 execution layer
    TRADE_FORENSICS = "TRADE_FORENSICS"  # work on real trades, owner journal or tester output


#: Backwards-compatible alias. The Sentinel raises findings under these names.
ItemKind = Queue


class ItemState(str, Enum):
    OPEN = "OPEN"
    DONE = "DONE"
    DROPPED = "DROPPED"          # deliberately not doing it; reason required


@dataclass
class QueueItem:
    title: str
    queue: Queue
    #: 1 (highest) to 5. Defects outrank experiments: a broken measurement
    #: makes every subsequent experiment worthless.
    priority: int
    #: What we would LEARN, stated as the question this answers. An item whose
    #: information gain cannot be stated is an item nobody should work on.
    information_gain: str
    rationale: str = ""
    source: str = ""             # which cell or finding raised it
    state: ItemState = ItemState.OPEN
    resolution: str = ""         # required to leave OPEN
    id: str = ""
    created_at: str = ""
    updated_at: str = ""

    #: A queue is blocked when nothing in it can progress without the owner.
    #: Recorded per item so a cell can skip a whole queue without re-deriving why.
    blocked_reason: str = ""

    def __post_init__(self):
        if isinstance(self.queue, str):
            self.queue = Queue(self.queue)
        if isinstance(self.state, str):
            self.state = ItemState(self.state)
        if not self.title.strip():
            raise ValueError("a queue item needs a title")
        if not self.information_gain.strip():
            raise ValueError(
                "a queue item needs an information_gain: what would we LEARN? "
                "An item that cannot answer that is busywork with a ticket number."
            )
        if not 1 <= self.priority <= 5:
            raise ValueError("priority must be 1 (highest) to 5")
        if self.state is not ItemState.OPEN and not self.resolution.strip():
            raise ValueError(
                f"closing an item as {self.state.value} requires a resolution. "
                "Silently dropping work is how a queue becomes a graveyard."
            )
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.id = self.id or f"q_{uuid.uuid4().hex[:8]}"
        self.created_at = self.created_at or now
        self.updated_at = now

    def to_dict(self) -> dict:
        d = asdict(self)
        d["queue"] = self.queue.value
        d["state"] = self.state.value
        return d


class ResearchQueue:
    def __init__(self, path: Path | None = None):
        self.path = path or QUEUE_PATH
        self._items: list[QueueItem] = []
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        self._items = [QueueItem(**it) for it in payload.get("items", [])]

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "items": [it.to_dict() for it in self._items],
        }
        self.path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")

    def add(self, item: QueueItem, dedupe: bool = True) -> QueueItem | None:
        """Add an item. Returns None when it was a duplicate and was dropped.

        Deduplication is on the title, because the Sentinel runs hourly and
        would otherwise re-raise the same finding twenty-four times a day until
        the queue was unreadable.
        """
        if dedupe:
            for existing in self._items:
                if (existing.state is ItemState.OPEN
                        and existing.title.strip().lower() == item.title.strip().lower()):
                    return None
        self._items.append(item)
        return item

    def close(self, item_id: str, state: ItemState, resolution: str) -> bool:
        for i, it in enumerate(self._items):
            if it.id == item_id:
                d = it.to_dict()
                d.update(state=state.value, resolution=resolution)
                self._items[i] = QueueItem(**d)
                return True
        return False

    def open_items(self) -> list[QueueItem]:
        return [it for it in self._items if it.state is ItemState.OPEN]

    def all_items(self) -> list[QueueItem]:
        return list(self._items)

    #: Tie-break order at equal priority. The measurement apparatus and the data
    #: come first, because an experiment run on a broken engine or bad data
    #: produces a confident WRONG answer, which is worse than no answer.
    _QUEUE_ORDER = {
        Queue.ENGINE_AUDIT: 0,
        Queue.DATA_QUALITY: 1,
        Queue.RED_TEAM: 2,
        Queue.RETEST: 3,
        Queue.NEW_HYPOTHESIS: 4,
        Queue.TRADE_FORENSICS: 5,
    }

    def ranked(self, exclude: set[Queue] | None = None) -> list[QueueItem]:
        """Open items, most urgent first. Blocked items sort last, not out."""
        exclude = exclude or set()
        items = [it for it in self.open_items() if it.queue not in exclude]
        return sorted(items, key=lambda it: (bool(it.blocked_reason), it.priority,
                                             self._QUEUE_ORDER[it.queue], it.created_at))

    def next_item(self, exclude: set[Queue] | None = None) -> QueueItem | None:
        """The single most informative unblocked item, or a blocked one if that
        is all there is - so a cell reports the blockage rather than inventing
        work to fill the run."""
        ranked = self.ranked(exclude)
        return ranked[0] if ranked else None

    def by_queue(self, q: Queue) -> list[QueueItem]:
        return [it for it in self.open_items() if it.queue is q]

    def blocked_queues(self) -> set[Queue]:
        """Queues where every open item is blocked, or which are empty."""
        out = set()
        for q in Queue:
            items = self.by_queue(q)
            if not items or all(it.blocked_reason for it in items):
                out.add(q)
        return out

    def summary(self) -> dict:
        by_queue: dict[str, int] = {q.value: 0 for q in Queue}
        for it in self.open_items():
            by_queue[it.queue.value] += 1
        nxt = self.next_item()
        return {
            "open": len(self.open_items()),
            "total": len(self._items),
            "by_queue": by_queue,
            "blocked_queues": sorted(q.value for q in self.blocked_queues()),
            "next": (f"[{nxt.queue.value}] {nxt.title}" if nxt else None),
        }
