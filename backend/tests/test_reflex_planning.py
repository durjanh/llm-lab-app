"""The reflex agent's rules and the planning agent's checks, order and replanning (python/20 and 21), offline with a
fake model: no key, no cost."""
from __future__ import annotations

import importlib
import json

import anthropic
import pytest

from backend.app import shared  # noqa: F401  (puts python/ on sys.path)

reflex = importlib.import_module("20_reflex_agent")
planning = importlib.import_module("21_planning_agent")
Step = planning.Step
MODEL = "claude-haiku-5-5"


def test_each_email_gets_the_rule_it_was_written_for():
    by_id = {email.id: reflex.decide(email) for email in reflex.INBOX}
    assert by_id[6][:2] == ("escalate:on_call", "urgent")  # "not urgent" still fires the urgent rule
    assert by_id[7][:2] == ("forward:billing", "billing")  # a follow-up read as a new request
    assert by_id[8] == ("leave_for_person", None, [])  # reworded: nothing matches
    assert by_id[9] == ("escalate:on_call", "urgent", ["urgent", "billing"])  # the first of two matches wins


def test_rules_are_scored_against_what_a_person_would_do():
    outcomes = [reflex.outcome(email, *reflex.decide(email)[:2]) for email in reflex.INBOX]
    assert reflex.score(outcomes) == {"correct": 6, "misfired": 3, "no rule": 1}
    # every email the rules get wrong says why
    assert all(email.lesson for email, result in zip(reflex.INBOX, outcomes) if result != "correct")


def step(id, tool, depends_on=(), **arguments):
    return Step(id, tool, {k: str(v) for k, v in arguments.items()}, list(depends_on), "")


SEARCH = step("s1", "search_hotels", city="Edinburgh", check_in="2026-11-21", nights=1)
BOOK = step("s2", "book", ["s1"], from_step="s1", choose="cheapest")


def test_a_good_plan_passes_and_runs_after_its_dependencies():
    assert planning.validate([BOOK, SEARCH]) == []
    assert [s.id for s in planning.order([BOOK, SEARCH])] == ["s1", "s2"]


@pytest.mark.parametrize("steps, problem", [
    ([step("s1", "teleport", city="Edinburgh")], "unknown tool teleport"),
    ([step("s1", "get_weather", city="Edinburgh")], "missing date"),
    ([step("s1", "get_weather", city="Edinburgh", date="2026-11-21", units="c")], "does not take units"),
    ([step("s2", "book", ["s9"], from_step="s9", choose="cheapest")], "depends on s9"),
    ([SEARCH, step("s2", "book", [], from_step="s1", choose="cheapest")], "from_step must be one of its depends_on"),
    ([step("a", "get_weather", ["b"], city="E", date="2026-11-21"),
      step("b", "get_weather", ["a"], city="E", date="2026-11-21")], "cycle"),
])
def test_a_bad_plan_is_refused_before_anything_runs(steps, problem):
    assert any(problem in p for p in planning.validate(steps)), planning.validate(steps)


def test_a_replan_may_depend_on_steps_that_ran_but_not_reuse_their_ids():
    assert planning.validate([BOOK], done={"s1"}) == []
    assert any("already used" in p for p in planning.validate([SEARCH], done={"s1"}))


def test_the_cheapest_hotel_sells_out_and_a_new_search_leaves_it_out():
    world, results = planning.World(), {}
    failure = planning.execute([SEARCH, BOOK], world, results, approve=lambda item: True)
    assert failure[0].id == "s2" and "sold out" in failure[1]
    assert world.bookings == [] and "HT-1" in world.sold_out
    again = planning.run_tool(SEARCH, world, results, approve=lambda item: True)
    assert [h["id"] for h in again] == ["HT-2", "HT-3"]


def test_bookings_over_budget_are_refused():
    world = planning.World(budget=100, sells_out_on_booking=set())
    results = {}
    planning.execute([step("s1", "search_hotels", city="Edinburgh", check_in="2026-11-21", nights=2)], world,
                     results, approve=lambda item: True)
    with pytest.raises(planning.StepFailed, match="over the £100 budget"):
        planning.book("s1", "cheapest", world, results, approve=lambda item: True)


def plan_reply(*steps):
    body = {"steps": [{"id": s.id, "tool": s.tool, "depends_on": s.depends_on, "why": "test",
                       "arguments": [{"name": k, "value": v} for k, v in s.arguments.items()]} for s in steps]}
    return anthropic.types.Message(id="m", type="message", role="assistant", model=MODEL, stop_reason="end_turn",
                                   content=[{"type": "text", "text": json.dumps(body)}], stop_sequence=None,
                                   usage={"input_tokens": 10, "output_tokens": 5})


class FakeClient:
    """Answers each create with the next prepared reply and records the requests."""

    def __init__(self, *replies):
        self.replies, self.requests = list(replies), []
        self.messages = self

    def create(self, **params):
        self.requests.append(params)
        return self.replies.pop(0)


def test_a_failed_booking_leads_to_a_replan_that_finishes_the_job():
    rebook = [step("s3", "search_hotels", city="Edinburgh", check_in="2026-11-21", nights=1),
              step("s4", "book", ["s3"], from_step="s3", choose="cheapest")]
    client = FakeClient(plan_reply(SEARCH, BOOK), plan_reply(*rebook))
    planner = planning.Planner(client, MODEL)
    world, results = planning.World(), {}

    steps = planning.plan_checked(planner, planning.first_plan_prompt(), set())
    failure = planning.execute(steps, world, results, approve=lambda item: True)
    assert failure is not None
    steps = planning.plan_checked(planner, planning.replan_prompt(steps, results, failure[1]), set(results))
    assert planning.execute(steps, world, results, approve=lambda item: True) is None

    assert [b["id"] for b in world.bookings] == ["HT-2"]
    replan_prompt = client.requests[1]["messages"][0]["content"]
    assert "sold out" in replan_prompt and '"s1"' in replan_prompt  # the model saw the failure and what ran
    assert client.requests[0]["output_config"] == planning.PLAN_FORMAT
