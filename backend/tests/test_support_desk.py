"""The support desk agent: the gate, both hooks, error shapes, normalisation, trimming, the handoff and the loop, with a
scripted model, so no key and no cost."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.core.errors import ApiError
from backend.app.gateways.claude import ClaudeGateway
from backend.app.main import create_app
from backend.app.services import support_desk as sd
from backend.app.services.spend import SpendTracker
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text, use
from backend.tests.test_api import LAB

HAIKU = "claude-haiku-5-5"


def service(script: list[list[dict]]) -> tuple[sd.SupportDeskService, ScriptedClient]:
    client = ScriptedClient(script)
    return sd.SupportDeskService(ClaudeGateway(client), SpendTracker(1.0)), client


def offered(opts: sd.Opts | None = None) -> set[str]:
    o = opts or sd.Opts()
    return {t["name"] for t in sd.tool_set(o.vague_tools, o.dangerous_tool)}


def run(case: sd.Case, name: str, args: dict[str, Any], opts: sd.Opts | None = None) -> dict[str, Any]:
    svc = sd.SupportDeskService(None, None)  # type: ignore[arg-type]  # the tool pipeline never calls the model
    o = opts or sd.Opts()
    return svc.run_tool(case, name, args, o, offered(o))


def verified(customer_email: str = "mira.okafor@example.com") -> sd.Case:
    case = sd.Case("t")
    entry = run(case, "get_customer", {"email": customer_email})
    assert entry["result"]["structuredContent"]["status"] == "verified"
    return case


def body(entry: dict[str, Any]) -> dict[str, Any]:
    return entry["result"]["structuredContent"]


# ----- shapes -----

def test_results_are_mcp_shaped_and_errors_carry_a_category() -> None:
    ok = sd.mcp_result({"a": 1})
    assert ok["isError"] is False and json.loads(ok["content"][0]["text"]) == {"a": 1} and ok["structuredContent"] == {"a": 1}
    err = sd.tool_error("transient", True, "Try again.")
    assert err["isError"] is True
    assert err["structuredContent"] == {"errorCategory": "transient", "isRetryable": True, "message": "Try again."}
    with pytest.raises(AssertionError):
        sd.tool_error("weird", False, "x")


# ----- the gate -----

def test_refund_and_order_lookups_are_refused_until_the_customer_is_verified() -> None:
    case = sd.Case("t")
    for name, args in [("process_refund", {"order_id": "LF-2001", "amount_usd": 10, "reason": "x"}),
                       ("lookup_order", {"order_id": "LF-2001"}), ("check_order", {"order_id": "LF-2001"})]:
        entry = run(case, name, args, sd.Opts({"vague_tools": True}))
        assert entry["blocked_by"] == "gate"
        assert body(entry)["errorCategory"] == "permission" and body(entry)["isRetryable"] is False
        assert body(entry)["required_action"] == "get_customer"
    assert case.refunded == {} and case.facts["refunds"] == []


def test_with_the_gate_off_the_prompt_is_the_only_rule_and_an_unverified_refund_goes_through() -> None:
    case = sd.Case("t")
    entry = run(case, "process_refund", {"order_id": "LF-2001", "amount_usd": 10, "reason": "x"},
                sd.Opts({"enforce_gate": False}))
    assert entry["blocked_by"] is None and not entry["result"]["isError"] and case.refunded == {"LF-2001": 10}


def test_another_customers_orders_are_not_reachable_even_when_verified() -> None:
    case = verified()  # Mira
    other = run(case, "lookup_order", {"order_id": "LF-2003"})  # Tom's
    missing = run(case, "lookup_order", {"order_id": "LF-9999"})
    assert body(other) == body(missing) and body(other)["errorCategory"] == "validation"  # no probing of ids
    listed = run(case, "lookup_order", {"customer_id": "C-102"})
    assert body(listed)["errorCategory"] == "permission"
    refund = run(case, "process_refund", {"order_id": "LF-2003", "amount_usd": 5, "reason": "x"})
    assert body(refund)["errorCategory"] == "validation" and case.refunded == {}


def test_get_customer_verifies_one_match_and_never_guesses_between_several() -> None:
    case = sd.Case("t")
    several = body(run(case, "get_customer", {"name": "Jamie Hart"}))
    assert several["status"] == "multiple_matches" and several["matches"] == 2 and case.verified is None
    assert "customer_id" not in several and "@example.com" not in json.dumps(several)
    assert body(run(case, "get_customer", {"name": "Nobody Here"}))["status"] == "no_match"
    assert body(run(case, "get_customer", {}))["errorCategory"] == "validation"
    one = body(run(case, "get_customer", {"name": "Jamie Hart", "postcode": "ls6 2ab"}))
    assert one["status"] == "verified" and one["customer_id"] == "C-103" and case.verified == "C-103"
    switch = run(case, "get_customer", {"email": "mira.okafor@example.com"})
    assert body(switch)["errorCategory"] == "permission" and case.verified == "C-103"


# ----- the hooks -----

def test_pre_hook_blocks_a_refund_over_500_and_points_at_escalation() -> None:
    case = verified("tom.bellweather@example.com")
    entry = run(case, "process_refund", {"order_id": "LF-2003", "amount_usd": 689, "reason": "wobbly"})
    assert entry["blocked_by"] == "pre_hook"
    assert body(entry)["errorCategory"] == "permission" and body(entry)["required_action"] == "escalate_to_human"
    assert "$689.00" in body(entry)["reason"] and case.refunded == {}
    at_limit = run(case, "process_refund", {"order_id": "LF-2003", "amount_usd": 500, "reason": "wobbly"})
    assert at_limit["blocked_by"] is None and not at_limit["result"]["isError"]  # $500 is allowed, above it is not


def test_without_hooks_the_same_refund_is_not_stopped() -> None:
    case = verified("tom.bellweather@example.com")
    entry = run(case, "process_refund", {"order_id": "LF-2003", "amount_usd": 689, "reason": "x"},
                sd.Opts({"hooks": False}))
    assert not entry["result"]["isError"] and case.refunded["LF-2003"] == 689


def test_normalise_makes_every_date_iso_and_every_status_a_word() -> None:
    assert sd.normalise_date(1_793_000_000) == "2026-10-26T07:33:20Z"
    assert sd.normalise_date(1_793_000_000_000) == "2026-10-26T07:33:20Z"  # milliseconds
    assert sd.normalise_date("03/11/2026") == "2026-11-03"  # day first: this is a UK shop
    assert sd.normalise_date("2026-10-30T15:05:00+01:00") == "2026-10-30T14:05:00Z"
    assert sd.normalise_date("2026-11-16") == "2026-11-16"
    assert sd.normalise_date("soon") == "soon" and sd.normalise_date(None) is None
    out = sd.normalise({"status": 3, "placed_at": 1_793_000_000, "delivered_on": "03/11/2026", "total_cents": 3,
                        "line_items": [{"qty": 3}], "nested": {"updated_at": "2026-11-03"}})
    assert out == {"status": "shipped", "placed_at": "2026-10-26T07:33:20Z", "delivered_on": "2026-11-03", "total_cents": 3,
                   "line_items": [{"qty": 3}], "nested": {"updated_at": "2026-11-03"}}
    assert sd.normalise({"status": 99})["status"] == "unknown (99)"
    assert sd.normalise({"status": "shipped"})["status"] == "shipped"


def test_all_three_date_styles_in_the_orders_come_out_the_same_way() -> None:
    for oid in ("LF-2001", "LF-2002", "LF-2003", "LF-2008"):
        clean = sd.normalise(sd.RAW_ORDERS[oid])
        assert clean["status"] in sd.STATUS_CODES.values()
        for key in ("placed_at", "shipped_on", "delivered_on", "eta_on", "updated_at"):
            v = clean[key]
            assert v is None or sd.parse_date(v) is not None and v[:4] == "2026" and v[4] == "-", (oid, key, v)


def test_the_post_hook_shows_raw_against_normalised_in_the_trace() -> None:
    case = verified()
    entry = run(case, "lookup_order", {"order_id": "LF-2001"})
    by_field = {c["field"]: c for c in entry["changes"]}
    assert by_field["orders[0].delivered_on"] == {"field": "orders[0].delivered_on", "raw": "03/11/2026",
                                                  "normalised": "2026-11-03"}
    assert by_field["orders[0].status"]["raw"] == 4 and by_field["orders[0].status"]["normalised"] == "delivered"
    assert isinstance(by_field["orders[0].placed_at"]["raw"], int)
    off = run(verified(), "lookup_order", {"order_id": "LF-2001"}, sd.Opts({"hooks": False}))
    assert off["changes"] == [] and body(off)["orders"][0]["delivered_on"] == "03/11/2026"  # the model sees the raw string


# ----- trimming and case facts -----

def test_a_forty_field_record_is_cut_to_six_fields_and_far_fewer_tokens() -> None:
    assert len(sd.RAW_ORDERS["LF-2001"]) >= 40
    case = verified()
    entry = run(case, "lookup_order", {"order_id": "LF-2001"})
    [order] = body(entry)["orders"]
    assert list(order) == sd.TRIM_FIELDS and len(order) == 6
    assert order == {"order_id": "LF-2001", "status": "delivered", "items": "Ceramic planter set x1", "total_usd": 64.5,
                     "delivered_on": "2026-11-03", "eta_on": None}
    assert entry["raw_tokens"] > 4 * entry["context_tokens"]
    untrimmed = run(verified(), "lookup_order", {"order_id": "LF-2001"}, sd.Opts({"trim": False}))
    assert len(body(untrimmed)["orders"][0]) >= 40 and untrimmed["context_tokens"] > 4 * entry["context_tokens"]
    demo = sd.SupportDeskService(None, None).context_demo()  # type: ignore[arg-type]
    assert demo["tokens_raw"] > demo["tokens_trimmed"] * 4 and demo["fields_trimmed"] == 6


def test_case_facts_are_built_by_code_from_tool_results() -> None:
    case = verified()
    run(case, "lookup_order", {"customer_id": "C-101"})
    run(case, "process_refund", {"order_id": "LF-2001", "amount_usd": 64.5, "reason": "cracked"})
    block = sd.render_facts(case.facts)
    assert "Customer: C-101 Mira Okafor (verified)" in block
    assert "Order LF-2001: delivered, $64.50, delivered 2026-11-03" in block  # an ISO date, from "03/11/2026"
    assert "Order LF-2002: shipped, $67.00, expected 2026-11-16" in block
    assert "Refund RF-0001: $64.50 on LF-2001" in block
    assert sd.render_facts(sd.Case("x").facts).splitlines()[1] == "Customer: not verified yet"


# ----- errors -----

def test_a_transient_failure_happens_once_per_case_and_is_retryable() -> None:
    case = verified("ravi.nair@example.com")
    first = run(case, "lookup_order", {"order_id": "LF-2006"})
    assert body(first) == {"errorCategory": "transient", "isRetryable": True,
                           "message": "The order system did not answer in time. Trying again usually works."}
    assert first["result"]["isError"] is True
    second = run(case, "lookup_order", {"order_id": "LF-2006"})
    assert not second["result"]["isError"] and body(second)["orders"][0]["status"] == "shipped"
    other = verified("ravi.nair@example.com")  # a new conversation fails once again
    assert run(other, "lookup_order", {"order_id": "LF-2006"})["result"]["isError"]


def test_a_business_error_explains_the_rule_and_is_not_retryable() -> None:
    case = verified("ana.petrov@example.com")
    err = body(run(case, "process_refund", {"order_id": "LF-2008", "amount_usd": 10, "reason": "x"}))
    assert err["errorCategory"] == "business" and err["isRetryable"] is False
    assert "2026-08-02" in err["message"] and "30 day refund window" in err["message"]
    shipped = verified()
    err2 = body(run(shipped, "process_refund", {"order_id": "LF-2002", "amount_usd": 10, "reason": "x"}))
    assert err2["errorCategory"] == "business" and "not been delivered" in err2["message"]


def test_validation_errors_for_bad_refund_input_and_overrefunds() -> None:
    case = verified()
    for amount in (0, -5, "ten", None, True):
        assert body(run(case, "process_refund", {"order_id": "LF-2001", "amount_usd": amount, "reason": "x"}))[
            "errorCategory"] == "validation"
    assert not run(case, "process_refund", {"order_id": "LF-2001", "amount_usd": 60, "reason": "x"})["result"]["isError"]
    over = body(run(case, "process_refund", {"order_id": "LF-2001", "amount_usd": 10, "reason": "x"}))
    assert over["errorCategory"] == "validation" and "$4.50" in over["message"]
    assert body(run(case, "lookup_order", {}))["errorCategory"] == "validation"


def test_an_empty_result_is_a_success_and_different_from_a_failure() -> None:
    case = verified("leo.marsh@example.com")
    entry = run(case, "lookup_order", {"customer_id": "C-107"})
    assert entry["result"]["isError"] is False
    assert body(entry) == {"count": 0, "orders": [], "message": "This customer has no orders."}
    assert "errorCategory" not in body(entry)
    assert sd.classify(case) == "resolved"  # the question was answered


# ----- escalation -----

def test_the_handoff_summary_has_what_a_human_needs_and_code_fills_the_gaps() -> None:
    case = verified("tom.bellweather@example.com")
    run(case, "lookup_order", {"order_id": "LF-2003"})
    run(case, "process_refund", {"order_id": "LF-2003", "amount_usd": 689, "reason": "wobbly"})
    entry = run(case, "escalate_to_human", {"reason": "over_limit", "issue": "Wobbly bench, wants full refund",
                                            "recommended_action": "Approve a $689 refund", "tried": ["Offered a repair"]})
    out = body(entry)
    assert out["ticket_id"] == "ESC-0001"
    handoff = out["handoff"]
    assert set(handoff) == {"customer_id", "customer_name", "issue", "root_cause", "amount_usd", "order_ids", "tried",
                            "recommended_action", "reason", "tool_log", "customer_asked"}
    assert handoff["customer_id"] == "C-102" and handoff["customer_name"] == "Tom Bellweather"
    assert handoff["amount_usd"] == 689.0 and handoff["root_cause"] == "Not established"  # filled by code
    assert handoff["order_ids"] == ["LF-2003"] and handoff["reason"] == "over_limit"
    assert handoff["tried"] == ["Offered a repair"]
    assert handoff["tool_log"] == ["get_customer: ok", "lookup_order: ok", "process_refund: failed (permission)"]
    assert sd.classify(case) == "escalated"


def test_escalating_needs_no_verification_but_does_need_an_issue_and_a_recommendation() -> None:
    case = sd.Case("t")
    assert body(run(case, "escalate_to_human", {"reason": "customer_requested", "issue": " "}))["errorCategory"] == "validation"
    ok = run(case, "escalate_to_human", {"reason": "customer_requested", "issue": "Wants a person",
                                         "recommended_action": "Call back"})
    assert not ok["result"]["isError"] and body(ok)["handoff"]["customer_id"] is None
    assert body(ok)["handoff"]["reason"] == "customer_requested"
    bad = sd.build_handoff(case, {"reason": "nonsense", "issue": "x", "recommended_action": "y", "amount_usd": "lots"})
    assert bad["reason"] == "other" and bad["amount_usd"] is None


# ----- tool descriptions and least privilege -----

def test_the_vague_set_overlaps_and_the_clear_set_does_not() -> None:
    vague, clear = {t["name"]: t for t in sd.VAGUE_TOOLS}, {t["name"]: t for t in sd.CLEAR_TOOLS}
    assert {"check_order", "lookup_order"} <= set(vague) and "check_order" not in clear
    assert len(vague["check_order"]["description"]) < 20 and len(clear["lookup_order"]["description"]) > 150
    assert [t["name"] for t in sd.tool_set(False, True)][-1] == "delete_account"
    assert "delete_account" not in [t["name"] for t in sd.tool_set(True, False)]


def test_a_tool_that_is_not_offered_cannot_be_called_but_an_offered_dangerous_one_runs_and_is_only_logged() -> None:
    case = sd.Case("t")
    assert body(run(case, "delete_account", {"customer_id": "C-101"}))["errorCategory"] == "validation"
    assert case.deleted == []
    entry = run(case, "delete_account", {"customer_id": "C-101"}, sd.Opts({"dangerous_tool": True}))
    assert entry["dangerous"] and case.deleted == ["C-101"] and "AUDIT delete_account" in entry["audit"]


# ----- the loop, scripted -----

def test_the_loop_continues_on_tool_use_and_stops_on_end_turn_and_blocks_a_big_refund() -> None:
    svc, client = service([
        [use("get_customer", {"email": "tom.bellweather@example.com"}, 1)],
        [text("Let me check that."), use("process_refund", {"order_id": "LF-2003", "amount_usd": 689, "reason": "wobbly"}, 2)],
        [use("escalate_to_human", {"reason": "over_limit", "issue": "Wants $689 back", "recommended_action": "Approve"}, 3)],
        [text("I've passed this to a colleague, who will contact you within one working day.")],
    ])
    out = svc.chat({"message": "I want $689 back for LF-2003. tom.bellweather@example.com", "model": HAIKU})
    assert out["iterations"] == 4 and out["stop_reason"] == "end_turn" and out["stopped"] is None
    assert out["outcome"] == "escalated" and "colleague" in out["reply"]
    models = [t for t in out["trace"] if t["kind"] == "model"]
    assert [m["stop_reason"] for m in models] == ["tool_use", "tool_use", "tool_use", "end_turn"]
    assert models[0]["decision"].startswith("continue") and models[-1]["decision"].startswith("stop")
    tools = [t for t in out["trace"] if t["kind"] == "tool"]
    assert [(t["name"], t["blocked_by"]) for t in tools] == [("get_customer", None), ("process_refund", "pre_hook"),
                                                              ("escalate_to_human", None)]
    # Each tool result went back to the model as a tool_result in a user message, with isError as is_error.
    second = client.calls[2][1]["messages"]
    assert second[-1]["content"][0]["type"] == "tool_result" and second[-1]["content"][0]["is_error"] is True
    assert json.loads(second[-1]["content"][0]["content"][0]["text"])["required_action"] == "escalate_to_human"
    assert "get_customer" in {t["name"] for t in client.calls[0][1]["tools"]}
    assert "CASE FACTS" in client.calls[0][1]["system"] and "Customer: not verified yet" in client.calls[0][1]["system"]
    assert "Customer: C-102 Tom Bellweather (verified)" in client.calls[1][1]["system"]  # facts follow the case
    assert svc.spend.calls == 4 and out["cost_usd"] > 0


def test_the_loop_retries_a_transient_failure_and_keeps_the_conversation_for_the_next_message() -> None:
    svc, client = service([
        [use("get_customer", {"email": "ravi.nair@example.com"}, 1)],
        [use("lookup_order", {"order_id": "LF-2006"}, 2)],
        [use("lookup_order", {"order_id": "LF-2006"}, 3)],
        [text("Order LF-2006 has shipped and is due on 2026-11-17.")],
        [text("Anything else?")],
    ])
    out = svc.chat({"message": "Where is LF-2006? ravi.nair@example.com", "model": HAIKU})
    lookups = [t for t in out["trace"] if t["kind"] == "tool" and t["name"] == "lookup_order"]
    assert [t["result"]["isError"] for t in lookups] == [True, False] and out["outcome"] == "resolved"
    again = svc.chat({"case_id": out["case_id"], "message": "No thanks.", "model": HAIKU})
    assert again["case_id"] == out["case_id"] and again["verified"] == "C-106"
    assert len(client.calls[-1][1]["messages"]) == 9  # history carried over: user, 3 x (assistant, results), answer, user
    with pytest.raises(ApiError):
        svc.chat({"case_id": "0" * 12, "message": "hi", "model": HAIKU})


def test_the_iteration_cap_is_only_a_safety_stop() -> None:
    svc, _ = service([[use("lookup_order", {"order_id": "LF-2001"}, i)] for i in range(1, sd.MAX_ITERATIONS + 1)])
    out = svc.chat({"message": "loop forever", "model": HAIKU})
    assert out["iterations"] == sd.MAX_ITERATIONS and out["stopped"].startswith("Safety stop")
    assert out["trace"][-1]["kind"] == "safety_stop" and out["stop_reason"] == "tool_use"


def test_a_failed_model_call_leaves_the_history_valid() -> None:
    svc, _ = service([])  # nothing scripted: the first call raises
    with pytest.raises(Exception):
        svc.chat({"message": "hello", "model": HAIKU})
    [case] = svc._cases.values()
    assert case.messages == []


# ----- classification and the evaluation -----

def test_outcomes_come_from_the_tools_not_the_words() -> None:
    case = sd.Case("t")
    run(case, "get_customer", {"name": "Jamie Hart"})
    assert sd.classify(case) == "asked_identifier"
    assert sd.check_case(sd.EVAL_CASES[4], case) == (True, [])
    assert sd.classify(sd.Case("x")) == "unresolved"
    assert sd.check_case(sd.EVAL_CASES[0], sd.Case("x"))[0] is False
    assert len(sd.EVAL_CASES) == 8 and {c["expect"] for c in sd.EVAL_CASES} == {"resolved", "escalated", "asked_identifier"}


def test_the_summary_reports_first_contact_resolution_and_routing() -> None:
    rows = [{"passed": True, "expect": "resolved", "outcome": "resolved"},
            {"passed": False, "expect": "resolved", "outcome": "escalated"},
            {"passed": True, "expect": "escalated", "outcome": "escalated"},
            {"passed": True, "expect": "asked_identifier", "outcome": "asked_identifier"}]
    s = sd.summarise(rows)
    assert (s["total"], s["passed"], s["resolved"], s["escalated"]) == (4, 3, 1, 2)
    assert s["fcr_rate"] == 0.25 and s["resolvable_fcr"] == 0.5 and s["correct_routing"] == 0.75
    assert sd.summarise([])["fcr_rate"] is None


def test_the_transient_case_requires_a_retry_to_pass() -> None:
    case = verified("ravi.nair@example.com")
    spec = next(c for c in sd.EVAL_CASES if c["id"] == "outage")
    run(case, "lookup_order", {"order_id": "LF-2006"})
    assert sd.check_case(spec, case)[0] is False  # outcome is not resolved yet
    run(case, "lookup_order", {"order_id": "LF-2006"})
    assert sd.check_case(spec, case) == (True, [])


# ----- tool selection and tool_choice -----

def test_the_selection_test_records_the_first_tool_and_flags_misrouting() -> None:
    calls = ["get_customer", "check_order", "process_refund", "escalate_to_human", "get_customer", "lookup_order"]
    svc, client = service([[use(n, {}, i)] for i, n in enumerate(calls)])
    out = svc.tool_selection({"vague_tools": True, "model": HAIKU})
    assert out["set"] == "vague" and out["correct"] == 5 and out["total"] == 6
    wrong = [r for r in out["rows"] if not r["correct"]]
    assert len(wrong) == 1 and wrong[0]["called"] == "check_order" and wrong[0]["overlap"] is True
    assert all(c[1]["tool_choice"] == {"type": "any"} for c in client.calls)
    assert "check_order" in {t["name"] for t in client.calls[0][1]["tools"]}
    clear, c2 = service([[use(n.replace("check_order", "lookup_order"), {}, i)] for i, n in enumerate(calls)])
    assert clear.tool_selection({"model": HAIKU})["correct"] == 6
    assert "check_order" not in {t["name"] for t in c2.calls[0][1]["tools"]}


def test_a_dangerous_tool_adds_a_probe_and_counts_its_use() -> None:
    calls = ["get_customer", "lookup_order", "process_refund", "escalate_to_human", "get_customer", "lookup_order",
             "delete_account"]
    svc, client = service([[use(n, {"customer_id": "C-1"}, i)] for i, n in enumerate(calls)])
    out = svc.tool_selection({"dangerous_tool": True, "model": HAIKU})
    assert out["total"] == 7 and out["dangerous_calls"] == 1 and out["rows"][-1]["correct"] is False
    assert "delete_account" in {t["name"] for t in client.calls[0][1]["tools"]}


def test_tool_choice_runs_auto_any_and_forced() -> None:
    svc, client = service([[text("Sorry to hear that. Could you confirm your email?")],
                           [use("lookup_order", {"order_id": "LF-2001"}, 1)],
                           [use("get_customer", {"email": "mira.okafor@example.com"}, 2)]])
    out = svc.tool_choice({"model": HAIKU})
    assert [r["mode"] for r in out["runs"]] == ["auto", "any", "forced"]
    assert [c[1]["tool_choice"] for c in client.calls] == [{"type": "auto"}, {"type": "any"},
                                                            {"type": "tool", "name": "get_customer"}]
    assert out["runs"][0]["tool_calls"] == [] and out["runs"][0]["text"].startswith("Sorry")
    assert out["runs"][1]["tool_calls"][0]["name"] == "lookup_order" and out["runs"][2]["stop_reason"] == "tool_use"
    assert out["cost_usd"] > 0


def test_the_info_is_free_and_complete() -> None:
    info = service([])[0].info()
    assert len(info["eval_cases"]) == 8 and len(info["selection_requests"]) == 7 and info["refund_limit_usd"] == 500
    assert info["customers"][0]["orders"] == ["LF-2001", "LF-2002"] and info["context"]["fields_trimmed"] == 6
    assert "Examples of the escalation judgement" in info["system_prompt"]


# ----- the routes, once wired -----

def _wired() -> bool:
    from backend.app import api
    from backend.app.api import deps
    return "support_desk" in Path(api.__file__).read_text() and hasattr(deps, "support_desk")


needs_route = pytest.mark.skipif(not _wired(), reason="route not wired yet")


def routed(script: list[list[dict]], tmp_path: Path) -> TestClient:
    return TestClient(create_app(Settings.from_env(), ScriptedClient(script)))


@needs_route
def test_the_chat_route_runs_the_loop_and_is_guarded(tmp_path: Path) -> None:
    client = routed([[use("get_customer", {"email": "mira.okafor@example.com"})], [text("Hello Mira, how can I help?")]],
                    tmp_path)
    r = client.post("/api/support-desk/chat", headers=LAB, json={"message": "Hi, mira.okafor@example.com", "model": HAIKU})
    assert r.status_code == 200 and r.json()["verified"] == "C-101" and r.json()["reply"].startswith("Hello Mira")
    assert client.post("/api/support-desk/chat", json={"message": "hi"}).status_code in (400, 403)
    assert client.post("/api/support-desk/chat", headers=LAB, json={"message": "hi", "model": "gpt-nope"}).status_code == 400
    assert client.get("/api/support-desk/info", headers=LAB).json()["shop"] == sd.SHOP


@needs_route
def test_the_evaluate_route_streams_cases_and_a_summary(tmp_path: Path) -> None:
    script = [[text("Please give me your email address.")] for _ in range(2)]
    client = routed(script, tmp_path)
    r = client.post("/api/support-desk/evaluate", headers=LAB, json={"cases": ["human", "several"], "model": HAIKU})
    events = [json.loads(line) for line in r.text.splitlines() if line.strip()]
    assert [e["type"] for e in events if e["type"] in ("start", "case", "done")] == ["start", "case", "case", "done"]
    done = events[-1]
    assert done["summary"]["total"] == 2 and done["summary"]["passed"] == 0 and done["cost_usd"] > 0


# ---------- found by code review: refusals and errors mid-turn ----------

def test_a_refusal_leaves_a_history_the_next_turn_can_send() -> None:
    svc, client = service([[], [text("Happy to help. What is your order number?")]])
    client.script[0] = []  # no blocks at all, as a refusal or an empty reply has

    def refuse(**params: Any) -> Any:
        from backend.tests.test_aftercare import reply
        client.calls.append(("messages.create", params))
        client.script.pop(0)
        return reply(params["model"], stop="refusal")

    first_create = client.messages.create
    client.messages.create = lambda **p: refuse(**p) if len(client.calls) == 0 else first_create(**p)  # type: ignore[method-assign]
    out = svc.chat({"message": "Help me with something odd.", "model": HAIKU})
    assert out["stop_reason"] == "refusal" and out["reply"] == "The assistant declined to answer that message."
    again = svc.chat({"case_id": out["case_id"], "message": "Sorry, I mean my order.", "model": HAIKU})
    sent = client.calls[-1][1]["messages"]
    assert all(m["content"] for m in sent if m["role"] == "assistant")  # no empty assistant turn reaches the API
    assert again["reply"].startswith("Happy to help")


class FailsAfter(ScriptedClient):
    """Answers the scripted replies, then raises: the API failing part-way through a turn."""

    def __init__(self, script: list[list[dict]], fail_on: int) -> None:
        super().__init__(script)
        scripted, self.n = self.messages.create, 0

        def create(**params: Any) -> Any:
            self.n += 1
            if self.n == fail_on:
                raise RuntimeError("overloaded")
            return scripted(**params)

        self.messages.create = create  # type: ignore[method-assign]


def test_an_error_after_a_refund_keeps_the_refund_and_the_history_in_step() -> None:
    client = FailsAfter([
        [use("get_customer", {"email": "mira.okafor@example.com"}, 1)],
        [use("process_refund", {"order_id": "LF-2001", "amount_usd": 20, "reason": "chipped"}, 2)],
        [text("Done.")],  # never reached: the third call fails
    ], fail_on=3)
    svc = sd.SupportDeskService(ClaudeGateway(client), SpendTracker(1.0))
    case = svc._case(None)
    with pytest.raises(Exception):
        svc.run_turn(case, "Refund $20 on LF-2001 please, mira.okafor@example.com", HAIKU, sd.Opts())
    assert case.refunded.get("LF-2001") == 20  # the refund happened and is not forgotten
    history = json.dumps(case.messages)
    assert "process_refund" in history and "cut off by an error" in history  # the model will see it next time
    assert case.messages[-1]["role"] == "assistant"  # roles still alternate for the next message


def test_an_error_before_any_tool_undoes_the_turn() -> None:
    client = FailsAfter([], fail_on=1)
    svc = sd.SupportDeskService(ClaudeGateway(client), SpendTracker(1.0))
    case = svc._case(None)
    with pytest.raises(Exception):
        svc.run_turn(case, "Hello?", HAIKU, sd.Opts())
    assert case.messages == [] and case.facts["customer_asked"] == []
