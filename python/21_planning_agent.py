"""A planning agent: the model writes the whole plan first, the code runs it, and the model replans when a step fails.

Companion to the Harness engineering lab. The task is a weekend in Edinburgh for Jordan Ellis (invented), within a
budget. Three stages:
1. Plan. The model returns every step as structured data: an id, a tool, its arguments, the steps it depends on and
   why. Nothing has run yet, so the plan can be read, checked and refused before any money is spent (--plan-only
   stops here).
2. Execute. The code, not the model, runs the steps in dependency order against mock travel tools. Each step is
   checked first: a tool that does not exist, a missing argument, a dependency that has not succeeded, or a booking
   that would go over budget is refused. Bookings ask a person first, as in 06_agent_loop.py, unless --auto-approve.
3. Replan. The cheapest hotel sells out between the search and the booking. The model gets the plan, what has run
   and the failure, and returns new steps for the rest of the work. Replans are capped (--max-replans).
Finally the model writes the itinerary from the results alone.

    python 21_planning_agent.py --plan-only        # write the plan and stop
    python 21_planning_agent.py                    # plan, run, replan; asks before each booking
    python 21_planning_agent.py --auto-approve
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field

from common import create, cost_usd, describe_usage, ensure_answered, make_client, model_argument, run, text_of

TRAVELLER = "Jordan Ellis"
BUDGET_GBP = 300
TASK = f"""Plan a weekend in Edinburgh for {TRAVELLER}, travelling from York.
- Out on Saturday 2026-11-21, arriving in Edinburgh by 12:00. Back on Sunday 2026-11-22, leaving Edinburgh after 15:00.
- One night in a hotel. Jordan likes history and food.
- Book one event on each day. Indoors on any day the forecast is rain.
- Everything booked must come to no more than £{BUDGET_GBP} in total."""

# The mock world. Prices in pounds. HT-1 is cheapest and sells out between search and booking.
TRAINS = [
    {"id": "TR-101", "from": "york", "to": "edinburgh", "date": "2026-11-21", "depart": "07:05", "arrive": "09:40",
     "price": 52},
    {"id": "TR-102", "from": "york", "to": "edinburgh", "date": "2026-11-21", "depart": "08:30", "arrive": "11:05",
     "price": 41},
    {"id": "TR-103", "from": "york", "to": "edinburgh", "date": "2026-11-21", "depart": "10:15", "arrive": "12:50",
     "price": 29},
    {"id": "TR-201", "from": "edinburgh", "to": "york", "date": "2026-11-22", "depart": "13:30", "arrive": "16:05",
     "price": 30},
    {"id": "TR-202", "from": "edinburgh", "to": "york", "date": "2026-11-22", "depart": "16:00", "arrive": "18:35",
     "price": 38},
    {"id": "TR-203", "from": "edinburgh", "to": "york", "date": "2026-11-22", "depart": "18:45", "arrive": "21:20",
     "price": 45},
]
HOTELS = [
    {"id": "HT-1", "name": "Canongate Rooms", "area": "Old Town", "price_per_night": 72, "rating": 4.1},
    {"id": "HT-2", "name": "Leith Lodge", "area": "Leith", "price_per_night": 85, "rating": 4.4},
    {"id": "HT-3", "name": "Calton Hill Suites", "area": "New Town", "price_per_night": 140, "rating": 4.8},
]
WEATHER = {"2026-11-21": {"forecast": "rain", "chance_of_rain": 0.85, "high_c": 7},
           "2026-11-22": {"forecast": "dry, cloudy", "chance_of_rain": 0.15, "high_c": 9}}
EVENTS = [
    {"id": "EV-1", "date": "2026-11-21", "name": "Old Town ghost walk", "interest": "history", "setting": "outdoor",
     "time": "19:00", "price": 15},
    {"id": "EV-2", "date": "2026-11-21", "name": "Museum of the Northern Kingdom: guided tour", "interest": "history",
     "setting": "indoor", "time": "14:00", "price": 18},
    {"id": "EV-3", "date": "2026-11-21", "name": "Scottish cheese and whisky tasting", "interest": "food",
     "setting": "indoor", "time": "17:00", "price": 35},
    {"id": "EV-4", "date": "2026-11-22", "name": "Leith food market tour", "interest": "food", "setting": "outdoor",
     "time": "10:30", "price": 25},
    {"id": "EV-5", "date": "2026-11-22", "name": "Holyrood Abbey ruins talk", "interest": "history",
     "setting": "outdoor", "time": "11:00", "price": 12},
    {"id": "EV-6", "date": "2026-11-22", "name": "Edinburgh Larder cookery class", "interest": "food",
     "setting": "indoor", "time": "11:00", "price": 40},
]

# What each tool needs. Every argument arrives as a string; the code converts and checks it.
TOOL_ARGS = {
    "search_trains": ["from_city", "to_city", "date", "arrive_by_or_leave_after"],
    "search_hotels": ["city", "check_in", "nights"],
    "get_weather": ["city", "date"],
    "find_events": ["city", "date", "interest", "setting"],
    "book": ["from_step", "choose"],
}
TOOL_HELP = """- search_trains(from_city, to_city, date, arrive_by_or_leave_after): trains on that date. The last argument
  is "arrive_by HH:MM" or "leave_after HH:MM" and filters the list.
- search_hotels(city, check_in, nights): hotels with a room free, cheapest first.
- get_weather(city, date): the forecast.
- find_events(city, date, interest, setting): events. interest is history, food or any; setting is indoor, outdoor
  or any.
- book(from_step, choose): books one item from the results of an earlier search step, which must be in this step's
  depends_on. choose is cheapest, earliest or top_rated. A person approves every booking."""
CHOICES = {"cheapest", "earliest", "top_rated"}


class StepFailed(Exception):
    """A step was refused before it ran, or failed when it ran. The message goes back to the model."""


@dataclass
class Step:
    id: str
    tool: str
    arguments: dict[str, str]
    depends_on: list[str]
    why: str

    @classmethod
    def from_json(cls, raw: dict) -> "Step":
        return cls(raw["id"], raw["tool"], {a["name"]: a["value"] for a in raw["arguments"]}, list(raw["depends_on"]),
                   raw["why"])

    def call(self) -> str:
        return f"{self.tool}({', '.join(f'{k}={v!r}' for k, v in self.arguments.items())})"


@dataclass
class World:
    """The mock travel systems and what has been booked so far."""
    budget: int = BUDGET_GBP
    sold_out: set[str] = field(default_factory=set)
    sells_out_on_booking: set[str] = field(default_factory=lambda: {"HT-1"})
    bookings: list[dict] = field(default_factory=list)

    @property
    def spent(self) -> int:
        return sum(b["price"] for b in self.bookings)


def parse_time(value: str, prefix: str) -> str:
    return value.strip().removeprefix(prefix).strip()


def run_tool(step: Step, world: World, results: dict[str, list[dict]], approve) -> list[dict] | dict:
    """Run one checked step against the mock systems."""
    a = {k: v.strip() for k, v in step.arguments.items()}
    if step.tool == "search_trains":
        rule = a["arrive_by_or_leave_after"].lower()
        found = [t for t in TRAINS if t["from"] == a["from_city"].lower() and t["to"] == a["to_city"].lower()
                 and t["date"] == a["date"]]
        if rule.startswith("arrive_by"):
            found = [t for t in found if t["arrive"] <= parse_time(rule, "arrive_by")]
        elif rule.startswith("leave_after"):
            found = [t for t in found if t["depart"] >= parse_time(rule, "leave_after")]
        else:
            raise StepFailed("arrive_by_or_leave_after must start with arrive_by or leave_after.")
        return [{**t, "kind": "train"} for t in found]
    if step.tool == "search_hotels":
        if a["city"].lower() != "edinburgh":
            return []
        try:
            nights = int(a["nights"])
        except ValueError:
            raise StepFailed("nights must be a whole number.") from None
        free = sorted((h for h in HOTELS if h["id"] not in world.sold_out), key=lambda h: h["price_per_night"])
        return [{**h, "kind": "hotel", "check_in": a["check_in"], "nights": nights,
                 "price": h["price_per_night"] * nights} for h in free]
    if step.tool == "get_weather":
        if a["date"] not in WEATHER:
            raise StepFailed(f"No forecast for {a['date']}.")
        return {"city": a["city"], "date": a["date"], **WEATHER[a["date"]]}
    if step.tool == "find_events":
        interest, setting = a["interest"].lower(), a["setting"].lower()
        return [{**e, "kind": "event"} for e in EVENTS if e["date"] == a["date"]
                and interest in ("any", e["interest"]) and setting in ("any", e["setting"])]
    if step.tool == "book":
        return book(a["from_step"], a["choose"].lower(), world, results, approve)
    raise StepFailed(f"Unknown tool {step.tool}.")


def book(from_step: str, choose: str, world: World, results: dict[str, list[dict]], approve) -> dict:
    options = results.get(from_step)
    if not isinstance(options, list):
        raise StepFailed(f"Step {from_step} is not a search that has run.")
    if not options:
        raise StepFailed(f"Step {from_step} found nothing to book.")
    if choose not in CHOICES:
        raise StepFailed(f"choose must be one of {', '.join(sorted(CHOICES))}.")
    key = {"cheapest": lambda o: o["price"],
           "earliest": lambda o: o.get("depart") or o.get("time") or "",
           "top_rated": lambda o: -o.get("rating", 0)}[choose]
    item = min(options, key=key)
    if world.spent + item["price"] > world.budget:
        raise StepFailed(f"Booking {item['id']} at £{item['price']} would bring the total to "
                         f"£{world.spent + item['price']}, over the £{world.budget} budget. Refused.")
    if item["id"] in world.sells_out_on_booking or item["id"] in world.sold_out:
        world.sold_out.add(item["id"])
        raise StepFailed(f"{item['id']} ({item.get('name', item['kind'])}) sold out after the search ran. "
                         "Search results are a snapshot: search again for what is free now.")
    if not approve(item):
        raise StepFailed(f"A person declined to book {item['id']}.")
    booking = {"id": item["id"], "kind": item["kind"], "name": item.get("name", f"{item.get('from', '')} to "
               f"{item.get('to', '')} {item.get('depart', '')}".strip()), "price": item["price"]}
    world.bookings.append(booking)
    return {"booked": booking, "total_spent": world.spent, "budget_left": world.budget - world.spent}


def validate(steps: list[Step], done: set[str] = frozenset()) -> list[str]:
    """Everything wrong with a plan, before any of it runs. done holds the ids of steps that already succeeded."""
    problems, ids = [], [s.id for s in steps]
    if len(set(ids)) != len(ids):
        problems.append("Two steps share an id.")
    for step in steps:
        if step.id in done:
            problems.append(f"{step.id}: that id was already used by a step that ran. Use a new id.")
        if step.tool not in TOOL_ARGS:
            problems.append(f"{step.id}: unknown tool {step.tool}.")
            continue
        missing = [a for a in TOOL_ARGS[step.tool] if a not in step.arguments]
        extra = [a for a in step.arguments if a not in TOOL_ARGS[step.tool]]
        if missing:
            problems.append(f"{step.id}: {step.tool} is missing {', '.join(missing)}.")
        if extra:
            problems.append(f"{step.id}: {step.tool} does not take {', '.join(extra)}.")
        for dep in step.depends_on:
            if dep not in ids and dep not in done:
                problems.append(f"{step.id}: depends on {dep}, which is neither in the plan nor done.")
        if step.tool == "book" and step.arguments.get("from_step") not in step.depends_on:
            problems.append(f"{step.id}: book's from_step must be one of its depends_on.")
    if not problems:
        try:
            order(steps, done)
        except StepFailed as exc:
            problems.append(str(exc))
    return problems


def order(steps: list[Step], done: set[str] = frozenset()) -> list[Step]:
    """Steps in an order where each runs after what it depends on. Plan order breaks ties."""
    placed, result, pending = set(done), [], list(steps)
    while pending:
        ready = next((s for s in pending if all(d in placed for d in s.depends_on)), None)
        if ready is None:
            raise StepFailed(f"The plan has a cycle among {', '.join(s.id for s in pending)}.")
        result.append(ready)
        placed.add(ready.id)
        pending.remove(ready)
    return result


PLAN_FORMAT = {"format": {"type": "json_schema", "schema": {
    "type": "object",
    "properties": {"steps": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "id": {"type": "string"},
            "tool": {"type": "string"},
            "arguments": {"type": "array", "items": {
                "type": "object", "properties": {"name": {"type": "string"}, "value": {"type": "string"}},
                "required": ["name", "value"], "additionalProperties": False}},
            "depends_on": {"type": "array", "items": {"type": "string"}},
            "why": {"type": "string"}},
        "required": ["id", "tool", "arguments", "depends_on", "why"], "additionalProperties": False}}},
    "required": ["steps"], "additionalProperties": False}}}

PLANNER = f"""You are the planner in a plan-and-execute agent. You do not run anything. You write a complete plan
that code will run step by step with these tools:
{TOOL_HELP}
Rules for the plan:
- Give every step a short unique id such as s1, s2. List in depends_on every step whose result it needs.
- Arguments are name and value pairs, all strings. Dates are YYYY-MM-DD. Cities are plain names such as York.
- Search before you book, and book only from a search step listed in depends_on.
- You cannot see results while planning, so write steps that work whatever the searches find.
- Keep the plan short: only the steps the task needs."""


class Planner:
    """Asks the model for plans and the itinerary, and keeps count of the cost."""

    def __init__(self, client, model: str):
        self.client, self.model, self.cost, self.calls = client, model, 0.0, 0

    def ask(self, prompt: str, system: str, structured: bool) -> str:
        params = {"output_config": PLAN_FORMAT} if structured else {}
        response = create(self.client, model=self.model, max_tokens=16000, system=system,
                          messages=[{"role": "user", "content": prompt}], **params)
        ensure_answered(response)
        self.calls += 1
        self.cost += cost_usd(response.usage, self.model) or 0
        print(f"  [model call {self.calls}: {describe_usage(response.usage, self.model)}]")
        return text_of(response)

    def plan(self, prompt: str) -> list[Step]:
        return [Step.from_json(s) for s in json.loads(self.ask(prompt, PLANNER, structured=True))["steps"]]


def first_plan_prompt() -> str:
    return f"Task:\n{TASK}\n\nWrite the plan."


def replan_prompt(steps: list[Step], results: dict, failure: str) -> str:
    return (f"Task:\n{TASK}\n\nThe plan so far:\n{json.dumps([s.__dict__ for s in steps], indent=1)}\n\n"
            f"Steps that ran, with their results:\n{json.dumps(results, indent=1)}\n\nWhat went wrong:\n{failure}\n\n"
            "Write new steps for the rest of the work only. Steps that ran stay done: depend on them by id, and give "
            "new steps new ids.")


def fix_prompt(problems: list[str], prompt: str) -> str:
    return f"{prompt}\n\nYour last plan was refused before it ran:\n- " + "\n- ".join(problems) + "\nWrite it again."


def print_plan(steps: list[Step], title: str) -> None:
    print(f"\n{title}")
    print(f"  {'id':<5} {'after':<10} call")
    for s in steps:
        print(f"  {s.id:<5} {','.join(s.depends_on) or '-':<10} {s.call()}\n  {'':<16} why: {s.why}")


def print_diff(old: list[Step], new: list[Step]) -> None:
    old_calls, new_calls = {s.call() for s in old}, {s.call() for s in new}
    print("\nWhat the replan changed:")
    for s in old:
        if s.call() not in new_calls:
            print(f"  - {s.id} {s.call()}")
    for s in new:
        print(f"  {'+' if s.call() not in old_calls else '='} {s.id} {s.call()}")


def plan_checked(planner: Planner, prompt: str, done: set[str]) -> list[Step]:
    """A plan that passes validation, asking the model to fix it once if it does not."""
    steps = planner.plan(prompt)
    problems = validate(steps, done)
    if problems:
        print("\nPlan refused before running:\n  " + "\n  ".join(problems))
        steps = planner.plan(fix_prompt(problems, prompt))
        problems = validate(steps, done)
        if problems:
            raise SystemExit("The plan was refused twice:\n  " + "\n  ".join(problems))
    return steps


def execute(steps: list[Step], world: World, results: dict, approve) -> tuple[Step, str] | None:
    """Run the steps in order. Returns the failing step and why, or None when every step succeeded."""
    for step in order(steps, set(results)):
        print(f"\n> {step.id}: {step.call()}")
        try:
            missing = [d for d in step.depends_on if d not in results]
            if missing:
                raise StepFailed(f"{step.id} needs {', '.join(missing)}, which did not succeed.")
            output = run_tool(step, world, results, approve)
        except StepFailed as exc:
            print(f"  FAILED: {exc}")
            return step, f"{step.id} ({step.call()}) failed: {exc}"
        results[step.id] = output
        shown = json.dumps(output)
        print(f"  {shown[:300]}{'...' if len(shown) > 300 else ''}")
    return None


def ask_person(item: dict) -> bool:
    label = item.get("name") or f"{item['from']} to {item['to']} at {item['depart']}"
    return input(f"  Book {item['id']} ({label}) for £{item['price']}? [y/N] ").strip().lower() == "y"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--plan-only", action="store_true", help="write and check the plan, then stop")
    parser.add_argument("--auto-approve", action="store_true", help="approve bookings without asking")
    parser.add_argument("--max-replans", type=int, default=2)
    model_argument(parser)
    args = parser.parse_args()
    planner = Planner(make_client(), args.model)
    approve = (lambda item: True) if args.auto_approve else ask_person

    print(f"Task:\n{TASK}")
    steps = plan_checked(planner, first_plan_prompt(), set())
    print_plan(steps, "Plan (nothing has run yet):")
    if args.plan_only:
        print(f"\nStopped before running. Estimated cost: ${planner.cost:.4f}.")
        return

    world, results, replans = World(), {}, 0
    while (failure := execute(steps, world, results, approve)) is not None:
        if replans == args.max_replans:
            print(f"\nStopped: still failing after {replans} replans.")
            break
        replans += 1
        print(f"\nReplan {replans} of at most {args.max_replans}.")
        remaining = [s for s in steps if s.id not in results]
        new_steps = plan_checked(planner, replan_prompt(steps, results, failure[1]), set(results))
        print_diff(remaining, new_steps)
        steps = new_steps

    booked = ", ".join(f"{b['id']} £{b['price']}" for b in world.bookings) or "nothing"
    print(f"\nBooked: {booked}. Total £{world.spent} of £{world.budget}.")
    itinerary = planner.ask(
        f"Task:\n{TASK}\n\nResults of the steps that ran:\n{json.dumps(results, indent=1)}\n\nBookings: "
        f"{json.dumps(world.bookings)}\n\nWrite Jordan's itinerary in under 200 words. Use only these results. Say "
        "plainly if anything the task asked for was not booked.",
        "You write short, plain travel itineraries from booking data.", structured=False)
    print(f"\nItinerary:\n{itinerary.strip()}")
    print(f"\nEstimated cost: ${planner.cost:.4f} over {planner.calls} model calls, {replans} replan(s).")


if __name__ == "__main__":
    run(main)
