#!/usr/bin/env python3
"""Alikhande research lab CLI. The four work cells drive everything through here.

    python3 research/run_lab.py sentinel            # scan for defects, fill the queue
    python3 research/run_lab.py queue               # what to work on next
    python3 research/run_lab.py queue --add "..." --queue NEW_HYPOTHESIS --gain "..." --priority 2
    python3 research/run_lab.py queue --close q_ab12 --resolution "screened, eliminated at G3"
    python3 research/run_lab.py redteam --strategy donchian_breakout --instrument GOLD
    python3 research/run_lab.py forensics           # trade-journal state and patterns
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from alkresearch import data, integrity, redteam                      # noqa: E402
from alkresearch import forensics as F                                # noqa: E402
from alkresearch.ledger import Ledger                                 # noqa: E402
from alkresearch.queue import ItemState, Queue, QueueItem, ResearchQueue  # noqa: E402
from alkresearch.strategies import ALL                                # noqa: E402
from run_screen import COSTS                                          # noqa: E402


def cmd_sentinel(args) -> int:
    ledger = Ledger()
    queue = ResearchQueue()
    findings = integrity.scan(ledger)

    print(f"=== SENTINEL === {len(findings)} finding(s)\n")
    added = 0
    for f in findings:
        print(f"[P{f.severity}] {f.check:24s} -> {f.queue.value}")
        print(f"       {f.title}")
        print(f"       {f.detail}")
        print(f"       learn: {f.information_gain}\n")
        if queue.add(f.to_item()) is not None:
            added += 1

    if not findings:
        print("No integrity defect found. The queue decides the next experiment.\n")

    queue.save()
    print(f"Queue: {added} new item(s). {json.dumps(queue.summary(), indent=2)}")
    nxt = queue.next_item()
    if nxt:
        print(f"\nHIGHEST INFORMATION GAIN NEXT: [{nxt.queue.value}] {nxt.title}")
        print(f"  learn: {nxt.information_gain}")
        if nxt.blocked_reason:
            print(f"  BLOCKED: {nxt.blocked_reason} (every other queue is empty or blocked too)")
    return 0


def cmd_queue(args) -> int:
    queue = ResearchQueue()

    if args.add:
        if not args.gain:
            print("--add requires --gain: what would this item teach us?", file=sys.stderr)
            return 2
        item = QueueItem(args.add, Queue(args.queue), args.priority,
                         information_gain=args.gain, rationale=args.rationale or "",
                         source=args.source or "manual",
                         blocked_reason=args.blocked or "")
        if queue.add(item) is None:
            print(f"Already queued: {args.add}")
        else:
            queue.save()
            print(f"Added {item.id}: [{item.queue.value}] {item.title}")
        return 0

    if args.close:
        if not args.resolution:
            print("--close requires --resolution: silently dropping work is how a "
                  "queue becomes a graveyard", file=sys.stderr)
            return 2
        state = ItemState.DROPPED if args.dropped else ItemState.DONE
        if queue.close(args.close, state, args.resolution):
            queue.save()
            print(f"Closed {args.close} as {state.value}")
            return 0
        print(f"No such item: {args.close}", file=sys.stderr)
        return 1

    print(json.dumps(queue.summary(), indent=2) + "\n")
    for it in queue.ranked():
        flag = f"  BLOCKED: {it.blocked_reason}" if it.blocked_reason else ""
        print(f"[P{it.priority}] {it.queue.value:16s} {it.id}  {it.title}{flag}")
        print(f"        learn: {it.information_gain}")
    return 0


def cmd_redteam(args) -> int:
    if args.strategy not in ALL:
        print(f"unknown strategy. Known: {sorted(ALL)}", file=sys.stderr)
        return 2
    cls = ALL[args.strategy]
    params = cls().params()

    series = data.fetch(args.instrument, "1d", args.range)
    other_key = "EURUSD" if args.instrument != "EURUSD" else "GOLD"
    other = data.fetch(other_key, "1d", args.range)

    print(f"=== RED TEAM === {args.strategy} on {args.instrument} "
          f"({series.period[0]} -> {series.period[1]})")
    print("Objective: prove this candidate false.\n")

    out = redteam.run_campaign(series, cls, params, COSTS[args.instrument],
                               other=other, other_costs=COSTS[other_key])

    print(f"baseline {out['baseline_expectancy_r']:+.3f}R over {out['baseline_trades']} trades\n")
    for a in out["attacks"]:
        mark = "SURVIVED " if a["survived"] else "DESTROYED"
        print(f"  [{mark}] {a['attack']}")
        print(f"             {a['detail']}")
    print(f"\nsurvived_all: {out['survived_all']}")
    if out["failed_attacks"]:
        print(f"failed: {', '.join(out['failed_attacks'])}")
    print(f"\nWEAKEST POINT: {out['weakest_point']}")

    if args.json:
        Path(args.json).write_text(json.dumps(out, indent=2), encoding="utf-8")
        print(f"\nwritten to {args.json}")
    return 0


def cmd_forensics(args) -> int:
    led = F.ForensicsLedger()
    trades = led.all()

    print(f"=== TRADE FORENSICS === {len(trades)} trade(s) recorded\n")
    if not trades:
        print("No trades yet. This lab needs one of:")
        print("  - an MT5 account history export")
        print("  - a Strategy Tester trade list")
        print("  - the owner's own journal")
        print("\nThe infrastructure is built and tested; it has no input.")
        print("Decision quality is assessed from PRE-TRADE facts only - the classifier")
        print("physically cannot see the result - so a journal without a recorded plan")
        print("can only ever be graded UNKNOWN. Recording the plan is what makes the")
        print("review possible at all.")
        return 0

    print("Decision/outcome grid (a good decision that lost is not a failure):")
    for quadrant, n in sorted(led.quadrants().items()):
        print(f"  {quadrant:34s} {n:4d}")

    kinds: dict[str, int] = {}
    for t in trades:
        kinds[t.failure_kind.value] = kinds.get(t.failure_kind.value, 0) + 1
    print("\nFailure taxonomy:")
    for k, n in sorted(kinds.items(), key=lambda kv: -kv[1]):
        print(f"  {k:22s} {n:4d}")

    print("\nPattern search (CORRELATION ONLY - nothing here establishes cause):")
    for p in F.find_patterns(trades):
        print(f"  - {p['pattern']}: {p['detail']}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("sentinel").set_defaults(fn=cmd_sentinel)

    q = sub.add_parser("queue")
    q.add_argument("--add"), q.add_argument("--gain"), q.add_argument("--rationale")
    q.add_argument("--source"), q.add_argument("--blocked")
    q.add_argument("--queue", default="NEW_HYPOTHESIS", choices=[x.value for x in Queue])
    q.add_argument("--priority", type=int, default=3)
    q.add_argument("--close"), q.add_argument("--resolution")
    q.add_argument("--dropped", action="store_true")
    q.set_defaults(fn=cmd_queue)

    r = sub.add_parser("redteam")
    r.add_argument("--strategy", required=True)
    r.add_argument("--instrument", default="GOLD", choices=sorted(COSTS))
    r.add_argument("--range", default="10y"), r.add_argument("--json")
    r.set_defaults(fn=cmd_redteam)

    sub.add_parser("forensics").set_defaults(fn=cmd_forensics)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
