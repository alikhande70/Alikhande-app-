"""Tests for the command-line surface, including exit codes.

CI gates on the exit code, so it is part of the contract rather than an
implementation detail.
"""

import pathlib

from mql5lint.cli import collect_files, main, run


def write(tmp_path: pathlib.Path, name: str, body: str) -> pathlib.Path:
    p = tmp_path / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body, encoding="utf-8")
    return p


def test_clean_tree_exits_zero(tmp_path):
    write(tmp_path, "MQL5/Include/Alikhande/Ok.mqh", "int OnInit() { return(0); }\n")
    _, code = run([str(tmp_path)], strict=False)
    assert code == 0


def test_high_severity_finding_fails(tmp_path):
    write(tmp_path, "MQL5/Experts/Alikhande/Bad.mq5",
          "void OnTick()\n  {\n   int h = iATR(_Symbol, 0, 14);\n  }\n")
    findings, code = run([str(tmp_path)], strict=False)
    assert code == 1
    assert any(f.rule == "MQL004" for f in findings)


def test_medium_finding_passes_by_default_and_fails_under_strict(tmp_path):
    write(tmp_path, "MQL5/Experts/Alikhande/Mid.mq5",
          "double c = iClose(_Symbol, 0, 0);\n")
    _, lenient = run([str(tmp_path)], strict=False)
    _, strict = run([str(tmp_path)], strict=True)
    assert lenient == 0
    assert strict == 1


def test_only_mql5_sources_are_collected(tmp_path):
    write(tmp_path, "MQL5/a.mq5", "\n")
    write(tmp_path, "MQL5/b.mqh", "\n")
    write(tmp_path, "MQL5/notes.md", "iATR in OnTick\n")
    write(tmp_path, "MQL5/build.ex5", "\n")
    names = {pathlib.Path(p).name for p in collect_files([str(tmp_path)])}
    assert names == {"a.mq5", "b.mqh"}


def test_missing_path_exits_two(capsys):
    assert main(["does/not/exist"]) == 2
    assert "no such path" in capsys.readouterr().err


def test_json_output_is_machine_readable(tmp_path, capsys):
    write(tmp_path, "MQL5/Bad.mq5", "void OnTick()\n  {\n   int h = iATR(_Symbol, 0, 14);\n  }\n")
    code = main([str(tmp_path), "--format", "json"])
    assert code == 1
    import json
    payload = json.loads(capsys.readouterr().out)
    assert payload[0]["rule"] == "MQL004"
    assert payload[0]["severity"] == "HIGH"
    assert set(payload[0]) >= {"rule", "severity", "path", "line", "message", "excerpt"}


def test_findings_are_ordered_most_severe_first(tmp_path):
    write(tmp_path, "MQL5/Mixed.mq5", "\n".join([
        "double c = iClose(_Symbol, 0, 0);",      # MEDIUM
        "#define ALIKHANDE_ALLOW_LIVE",           # CRITICAL
        "int ticket = 1;",                        # HIGH
    ]))
    findings, _ = run([str(tmp_path)], strict=False)
    assert [f.severity for f in findings][:3] == ["CRITICAL", "HIGH", "MEDIUM"]
