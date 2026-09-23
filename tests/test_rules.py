"""Tests for the lint rules.

Every rule gets both a positive and a negative case. The negative case is the
important half: a rule that fires on correct code is worse than no rule,
because it trains people to ignore the output.
"""

import pytest

from mql5lint.rules import CRITICAL, HIGH, MEDIUM, check
from mql5lint.source import SourceFile


def lint(code: str, path: str = "MQL5/Include/Alikhande/Thing.mqh"):
    return check(SourceFile.from_text(path, code))


def ids(findings):
    return {f.rule for f in findings}


# --------------------------------------------------------------------------
# MQL001 - the live-trading compile gate
# --------------------------------------------------------------------------

def test_live_define_is_critical():
    f = lint("#define ALIKHANDE_ALLOW_LIVE\n")
    assert "MQL001" in ids(f)
    assert [x for x in f if x.rule == "MQL001"][0].severity == CRITICAL


def test_merely_naming_the_macro_is_not_a_finding():
    # The safety gate must be able to test the macro without tripping the rule.
    assert "MQL001" not in ids(lint("#ifdef ALIKHANDE_ALLOW_LIVE\nreturn(true);\n#endif\n"))


def test_the_macro_inside_a_comment_is_not_a_finding():
    assert "MQL001" not in ids(lint("// #define ALIKHANDE_ALLOW_LIVE explains the gate\n"))


# --------------------------------------------------------------------------
# MQL002 / MQL003 / MQL005 - CopyBuffer
# --------------------------------------------------------------------------

def test_copybuffer_shift_zero_is_lookahead():
    code = "ArraySetAsSeries(buf, true);\nif(CopyBuffer(h, 0, 0, 2, buf) < 2) return;\n"
    assert "MQL002" in ids(lint(code))


def test_copybuffer_shift_one_is_clean():
    code = "ArraySetAsSeries(buf, true);\nif(CopyBuffer(h, 0, 1, 2, buf) < 2) return;\n"
    assert ids(lint(code)) == set()


def test_discarded_copybuffer_return_is_flagged():
    code = "ArraySetAsSeries(buf, true);\nCopyBuffer(h, 0, 1, 2, buf);\n"
    assert "MQL003" in ids(lint(code))


def test_checked_copybuffer_is_not_flagged():
    code = "ArraySetAsSeries(buf, true);\nint got = CopyBuffer(h, 0, 1, 2, buf);\nif(got < 2) return;\n"
    assert "MQL003" not in ids(lint(code))


def test_copybuffer_without_setasseries_is_flagged():
    assert "MQL005" in ids(lint("if(CopyBuffer(h, 0, 1, 2, buf) < 2) return;\n"))


def test_setasseries_in_a_different_function_does_not_count():
    code = "\n".join([
        "void Setup()",
        "  {",
        "   ArraySetAsSeries(buf, true);",
        "  }",
        "void Use()",
        "  {",
        "   if(CopyBuffer(h, 0, 1, 2, buf) < 2) return;",
        "  }",
    ])
    assert "MQL005" in ids(lint(code))


# --------------------------------------------------------------------------
# MQL004 - handles created per tick
# --------------------------------------------------------------------------

def test_handle_created_in_ontick_is_flagged():
    code = "void OnTick()\n  {\n   int h = iATR(_Symbol, PERIOD_CURRENT, 14);\n  }\n"
    assert "MQL004" in ids(lint(code))


def test_handle_created_in_oninit_is_fine():
    code = "int OnInit()\n  {\n   int h = iATR(_Symbol, PERIOD_CURRENT, 14);\n   return(0);\n  }\n"
    assert "MQL004" not in ids(lint(code))


@pytest.mark.parametrize("fn", ["iMA", "iRSI", "iCustom", "iBands", "iStochastic"])
def test_every_handle_function_is_recognised(fn):
    code = f"void OnTick()\n  {{\n   int h = {fn}(_Symbol, 0, 1);\n  }}\n"
    assert "MQL004" in ids(lint(code))


# --------------------------------------------------------------------------
# MQL006 - bar 0 price reads
# --------------------------------------------------------------------------

def test_bar_zero_close_is_flagged():
    assert "MQL006" in ids(lint("double c = iClose(_Symbol, PERIOD_H4, 0);\n"))


def test_bar_one_close_is_clean():
    assert "MQL006" not in ids(lint("double c = iClose(_Symbol, PERIOD_H4, 1);\n"))


# --------------------------------------------------------------------------
# MQL007 - double equality
# --------------------------------------------------------------------------

def test_comparison_against_a_float_literal_is_flagged():
    assert "MQL007" in ids(lint("if(price == 1.2345) return;\n"))


def test_two_declared_doubles_compared_with_equals_is_flagged():
    assert "MQL007" in ids(lint("double a = 1; double b = 2;\nif(a == b) return;\n"))


def test_integer_comparison_is_not_flagged():
    assert "MQL007" not in ids(lint("int a = 1; int b = 2;\nif(a == b) return;\n"))


def test_comparison_against_integer_zero_is_not_flagged():
    # Retcode and count comparisons are integers and must stay quiet.
    assert "MQL007" not in ids(lint("if(rc == 0) return;\nif(got != 2) return;\n"))


# --------------------------------------------------------------------------
# MQL008 - hardcoded instruments
# --------------------------------------------------------------------------

def test_hardcoded_symbol_is_flagged():
    assert "MQL008" in ids(lint('SymbolSelect("XAUUSD", true);\n'))


def test_broker_suffixed_symbol_is_also_flagged():
    assert "MQL008" in ids(lint('SymbolSelect("XAUUSD.m", true);\n'))


def test_symbol_named_only_in_a_comment_is_not_flagged():
    assert "MQL008" not in ids(lint("// XAUUSD quotes at 2 or 3 digits\n"))


def test_using_the_predefined_symbol_is_clean():
    assert "MQL008" not in ids(lint("SymbolSelect(_Symbol, true);\n"))


# --------------------------------------------------------------------------
# MQL009 - ticket width
# --------------------------------------------------------------------------

def test_int_ticket_is_flagged():
    assert "MQL009" in ids(lint("int ticket = 5;\n"))


def test_ulong_ticket_is_clean():
    assert "MQL009" not in ids(lint("ulong ticket = 5;\n"))


# --------------------------------------------------------------------------
# MQL010 - order submission outside the execution layer
# --------------------------------------------------------------------------

def test_raw_ordersend_outside_the_executor_is_flagged():
    assert "MQL010" in ids(lint("OrderSend(req, res);\n", path="MQL5/Experts/Alikhande/X.mq5"))


def test_ordersend_inside_the_executor_is_allowed():
    f = lint("OrderSend(req, res);\n", path="MQL5/Include/Alikhande/OrderExecutor.mqh")
    assert "MQL010" not in ids(f)


# --------------------------------------------------------------------------
# MQL011 - position iteration direction
# --------------------------------------------------------------------------

def test_upward_position_loop_is_flagged():
    assert "MQL011" in ids(lint("for(int i = 0; i < PositionsTotal(); i++) {}\n"))


def test_downward_position_loop_is_clean():
    assert "MQL011" not in ids(lint("for(int i = PositionsTotal() - 1; i >= 0; i--) {}\n"))


# --------------------------------------------------------------------------
# MQL012 - state access outside the state module
# --------------------------------------------------------------------------

def test_globalvariable_outside_the_state_module_is_flagged():
    assert "MQL012" in ids(lint("GlobalVariableSet(k, 1.0);\n", path="MQL5/Experts/Alikhande/X.mq5"))


def test_globalvariable_inside_the_state_module_is_allowed():
    f = lint("GlobalVariableSet(k, 1.0);\n", path="MQL5/Include/Alikhande/RiskManager.mqh")
    assert "MQL012" not in ids(f)


# --------------------------------------------------------------------------
# Suppression machinery
# --------------------------------------------------------------------------

def test_justified_suppression_silences_the_finding():
    code = "double c = iClose(_Symbol, 0, 0); // mql5lint: allow MQL006 - trailing stop needs live price\n"
    assert "MQL006" not in ids(lint(code))


def test_suppression_on_the_preceding_line_also_applies():
    code = "// mql5lint: allow MQL006 - trailing stop needs live price\ndouble c = iClose(_Symbol, 0, 0);\n"
    assert "MQL006" not in ids(lint(code))


def test_suppression_without_a_reason_does_not_silence_and_is_reported():
    code = "double c = iClose(_Symbol, 0, 0); // mql5lint: allow MQL006\n"
    found = ids(lint(code))
    assert "MQL006" in found, "an unjustified suppression must not silence the rule"
    assert "MQL013" in found, "and it must be reported in its own right"


def test_suppression_is_scoped_to_the_named_rule():
    code = "int ticket = 1; // mql5lint: allow MQL006 - unrelated rule\n"
    assert "MQL009" in ids(lint(code))


def test_suppression_does_not_leak_further_than_one_line():
    code = "\n".join([
        "// mql5lint: allow MQL006 - applies to the next line only",
        "double a = iClose(_Symbol, 0, 0);",
        "double b = iClose(_Symbol, 0, 0);",
    ])
    findings = [f for f in lint(code) if f.rule == "MQL006"]
    assert [f.line for f in findings] == [3]


def test_suppression_reaches_past_a_multiline_justification():
    code = "\n".join([
        "// mql5lint: allow MQL006 - bar 0's open time is the new-bar signal,",
        "// not a price read; the strategy itself reads shift >= 1.",
        "",
        "datetime t = iTime(_Symbol, PERIOD_CURRENT, 0);",
    ])
    assert "MQL006" not in ids(lint(code))


def test_suppression_still_reaches_only_one_code_line():
    code = "\n".join([
        "// mql5lint: allow MQL006 - justification",
        "// continued on a second line",
        "datetime a = iTime(_Symbol, 0, 0);",
        "datetime b = iTime(_Symbol, 0, 0);",
    ])
    findings = [f for f in lint(code) if f.rule == "MQL006"]
    assert [f.line for f in findings] == [4]


def test_same_parameter_name_with_different_types_in_different_functions():
    """A name that is a double in one function and a long in another.

    This is ordinary overloading, and the integer comparison must stay quiet.
    Getting this wrong made the linter flag its own assertion harness.
    """
    code = "\n".join([
        "void EqualD(const double actual, const double expected)",
        "  {",
        "   if(MathAbs(actual - expected) < 1e-9) Pass();",
        "  }",
        "void EqualI(const long actual, const long expected)",
        "  {",
        "   if(actual == expected) Pass();",
        "  }",
    ])
    assert "MQL007" not in ids(lint(code))


def test_a_double_comparison_is_still_caught_in_its_own_scope():
    code = "\n".join([
        "void EqualI(const long actual, const long expected)",
        "  {",
        "   if(actual == expected) Pass();",
        "  }",
        "void Check(const double a, const double b)",
        "  {",
        "   if(a == b) Pass();",
        "  }",
    ])
    findings = [f for f in lint(code) if f.rule == "MQL007"]
    assert [f.line for f in findings] == [7]


def test_file_scope_double_is_visible_inside_a_function():
    code = "\n".join([
        "double g_price = 0;",
        "void Check()",
        "  {",
        "   if(g_price == other) return;",
        "  }",
    ])
    assert "MQL007" in ids(lint(code))


def test_a_local_redeclaration_shadows_a_file_scope_double():
    code = "\n".join([
        "double value = 0;",
        "void Check()",
        "  {",
        "   int value = 1;",
        "   if(value == limit) return;",
        "  }",
    ])
    assert "MQL007" not in ids(lint(code))


def test_a_function_whose_name_contains_ticket_is_not_a_narrow_ticket():
    """`int CloseTicketsNotIn(...)` returns a count, not a ticket.

    MQL009 matched it because the name contains "Ticket", which would have
    pushed an author to rename a correctly-named function to satisfy a linter.
    """
    code = "int CloseTicketsNotIn(const ulong &known[], const string reason)\n  {\n   return(0);\n  }\n"
    assert "MQL009" not in ids(lint(code))


def test_a_narrow_ticket_variable_is_still_caught():
    assert "MQL009" in ids(lint("int ticket = 5;\n"))
    assert "MQL009" in ids(lint("long positionTicket = 5;\n"))
    assert "MQL009" in ids(lint("uint ticketId = 5;\n"))


def test_a_ulong_ticket_returning_function_is_clean():
    code = "ulong SoleNewTicket(const ulong &a[], const ulong &b[])\n  {\n   return(0);\n  }\n"
    assert "MQL009" not in ids(lint(code))
