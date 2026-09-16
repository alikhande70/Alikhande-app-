"""Tests for source preparation.

These matter more than they look: every rule matches against the blanked
text, so a bug here turns into wrong findings everywhere at once.
"""

from mql5lint.source import SourceFile, blank_non_code


def test_line_comment_is_blanked_but_line_count_is_preserved():
    text = "int a = 1; // CopyBuffer == 0.0\nint b = 2;\n"
    out = blank_non_code(text)
    assert "CopyBuffer" not in out
    assert out.count("\n") == text.count("\n")
    assert out.splitlines()[0].startswith("int a = 1;")


def test_block_comment_spanning_lines_keeps_numbering():
    text = "a;\n/* CopyBuffer\n   == 0.0 */\nb;\n"
    out = blank_non_code(text)
    assert "CopyBuffer" not in out
    assert out.splitlines()[3] == "b;"


def test_string_literal_is_blanked():
    text = 'string s = "a == b and CopyBuffer";\n'
    out = blank_non_code(text)
    assert "==" not in out
    assert "CopyBuffer" not in out
    assert out.startswith("string s = ")


def test_escaped_quote_does_not_end_the_literal_early():
    text = 'string s = "he said \\" == \\" here"; int x = 1;\n'
    out = blank_non_code(text)
    # The == lives inside the literal, so nothing should survive to be matched.
    assert "==" not in out
    assert "int x = 1;" in out


def test_comment_markers_inside_a_string_are_not_comments():
    text = 'string url = "http://x/*y*/"; int keep = 1;\n'
    out = blank_non_code(text)
    assert "int keep = 1;" in out


def test_character_literal_is_blanked():
    text = "char c = '\"'; int keep = 2;\n"
    out = blank_non_code(text)
    assert "int keep = 2;" in out


def test_function_scope_is_tracked():
    src = SourceFile.from_text("t.mq5", "\n".join([
        "void OnTick()",
        "  {",
        "   int a = 1;",
        "  }",
        "void Helper()",
        "  {",
        "   int b = 2;",
        "  }",
    ]))
    by_line = {ln.number: ln.func for ln in src.lines}
    assert by_line[3] == "OnTick"
    assert by_line[7] == "Helper"


def test_control_flow_is_not_mistaken_for_a_function_definition():
    src = SourceFile.from_text("t.mq5", "\n".join([
        "void OnTick()",
        "  {",
        "   if(x > 1)",
        "     {",
        "      int a = 1;",
        "     }",
        "  }",
    ]))
    assert src.lines[4].func == "OnTick"


def test_declaration_is_not_mistaken_for_a_definition():
    # A prototype ends in a semicolon and opens no body.
    src = SourceFile.from_text("t.mq5", "int Declared(int x);\nint top = 1;\n")
    assert src.lines[1].func == ""
