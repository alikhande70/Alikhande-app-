"""Rule set for the MQL5 linter.

Each rule encodes a bug that costs money in production rather than a style
preference. The bar for inclusion is that a reviewer can name the trade that
goes wrong; a rule that only makes code prettier does not belong here,
because a linter people mute is worse than no linter.

Precision over recall. Every rule here is written to avoid false positives
even where that means missing real instances -- the alternative is a wall of
noise that gets suppressed wholesale.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .source import SourceFile

CRITICAL, HIGH, MEDIUM, LOW = "CRITICAL", "HIGH", "MEDIUM", "LOW"


@dataclass(frozen=True)
class Finding:
    rule: str
    severity: str
    path: str
    line: int
    message: str
    excerpt: str

    def format(self) -> str:
        return (
            f"{self.path}:{self.line}: [{self.severity}] {self.rule}: {self.message}\n"
            f"    | {self.excerpt.strip()}"
        )


# Indicator functions that allocate a handle. Creating one per tick leaks
# until the terminal returns INVALID_HANDLE and the EA silently stops trading.
HANDLE_FUNCS = (
    "iAC iAD iADX iADXWilder iAlligator iAMA iAO iATR iBands iBearsPower "
    "iBullsPower iBWMFI iCCI iChaikin iCustom iDEMA iDeMarker iEnvelopes "
    "iForce iFractals iFrAMA iGator iIchimoku iMA iMACD iMFI iMomentum iOBV "
    "iOsMA iRSI iRVI iSAR iStdDev iStochastic iTEMA iTriX iVIDyA iVolumes iWPR"
).split()

# Per-tick entry points. A handle created in any of these is created forever.
TICK_FUNCS = {"OnTick", "OnCalculate", "OnTimer", "OnBookEvent"}

_RE_LIVE_DEFINE = re.compile(r"^\s*#\s*define\s+ALIKHANDE_ALLOW_LIVE\b")
_RE_COPYBUFFER = re.compile(
    r"CopyBuffer\s*\(\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*([A-Za-z_]\w*)"
)
_RE_BARE_COPYBUFFER = re.compile(r"^\s*CopyBuffer\s*\(")
_RE_HANDLE_CALL = re.compile(r"\b(" + "|".join(HANDLE_FUNCS) + r")\s*\(")
_RE_PRICE_SERIES = re.compile(
    r"\b(iClose|iOpen|iHigh|iLow|iTime|iVolume|iTickVolume|iSpread)\s*\(([^;]*?)\)"
)
_RE_SETASSERIES = re.compile(r"ArraySetAsSeries\s*\(\s*([A-Za-z_]\w*)")
_RE_DOUBLE_DECL = re.compile(r"\bdouble\s+([A-Za-z_]\w*)")
_RE_FLOAT_LITERAL_CMP = re.compile(r"(!=|==)\s*(-?\d+\.\d+|-?\.\d+)")
_RE_INT_TICKET = re.compile(r"\b(?:int|uint|long)\s+(\w*[Tt]icket\w*)\b")
_RE_RAW_ORDERSEND = re.compile(r"\bOrderSend(?:Async)?\s*\(")
_RE_UP_LOOP_POSITIONS = re.compile(
    r"for\s*\(\s*(?:int\s+)?(\w+)\s*=\s*0\s*;\s*\1\s*<\s*PositionsTotal\s*\(\s*\)"
)
_RE_GLOBALVAR = re.compile(r"\bGlobalVariable(?:Set|Get|Del|Check|Temp)\s*\(")

# Instrument names that must come from _Symbol or an input, never a literal.
_RE_HARDCODED_SYMBOL = re.compile(
    r'"\s*(XAUUSD|XAGUSD|EURUSD|GBPUSD|USDJPY|USDCHF|AUDUSD|NZDUSD|USDCAD|'
    r'BTCUSD|ETHUSD|US30|NAS100|SPX500|GOLD|SILVER)[A-Za-z0-9._]*\s*"',
    re.IGNORECASE,
)

# Files exempt from a rule, matched as path substrings.
EXEC_LAYER = ("Include/Alikhande/OrderExecutor.mqh",)
STATE_LAYER = ("Include/Alikhande/RiskManager.mqh",)
# The dump script legitimately prints raw spec values and is not a strategy.
DIAGNOSTIC = ("Scripts/Alikhande/SymbolSpecDump.mq5",)


def _in_any(path: str, needles: tuple[str, ...]) -> bool:
    norm = path.replace("\\", "/")
    return any(n in norm for n in needles)


def _is_literal_zero(arg: str) -> bool:
    return arg.strip() in {"0", "0.0"}


# --------------------------------------------------------------------------
# Rules
# --------------------------------------------------------------------------

def rule_live_gate(src: SourceFile) -> list[Finding]:
    """MQL001 -- the real-money compile gate has been switched on.

    The project's safety design rests on this macro being absent from the
    entire tree. If it is ever defined, the whole gate is one input toggle
    away from live execution, which is exactly what the owner forbade.
    """
    out = []
    for line in src.lines:
        if _RE_LIVE_DEFINE.match(line.code):
            out.append(Finding(
                "MQL001", CRITICAL, src.path, line.number,
                "ALIKHANDE_ALLOW_LIVE is defined. This removes the compile-time half "
                "of the real-money safety gate. It must not exist in the repository.",
                line.raw,
            ))
    return out


def rule_copybuffer_shift_zero(src: SourceFile) -> list[Finding]:
    """MQL002 -- reading the forming bar.

    ``start_pos`` 0 is the bar that has not closed. A signal built on it can
    be true at 10:03 and false at 10:04, after the EA has already acted.
    """
    out = []
    for line, m in src.find(_RE_COPYBUFFER):
        if _is_literal_zero(m.group(3)):
            out.append(Finding(
                "MQL002", HIGH, src.path, line.number,
                "CopyBuffer start_pos is 0, which reads the bar that is still forming. "
                "Signals must read closed bars (shift >= 1) or the backtest is not reproducible.",
                line.raw,
            ))
    return out


def rule_unchecked_copybuffer(src: SourceFile) -> list[Finding]:
    """MQL003 -- CopyBuffer's return value discarded.

    Right after init the indicator may not be calculated, and CopyBuffer
    returns fewer values than asked for. A partially filled array read as if
    it were full produces garbage signals rather than an error.
    """
    out = []
    for line in src.lines:
        if _RE_BARE_COPYBUFFER.match(line.code):
            out.append(Finding(
                "MQL003", HIGH, src.path, line.number,
                "CopyBuffer's return value is discarded. Compare it against the number of "
                "values requested and return early on a short read.",
                line.raw,
            ))
    return out


def rule_handle_in_tick(src: SourceFile) -> list[Finding]:
    """MQL004 -- indicator handle created per tick."""
    out = []
    for line, m in src.find(_RE_HANDLE_CALL):
        if line.func in TICK_FUNCS:
            out.append(Finding(
                "MQL004", HIGH, src.path, line.number,
                f"{m.group(1)}() creates an indicator handle inside {line.func}(). "
                "Handles must be created in OnInit and released in OnDeinit; per-tick "
                "creation leaks until the call returns INVALID_HANDLE.",
                line.raw,
            ))
    return out


def rule_missing_setasseries(src: SourceFile) -> list[Finding]:
    """MQL005 -- CopyBuffer into an array never set as a series.

    Without ArraySetAsSeries the indexing is silently reversed, so index 0 is
    the oldest value instead of the newest and every comparison is backwards.
    """
    out = []
    seen_in_func: dict[str, set[str]] = {}
    for line in src.lines:
        key = line.func or "<file>"
        bucket = seen_in_func.setdefault(key, set())
        for m in _RE_SETASSERIES.finditer(line.code):
            bucket.add(m.group(1))
        for m in _RE_COPYBUFFER.finditer(line.code):
            arr = m.group(5)
            if arr not in bucket:
                out.append(Finding(
                    "MQL005", HIGH, src.path, line.number,
                    f"CopyBuffer fills '{arr}' but ArraySetAsSeries({arr}, true) was not called "
                    "earlier in this function. Series indexing would be reversed.",
                    line.raw,
                ))
    return out


def rule_bar_zero_price(src: SourceFile) -> list[Finding]:
    """MQL006 -- iClose/iHigh/... reading shift 0.

    Allowed deliberately in some places (a trailing stop wants the live
    price), which is why this is MEDIUM: it asks for a justification, it does
    not assert a bug.
    """
    out = []
    for line, m in src.find(_RE_PRICE_SERIES):
        args = [a.strip() for a in m.group(2).split(",")]
        if len(args) >= 3 and _is_literal_zero(args[-1]):
            out.append(Finding(
                "MQL006", MEDIUM, src.path, line.number,
                f"{m.group(1)}() reads shift 0, the bar still forming. Legitimate for a live "
                "intrabar value, look-ahead in a signal. If deliberate, say so in a comment "
                "and backtest with real ticks.",
                line.raw,
            ))
    return out


def rule_double_equality(src: SourceFile) -> list[Finding]:
    """MQL007 -- doubles compared with == or !=.

    Two passes: an exact match against a float literal, and a match against
    any identifier the file declares as a double. Both are precise; neither
    tries to infer types it cannot see.
    """
    out = []
    doubles = {m.group(1) for line in src.lines for m in _RE_DOUBLE_DECL.finditer(line.code)}

    for line in src.lines:
        for m in _RE_FLOAT_LITERAL_CMP.finditer(line.code):
            out.append(Finding(
                "MQL007", MEDIUM, src.path, line.number,
                f"'{m.group(1)} {m.group(2)}' compares a double against a float literal. "
                "Float residue makes this unreliable; compare with a tolerance.",
                line.raw,
            ))
        if not doubles:
            continue
        for m in re.finditer(r"([A-Za-z_]\w*)\s*(==|!=)\s*([A-Za-z_]\w*)", line.code):
            lhs, op, rhs = m.group(1), m.group(2), m.group(3)
            if lhs in doubles or rhs in doubles:
                out.append(Finding(
                    "MQL007", MEDIUM, src.path, line.number,
                    f"'{lhs} {op} {rhs}' compares a declared double with {op}. "
                    "Use a tolerance such as MathAbs(a - b) < point / 2.",
                    line.raw,
                ))
    return out


def rule_hardcoded_symbol(src: SourceFile) -> list[Finding]:
    """MQL008 -- an instrument name written as a literal.

    XAUUSD, XAUUSD.m, GOLD and XAUUSD_i are all real names for the same
    metal. A literal is correct on exactly one broker.
    """
    out = []
    for line in src.lines:
        if line.is_blank_code:
            continue          # a pure comment line may name symbols freely
        m = _RE_HARDCODED_SYMBOL.search(line.raw)
        if m:
            out.append(Finding(
                "MQL008", MEDIUM, src.path, line.number,
                f"Hardcoded instrument name {m.group(0)}. Broker suffixes differ "
                "(XAUUSD / XAUUSD.m / GOLD); use _Symbol or an input.",
                line.raw,
            ))
    return out


def rule_int_ticket(src: SourceFile) -> list[Finding]:
    """MQL009 -- a ticket stored in a type too small for it.

    Tickets are ulong. Truncating to int corrupts them, and the corrupted
    value usually still selects *something*.
    """
    out = []
    for line, m in src.find(_RE_INT_TICKET):
        out.append(Finding(
            "MQL009", HIGH, src.path, line.number,
            f"'{m.group(1)}' looks like a ticket but is not declared ulong. "
            "Tickets are ulong; a narrower type silently corrupts them.",
            line.raw,
        ))
    return out


def rule_raw_ordersend(src: SourceFile) -> list[Finding]:
    """MQL010 -- order submission outside the execution layer.

    Retcode classification, filling-mode negotiation and retry policy all
    live in one module. A direct OrderSend elsewhere bypasses every one of
    them.
    """
    if _in_any(src.path, EXEC_LAYER):
        return []
    out = []
    for line, _ in src.find(_RE_RAW_ORDERSEND):
        out.append(Finding(
            "MQL010", HIGH, src.path, line.number,
            "OrderSend outside the execution layer. It bypasses retcode classification, "
            "filling-mode resolution and the retry policy. Route it through COrderExecutor.",
            line.raw,
        ))
    return out


def rule_upward_position_loop(src: SourceFile) -> list[Finding]:
    """MQL011 -- iterating positions upwards while closing them.

    The collection shrinks as positions close, so an upward loop skips every
    second one and leaves half the book open.
    """
    out = []
    for line, _ in src.find(_RE_UP_LOOP_POSITIONS):
        out.append(Finding(
            "MQL011", MEDIUM, src.path, line.number,
            "Upward iteration over PositionsTotal(). If anything inside the loop closes a "
            "position the collection shrinks and positions are skipped. Iterate downwards.",
            line.raw,
        ))
    return out


def rule_globalvar_outside_state(src: SourceFile) -> list[Finding]:
    """MQL012 -- terminal global variables used outside the state module.

    Terminal globals behave differently under the Strategy Tester, where a
    value left by one optimization pass can poison the next. Keeping every
    access in one module means that hazard is handled in exactly one place.
    """
    if _in_any(src.path, STATE_LAYER):
        return []
    out = []
    for line, _ in src.find(_RE_GLOBALVAR):
        out.append(Finding(
            "MQL012", MEDIUM, src.path, line.number,
            "GlobalVariable* outside the state module. Tester passes can leak state through "
            "terminal globals; keep every access in CRiskManager so the reset is handled once.",
            line.raw,
        ))
    return out


ALL_RULES = (
    rule_live_gate,
    rule_copybuffer_shift_zero,
    rule_unchecked_copybuffer,
    rule_handle_in_tick,
    rule_missing_setasseries,
    rule_bar_zero_price,
    rule_double_equality,
    rule_hardcoded_symbol,
    rule_int_ticket,
    rule_raw_ordersend,
    rule_upward_position_loop,
    rule_globalvar_outside_state,
)


def rule_bad_suppression(src: SourceFile) -> list[Finding]:
    """MQL013 -- a suppression with no justification.

    ``// mql5lint: allow MQL006`` with nothing after it is a disabled rule
    wearing a comment. The reason is what makes a suppression reviewable, so
    one without it is reported rather than honoured.
    """
    return [
        Finding(
            "MQL013", MEDIUM, src.path, line_no,
            f"Suppression of {rule} has no justification. Write "
            f"'// mql5lint: allow {rule} - why this is correct here'.",
            src.lines[line_no - 1].raw,
        )
        for line_no, rule in src.bad_suppressions()
    ]


def check(src: SourceFile) -> list[Finding]:
    """Run every rule, then drop findings that carry a justified suppression."""
    findings: list[Finding] = []
    for rule in ALL_RULES:
        findings.extend(rule(src))

    kept = [f for f in findings if not src.suppressed(f.line, f.rule)]
    kept.extend(rule_bad_suppression(src))
    return sorted(kept, key=lambda f: (f.line, f.rule))
