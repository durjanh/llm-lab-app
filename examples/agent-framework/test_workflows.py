"""Smoke test: each workflow type is wired as designed. No model calls (the agents are built but never run).

    python -m pytest examples/agent-framework -q
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "workflows"))
import _wf  # noqa: E402


def built(name: str):
    lab = _wf.Lab(_wf.Trace(), "https://example.openai.azure.com", "gpt-5.4-mini")
    return _wf.graph(_wf.patterns()[name].build(lab))


def kinds(graph: dict) -> set[str]:
    return {e["kind"] for e in graph["edges"]}


def test_every_workflow_that_has_one_graph_builds() -> None:
    for name, module in _wf.patterns().items():
        if hasattr(module, "build"):
            assert built(name)["nodes"], name


def test_the_hand_wired_fan_out_and_fan_in_are_real_edges() -> None:
    graph = built("fan_out_fan_in_edges")
    assert kinds(graph) == {"fanout", "fanin"}
    assert sum(e["kind"] == "fanin" for e in graph["edges"]) == 3


def test_routing_uses_switch_case_and_multi_selection() -> None:
    edges = built("routing")["edges"]
    assert {e["to"] for e in edges if e["from"] == "sorter"} == {"billing", "shipping", "product"}
    assert {e["to"] for e in edges if e["from"] == "intake"} == {"urgent_desk", "sorter"}


def test_the_maker_checker_loop_goes_back_and_has_two_ways_out() -> None:
    edges = {(e["from"], e["to"]) for e in built("maker_checker")["edges"]}
    assert {("checker", "maker"), ("checker", "publish"), ("checker", "escalate")} <= edges


def test_only_the_far_side_of_the_gate_can_send_email() -> None:
    lab = _wf.Lab(_wf.Trace(), "https://example.openai.azure.com", "gpt-5.4-mini")
    executors = {e.id: e for e in _wf.patterns()["plan_approve_run"].build(lab).get_executors_list()}
    assert not executors["planner"].agent.default_options.get("tools")
    assert executors["doer"].agent.default_options.get("tools")


def test_the_yaml_only_names_agents_that_are_registered() -> None:
    import re

    module = _wf.patterns()["declarative"]
    names = set(re.findall(r"^\s+agent: (\w+)$", module.FLOW.read_text(), re.M))
    assert names and names <= set(module.AGENTS)

