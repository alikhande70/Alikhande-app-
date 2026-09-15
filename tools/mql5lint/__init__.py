"""mql5lint -- a static linter for MQL5 sources.

MQL5 cannot be compiled outside Windows, so CI can never prove this project's
.mq5 and .mqh files build. What CI *can* do is enforce the catalogue of bugs
that recur in MQL5 trading code -- look-ahead, leaked indicator handles,
unchecked buffer reads, double equality, bypassed order layers.

That is the whole ambition. This tool does not type-check, does not parse
MQL5 properly, and finding nothing does not mean the code compiles. See
docs/TESTING.md for what each test layer actually proves.
"""

from .source import SourceFile, blank_non_code
from .rules import Finding, check, ALL_RULES, CRITICAL, HIGH, MEDIUM, LOW

__all__ = [
    "SourceFile", "blank_non_code", "Finding", "check", "ALL_RULES",
    "CRITICAL", "HIGH", "MEDIUM", "LOW",
]
__version__ = "0.1.0"
