"""Source preparation for the MQL5 linter.

Every rule in this linter matches text. Matching raw source produces
nonsense: a ``//`` comment mentioning ``CopyBuffer`` becomes a finding, and a
string literal containing ``==`` becomes a double-comparison bug. So the
source is blanked first -- comments and string/char literals are replaced by
spaces of the same length, which keeps every line number and column offset
intact while removing everything that is not code.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class Line:
    """One physical source line, in both raw and code-only form."""

    number: int          # 1-indexed
    raw: str             # exactly as written
    code: str            # comments and literals blanked to spaces
    func: str = ""       # enclosing function, "" at file scope
    depth: int = 0       # brace depth at the START of the line
    # Rule ids suppressed ON this line, each with a justification.
    suppress: dict = field(default_factory=dict)

    @property
    def stripped(self) -> str:
        return self.code.strip()

    @property
    def is_blank_code(self) -> bool:
        return not self.stripped


# A function definition: optional qualifiers, a return type, a name, and an
# opening parenthesis. Deliberately conservative -- a missed function only
# costs scope precision, while a false match would mislabel everything after it.
_FUNC_DEF = re.compile(
    r"""^\s*
        (?:(?:virtual|static|const|inline|extern)\s+)*   # qualifiers
        (?:[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)?)        # return type (or ctor name)
        (?:\s*[*&])?\s+
        ([A-Za-z_]\w*)                                   # function name
        \s*\(
    """,
    re.VERBOSE,
)

# An inline suppression. A reason after the dash is MANDATORY: a suppression
# without one is just a disabled rule, and it is reported as its own finding.
_SUPPRESS = re.compile(
    r"mql5lint:\s*allow\s+(MQL\d{3})\s*(?:-\s*(?P<reason>\S.*))?$",
    re.IGNORECASE,
)


# Control-flow keywords that look like a call but are not a definition.
_NOT_FUNCTIONS = {
    "if", "for", "while", "switch", "return", "catch", "sizeof",
    "else", "do", "case", "new", "delete",
}


def blank_non_code(text: str) -> str:
    """Replace comments and string/char literals with spaces of equal length.

    Newlines are preserved so line numbering is unaffected. The scanner is a
    small state machine rather than a regex because the three states -- code,
    comment, literal -- can each contain the others' delimiters.
    """
    out = []
    i, n = 0, len(text)
    state = "code"          # code | line_comment | block_comment | string | char
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""

        if state == "code":
            if ch == "/" and nxt == "/":
                state = "line_comment"
                out.append("  ")
                i += 2
                continue
            if ch == "/" and nxt == "*":
                state = "block_comment"
                out.append("  ")
                i += 2
                continue
            if ch == '"':
                state = "string"
                out.append(" ")
                i += 1
                continue
            if ch == "'":
                state = "char"
                out.append(" ")
                i += 1
                continue
            out.append(ch)
            i += 1
            continue

        if state == "line_comment":
            if ch == "\n":
                state = "code"
                out.append("\n")
            else:
                out.append(" ")
            i += 1
            continue

        if state == "block_comment":
            if ch == "*" and nxt == "/":
                state = "code"
                out.append("  ")
                i += 2
                continue
            out.append("\n" if ch == "\n" else " ")
            i += 1
            continue

        # string or char literal
        if ch == "\\" and nxt:
            # An escape consumes the next character, so a literal backslash
            # before the closing quote cannot terminate the literal early.
            out.append("  ")
            i += 2
            continue
        if (state == "string" and ch == '"') or (state == "char" and ch == "'"):
            state = "code"
            out.append(" ")
            i += 1
            continue
        out.append("\n" if ch == "\n" else " ")
        i += 1

    return "".join(out)


@dataclass
class SourceFile:
    path: str
    text: str
    lines: list[Line] = field(default_factory=list)

    @classmethod
    def load(cls, path: str) -> "SourceFile":
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        return cls.from_text(path, text)

    @classmethod
    def from_text(cls, path: str, text: str) -> "SourceFile":
        code = blank_non_code(text)
        raw_lines = text.splitlines()
        code_lines = code.splitlines()
        # blank_non_code preserves newlines, but a trailing line without one
        # can still leave the two lists a element apart.
        while len(code_lines) < len(raw_lines):
            code_lines.append("")

        src = cls(path=path, text=text)
        src.lines = [
            Line(number=i + 1, raw=raw_lines[i], code=code_lines[i])
            for i in range(len(raw_lines))
        ]
        src._annotate_scopes()
        src._annotate_suppressions()
        return src

    def _annotate_suppressions(self) -> None:
        """Attach suppressions to the lines they cover.

        A suppression applies to its own line and to the next line that
        actually contains code. Intervening comment and blank lines are
        skipped, so a justification may run to several lines -- which is the
        point, since a one-line reason is usually not a reason.

            if(...) return;   // mql5lint: allow MQL006 - new-bar detection

            // mql5lint: allow MQL006 - bar 0's open time is the signal,
            // not a price read; the strategy itself reads shift >= 1.
            if(...) return;

        It reaches exactly one code line, so it cannot silently blanket a
        whole function.
        """
        for idx, line in enumerate(self.lines):
            m = _SUPPRESS.search(line.raw)
            if not m:
                continue
            rule = m.group(1).upper()
            reason = (m.group("reason") or "").strip()
            line.suppress[rule] = reason

            for following in self.lines[idx + 1:]:
                if following.is_blank_code:
                    continue          # blank line, or a continued justification
                following.suppress.setdefault(rule, reason)
                break

    def suppressed(self, line_no: int, rule: str) -> bool:
        """True when ``rule`` is suppressed on ``line_no`` WITH a reason."""
        if not (1 <= line_no <= len(self.lines)):
            return False
        return bool(self.lines[line_no - 1].suppress.get(rule))

    def bad_suppressions(self) -> list[tuple[int, str]]:
        """Suppressions written without a justification."""
        return [
            (ln.number, rule)
            for ln in self.lines
            for rule, reason in ln.suppress.items()
            if not reason
        ]

    def _annotate_scopes(self) -> None:
        """Label each line with its enclosing function and brace depth.

        Approximate by design: MQL5 is close enough to C that brace counting
        over comment-free text is reliable, and the only consumer is the
        "is this inside OnTick" question.
        """
        depth = 0
        current = ""
        func_depth = -1

        for line in self.lines:
            line.depth = depth
            line.func = current

            m = _FUNC_DEF.match(line.code)
            if m and m.group(1) not in _NOT_FUNCTIONS:
                # A definition, not a call: the line must open a body here or
                # on a following line, never end in a semicolon.
                tail = line.code.rstrip()
                if not tail.endswith(";"):
                    current = m.group(1)
                    line.func = current
                    func_depth = depth

            opened = line.code.count("{")
            closed = line.code.count("}")
            depth += opened - closed

            if current and func_depth >= 0 and depth <= func_depth and closed:
                current = ""
                func_depth = -1

    def find(self, pattern: re.Pattern) -> list[tuple[Line, re.Match]]:
        """Every match of ``pattern`` against code-only text."""
        hits = []
        for line in self.lines:
            for m in pattern.finditer(line.code):
                hits.append((line, m))
        return hits
