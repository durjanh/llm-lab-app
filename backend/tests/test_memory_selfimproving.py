"""The deterministic parts of the memory agent (python/22_memory_agent.py) and the self-improving agent
(python/23_self_improving_agent.py): memory path confinement, the privacy guard, edits, the hidden checker and the
lesson gate. No model calls, no cost."""
from __future__ import annotations

import importlib
import os

import pytest

from backend.app import shared  # noqa: F401  (puts python/ on sys.path)

M = importlib.import_module("22_memory_agent")
S = importlib.import_module("23_self_improving_agent")


@pytest.fixture
def store(tmp_path):
    return M.MemoryStore(tmp_path / "jordan")


def test_memory_paths_stay_inside_the_folder(store, tmp_path):
    store.execute({"command": "create", "path": "/memories/prefs.md", "file_text": "Likes early trains.\n"})
    assert (tmp_path / "jordan" / "prefs.md").read_text() == "Likes early trains.\n"
    for bad in ["/etc/passwd", "memories/x.md", "/memories/../escape.md", "/memories/a/../../x", "/memoriesx/y"]:
        with pytest.raises(M.MemoryCommandError):
            store.execute({"command": "create", "path": bad, "file_text": "x"})
    assert not (tmp_path / "escape.md").exists()


def test_memory_refuses_symlinks(store, tmp_path):
    store.root.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, store.root / "link")
    with pytest.raises(M.MemoryCommandError, match="symbolic link"):
        store.execute({"command": "create", "path": "/memories/link/x.md", "file_text": "x"})
    assert not (outside / "x.md").exists()


def test_luhn_and_privacy_guard():
    assert M.luhn_valid("4111111111111111")
    assert not M.luhn_valid("4111111111111112")
    assert M.privacy_problem("Card: 4111 1111 1111 1111") == "a payment card number"
    assert M.privacy_problem("Order ref 1234 5678 9012 3456") is None  # card-shaped but fails the checksum
    assert M.privacy_problem("Sam is off for knee surgery") == "health information"
    assert M.privacy_problem("Prefers trains arriving before 08:45") is None


def test_guard_refuses_writes_and_edits(store):
    with pytest.raises(M.MemoryCommandError, match="Refused"):
        store.execute({"command": "create", "path": "/memories/pay.md", "file_text": "card 4111-1111-1111-1111"})
    assert not store.files()
    store.execute({"command": "create", "path": "/memories/team.md", "file_text": "Covering supplier calls.\n"})
    with pytest.raises(M.MemoryCommandError, match="Refused"):
        store.execute({"command": "str_replace", "path": "/memories/team.md", "old_str": "Covering",
                       "new_str": "Sam has surgery; covering"})
    with pytest.raises(M.MemoryCommandError, match="Refused"):
        store.execute({"command": "insert", "path": "/memories/team.md", "insert_line": 1,
                       "insert_text": "password: hunter2"})


def test_str_replace_needs_exactly_one_match(store):
    store.execute({"command": "create", "path": "/memories/diet.md", "file_text": "Vegetarian. Vegetarian.\n"})
    with pytest.raises(M.MemoryCommandError, match="2 times"):
        store.execute({"command": "str_replace", "path": "/memories/diet.md", "old_str": "Vegetarian",
                       "new_str": "Eats fish"})
    with pytest.raises(M.MemoryCommandError, match="0 times"):
        store.execute({"command": "str_replace", "path": "/memories/diet.md", "old_str": "Vegan", "new_str": "x"})
    store.execute({"command": "str_replace", "path": "/memories/diet.md", "old_str": "Vegetarian. Vegetarian.",
                   "new_str": "Eats fish and meat."})
    assert "Eats fish and meat." in store.execute({"command": "view", "path": "/memories/diet.md"})


def test_view_rename_delete(store):
    store.execute({"command": "create", "path": "/memories/a.md", "file_text": "one\ntwo\nthree\n"})
    assert store.execute({"command": "view", "path": "/memories/a.md", "view_range": [2, -1]}).split("\n") == [
        "     2\ttwo", "     3\tthree"]
    store.execute({"command": "rename", "old_path": "/memories/a.md", "new_path": "/memories/work/a.md"})
    assert "/memories/work/a.md" in store.execute({"command": "view", "path": "/memories"})
    with pytest.raises(M.MemoryCommandError):
        store.execute({"command": "delete", "path": "/memories"})
    store.execute({"command": "delete", "path": "/memories/work"})
    assert store.files() == []


def test_checker_knows_the_house_style():
    line = S.TRAIN[1]  # Cloudhaven Hosting Limited, 1234.80 inc VAT
    assert S.expected(line) == {"date": "2026-11-04", "supplier": "CLOUDHAVEN HOSTING", "net": "GBP 1,029.00",
                                "vat": "GBP 205.80", "gross": "GBP 1,234.80"}
    assert S.expected(S.TRAIN[0])["vat"] == "GBP 0.00"  # rail fares are zero-rated
    assert S.expected(S.TRAIN[2])["gross"] == "GBP 102.00"  # £85 ex VAT
    assert S.canonical_supplier("paper & ink ltd") == "PAPER & INK"
    # Every inc-VAT amount divides to the penny, so the data has no rounding traps.
    for line in S.TRAIN + S.VALIDATION + S.TEST:
        e = S.expected(line)
        net, vat, gross = (S.Decimal(e[k][4:].replace(",", "")) for k in ("net", "vat", "gross"))
        assert net + vat == gross


def test_grade_reports_each_wrong_field():
    lines = S.TRAIN[:2]
    good = [{"id": line.id, **S.expected(line)} for line in lines]
    assert S.grade(lines, good) == (10, 10, [])
    bad = [dict(good[0], date="03/11/2026", vat="GBP 8.10"), good[1]]
    passed, total, failures = S.grade(lines, bad)
    assert (passed, total) == (8, 10)
    assert set(failures[0]["wrong"]) == {"date", "vat"}
    assert failures[0]["wrong"]["date"] == {"got": "03/11/2026", "expected": "2026-11-03"}
    assert S.grade(lines, [])[0] == 0  # missing records fail every check


def test_gate_keeps_only_lessons_that_help():
    scores = {"good": 0.9, "neutral": 0.6, "bad": 0.3}

    def evaluate(lessons):
        return max([0.6] + [scores[x] for x in lessons]) if "bad" not in lessons else 0.3

    kept, rejected, final = S.gate([], ["good", "bad", "good", "neutral"], evaluate, baseline=0.6)
    assert kept == ["good"]
    assert [(r[0], r[2].split(" ")[0]) for r in rejected] == [
        ("bad", "validation"), ("good", "duplicate"), ("neutral", "no")]
    assert final == 0.9


def test_gate_caps_the_lesson_list():
    current = [f"rule {i}" for i in range(S.MAX_LESSONS)]
    kept, rejected, _ = S.gate(current, ["one more"], lambda ls: 1.0, baseline=0.5)
    assert kept == [] and "full" in rejected[0][2]


def test_claude_gets_its_own_memory_tool_and_other_models_a_json_schema_one():
    assert M.memory_tool("claude-haiku-5-5") is M.MEMORY_TOOL
    assert M.memory_tool("gpt-5.4-mini") is M.MEMORY_FUNCTION
    assert M.memory_tool("ai/qwen3.5:9b-q4_K_XL") is M.MEMORY_FUNCTION


def test_the_json_schema_tool_offers_every_command_the_store_carries_out():
    commands = set(M.MEMORY_FUNCTION["input_schema"]["properties"]["command"]["enum"])
    assert commands == {name[4:] for name in dir(M.MemoryStore) if name.startswith("cmd_")}


def test_gpt_and_the_local_model_take_the_json_schema_tool_but_refuse_claudes():
    import gpt_model
    import local_model

    ask = {"model": "gpt-5.4-mini", "max_tokens": 100, "messages": [{"role": "user", "content": "hi"}]}
    body = gpt_model.to_request({**ask, "tools": [M.MEMORY_FUNCTION]})
    assert body["tools"][0]["function"]["name"] == "memory"
    local_model._check({**ask, "tools": [M.MEMORY_FUNCTION]})  # an ordinary tool: no refusal
    with pytest.raises(local_model.NeedsClaude):
        local_model._check({**ask, "tools": [M.MEMORY_TOOL]})


def test_a_command_from_the_json_schema_tool_runs_like_claudes(store):
    store.execute({"command": "create", "path": "/memories/prefs.md", "file_text": "Diet: vegetarian\n"})
    store.execute({"command": "str_replace", "path": "/memories/prefs.md", "old_str": "vegetarian", "new_str": "eats fish"})
    assert "eats fish" in store.execute({"command": "view", "path": "/memories/prefs.md"})


def test_a_fact_stored_twice_is_reported(store):
    store.execute({"command": "create", "path": "/memories/prefs.md", "file_text": "- Eats fish.\n- Commutes.\n- Commutes.\n"})
    assert M.duplicate_lines(store.files()) == [("prefs.md", "- Commutes.", 2)]
