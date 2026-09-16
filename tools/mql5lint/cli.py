"""Command-line entry point for mql5lint."""

from __future__ import annotations

import argparse
import json
import os
import sys

from .rules import CRITICAL, HIGH, MEDIUM, LOW, Finding, check
from .source import SourceFile

SEVERITY_ORDER = {CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3}
DEFAULT_PATHS = ("MQL5",)
SOURCE_SUFFIXES = (".mq5", ".mqh")


def collect_files(paths: list[str]) -> list[str]:
    found: list[str] = []
    for p in paths:
        if os.path.isfile(p):
            found.append(p)
            continue
        for root, _dirs, files in os.walk(p):
            for name in sorted(files):
                if name.endswith(SOURCE_SUFFIXES):
                    found.append(os.path.join(root, name))
    return sorted(set(found))


def run(paths: list[str], strict: bool) -> tuple[list[Finding], int]:
    """Lint every source under ``paths``. Returns findings and an exit code.

    CRITICAL and HIGH always fail. MEDIUM fails only under --strict, because
    a few MEDIUM rules ask for a justification rather than asserting a bug,
    and a gate that blocks on those would be argued with instead of fixed.
    """
    findings: list[Finding] = []
    for path in collect_files(paths):
        findings.extend(check(SourceFile.load(path)))

    findings.sort(key=lambda f: (SEVERITY_ORDER.get(f.severity, 9), f.path, f.line))

    blocking = {CRITICAL, HIGH} | ({MEDIUM} if strict else set())
    code = 1 if any(f.severity in blocking for f in findings) else 0
    return findings, code


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="mql5lint",
        description="Static checks for the MQL5 bug catalogue. Does not prove the code compiles.",
    )
    ap.add_argument("paths", nargs="*", default=list(DEFAULT_PATHS),
                    help="files or directories to lint (default: MQL5)")
    ap.add_argument("--strict", action="store_true",
                    help="treat MEDIUM findings as failures too")
    ap.add_argument("--format", choices=("text", "json"), default="text")
    args = ap.parse_args(argv)

    paths = args.paths or list(DEFAULT_PATHS)
    missing = [p for p in paths if not os.path.exists(p)]
    if missing:
        print(f"mql5lint: no such path: {', '.join(missing)}", file=sys.stderr)
        return 2

    findings, code = run(paths, args.strict)

    if args.format == "json":
        print(json.dumps([f.__dict__ for f in findings], indent=2))
        return code

    scanned = len(collect_files(paths))
    if not findings:
        print(f"mql5lint: {scanned} file(s) scanned, no findings.")
        return 0

    for f in findings:
        print(f.format())

    counts = {sev: sum(1 for f in findings if f.severity == sev)
              for sev in (CRITICAL, HIGH, MEDIUM, LOW)}
    print()
    print(f"mql5lint: {scanned} file(s) scanned, {len(findings)} finding(s) -- "
          + ", ".join(f"{n} {sev.lower()}" for sev, n in counts.items() if n))
    if code == 0 and any(counts[s] for s in (MEDIUM, LOW)):
        print("mql5lint: non-blocking at this level; re-run with --strict to gate on MEDIUM.")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
