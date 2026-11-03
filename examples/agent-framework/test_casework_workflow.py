"""Smoke test: the workflow graph is wired as designed. No model calls (the agents are built but never run).

    python -m pytest examples/agent-framework -q
"""
from __future__ import annotations

import casework_workflow as w


def test_the_graph_has_every_step_the_revision_loop_and_a_human_pause() -> None:
    wf = w.build_workflow()
    assert wf.start_executor_id == "intake"
    assert [e.id for e in wf.get_executors_list()] == ["intake", "evidence", "policy_search", "draft", "checks", "caseworker_approval"]
    edges = {(e.source_id, e.target_id) for group in wf.edge_groups for e in group.edges}
    assert ("checks", "draft") in edges and ("draft", "checks") in edges  # the revision loop
    assert ("checks", "caseworker_approval") in edges
    approval = next(e for e in wf.get_executors_list() if e.id == "caseworker_approval")
    assert approval.is_request_supported(w.ApprovalRequest, w.CaseworkerDecision)  # the workflow can pause for a person
    assert w.CaseOutcome in wf.output_types
