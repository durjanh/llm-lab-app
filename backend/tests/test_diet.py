"""The diet planner: targets, refusals, the plan's checks, the memory consent rule and the files, then a whole
conversation through the API with a scripted model. No network, no cost."""
from __future__ import annotations

import io
import json
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.settings import Settings
from backend.app.shared import diet_rules as rules
from backend.tests.test_aftercare import ScriptedClient, text, use
from backend.tests.test_api import LAB

ALEX = {"name": "Alex", "sex": "female", "age": 34, "height_cm": 168, "weight_kg": 74, "activity": "light",
        "goal": "lose", "diet": "vegetarian", "allergies": ["peanuts"], "dislikes": ["mushrooms"], "conditions": [],
        "pregnant_or_breastfeeding": False, "meals_per_day": 3, "cooking_minutes": 30}
DINNERS = ["Chickpea curry", "Lentil shepherd's pie", "Halloumi traybake", "Black bean chilli", "Tofu stir fry",
           "Spinach and ricotta pasta", "Vegetable paella"]


def meal(slot: str, name: str, kcal: int, protein: int, item: str = "Greek yoghurt", aisle: str = "dairy_eggs") -> dict:
    return {"slot": slot, "name": name, "method": "Mix and serve.", "kcal": kcal, "protein_g": protein,
            "prep_minutes": 15, "ingredients": [{"item": item, "quantity": 150, "unit": "g", "aisle": aisle}]}


def week(**change) -> dict:
    days = [{"day": d, "meals": [meal("breakfast", "Yoghurt and oats", 400, 30),
                                 meal("lunch", "Bean salad", 500, 35, "Kidney beans", "plant_protein"),
                                 meal("dinner", DINNERS[i], 600, 40, "Chickpeas", "plant_protein")]}
            for i, d in enumerate(rules.DAYS)]
    return {"days": days, "notes": "Cook the chilli twice and freeze half.", **change}


@pytest.fixture
def chat(tmp_path: Path) -> rules.Chat:
    return rules.new_chat(tmp_path, "Alex", consent=False)


def test_targets_come_from_the_formula_with_a_floor() -> None:
    t = rules.targets_for(ALEX)
    assert t["kcal_per_day"] == 1500 and t["protein_g_per_day"] == 118 and t["bmi"] == 26.2
    tiny = rules.targets_for({**ALEX, "height_cm": 150, "weight_kg": 58, "activity": "sedentary"})
    assert tiny["kcal_per_day"] == rules.FLOOR["female"] and tiny["floor_applied"]


@pytest.mark.parametrize("change, why", [
    ({"age": 16}, "under-18s"),
    ({"weight_kg": 50}, "underweight"),
    ({"pregnant_or_breastfeeding": True}, "pregnancy"),
    ({"conditions": ["anorexia in recovery"]}, "care team"),
])
def test_unsafe_plans_are_refused_by_code(chat: rules.Chat, change: dict, why: str) -> None:
    result = chat.call("set_profile", {**ALEX, **change})
    assert why in result["refused"] and chat.targets is None
    assert "error" in chat.call("save_week_plan", week())


def test_a_condition_adds_a_note_to_see_a_gp() -> None:
    assert "GP or dietitian" in rules.targets_for({**ALEX, "conditions": ["type 2 diabetes"]})["notes"][0]


def test_eating_disorder_signs_get_a_fixed_reply_and_no_model_call(chat: rules.Chat) -> None:
    def create(**_):
        raise AssertionError("the model must not be called")

    reply, steps = rules.diet_turn(create, chat, "claude-haiku-5-5", "Plan me under 800 calories a day please")
    assert "Beat" in reply and steps[0]["tool"] == "safety screen"


def test_a_good_week_is_saved_and_a_bad_one_comes_back_with_every_problem(chat: rules.Chat) -> None:
    chat.call("set_profile", dict(ALEX))
    bad = week()
    bad["days"][0]["meals"][2] = meal("dinner", "Mushroom stroganoff", 600, 40, "Mushrooms", "produce")
    bad["days"][1]["meals"][1] = meal("lunch", "Satay noodles", 500, 35, "Peanut butter", "tins_jars")
    bad["days"][2]["meals"][2] = meal("dinner", "Chicken curry", 1200, 40, "Chicken", "meat_fish")
    bad["days"][3]["meals"][0]["prep_minutes"] = 45
    problems = chat.call("save_week_plan", bad)["problems"]
    text_ = " ".join(problems)
    assert "mushrooms (disliked)" in text_ and "peanut (peanuts allergy)" in text_ and "chicken (not vegetarian)" in text_
    assert "Wednesday: 2100 kcal" in text_ and "45 minutes" in text_ and chat.plan is None
    saved = chat.call("save_week_plan", week())
    assert saved["saved"] and set(saved["daily_kcal"].values()) == {1500} and chat.plan


def test_the_shopping_list_adds_up_the_week_by_aisle(chat: rules.Chat) -> None:
    chat.call("set_profile", dict(ALEX))
    chat.call("save_week_plan", week())
    shopping = rules.shopping_list(chat.plan)
    assert list(shopping) == ["dairy_eggs", "plant_protein"]
    assert {"item": "Chickpeas", "quantity": 1050, "unit": "g"} in shopping["plant_protein"]


def test_the_files_are_a_real_pdf_and_workbook(chat: rules.Chat) -> None:
    from openpyxl import load_workbook

    chat.call("set_profile", dict(ALEX))
    chat.call("save_week_plan", week())
    assert rules.plan_pdf(chat).startswith(b"%PDF") and rules.shopping_pdf(chat).startswith(b"%PDF")
    wb = load_workbook(io.BytesIO(rules.plan_xlsx(chat)))
    assert wb.sheetnames == ["Plan", "Daily totals", "Shopping list", "Targets"] and wb["Plan"].max_row == 22


def test_health_details_are_remembered_only_with_consent(tmp_path: Path) -> None:
    without = rules.new_chat(tmp_path, "sam", consent=False).memory
    without.execute({"command": "create", "path": "/memories/goals.md", "file_text": "Goal: lose weight\n"})
    for detail in ("Allergic to peanuts", "Weighs 74 kg", "Has type 2 diabetes"):
        with pytest.raises(Exception, match="Refused"):
            without.execute({"command": "create", "path": "/memories/health.md", "file_text": detail})
    agreed = rules.new_chat(tmp_path, "kim", consent=True).memory
    agreed.execute({"command": "create", "path": "/memories/health.md", "file_text": "Allergic to peanuts, 74 kg\n"})
    with pytest.raises(Exception, match="card"):
        agreed.execute({"command": "create", "path": "/memories/card.md", "file_text": "Card 4111 1111 1111 1111"})


def test_age_and_sex_are_kept_and_dated_measurements_reused(tmp_path: Path) -> None:
    """Sex and a dated age are not health details, so they are kept without consent; with consent, dated weight and
    height are kept too, and the instructions say to reuse them rather than ask again."""
    without = rules.new_chat(tmp_path, "sam", consent=False)
    without.memory.execute({"command": "create", "path": "/memories/profile.md",
                            "file_text": "Sex: male\nAge: 38 (on 12 Nov 2026)\n"})
    agreed = rules.new_chat(tmp_path, "kim", consent=True)
    agreed.memory.execute({"command": "create", "path": "/memories/body.md",
                           "file_text": "Height: 178 cm (on 12 Nov 2026)\nWeight: 82 kg (on 12 Nov 2026)\n"})
    told = rules.instructions(agreed, date(2026, 11, 12))
    assert "Never ask for something memory already holds" in told
    assert f"last {rules.WEIGHT_FRESH_DAYS} days" in told
    assert "Remember my health details" in rules.instructions(without, date(2026, 11, 12))


def test_a_whole_conversation_through_the_api(tmp_path: Path) -> None:
    script = [
        [use("memory", {"command": "view", "path": "/memories"})],
        [text("Hello! What's your name, age, height and weight?")],
        [use("set_profile", dict(ALEX), 2)],
        [use("save_week_plan", week(), 3)],
        [use("memory", {"command": "create", "path": "/memories/alex.md", "file_text": "Name: Alex\nVegetarian\n"}, 4),
         use("memory", {"command": "create", "path": "/memories/health.md", "file_text": "Allergic to peanuts\n"}, 5)],
        [text("Your week is ready to download.")],
    ]
    fake = ScriptedClient(script)
    settings = Settings(port=8000, budget_usd=2.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    app = create_app(settings, client=fake)
    app.state.container.diet.today = lambda: date(2026, 11, 12)
    client = TestClient(app, base_url="http://localhost:8000")
    started = client.post("/api/diet/chats", json={"user": "Alex Smith", "consent": False}, headers=LAB).json()
    assert started["user"] == "alex-smith" and started["memory"] == []
    cid = started["chat_id"]
    one = client.post(f"/api/diet/chats/{cid}/messages", json={"message": "Plan my week please"}, headers=LAB).json()
    assert one["plan"] is None and "Thursday 12 November 2026" in fake.calls[0][1]["system"]
    assert client.get(f"/api/diet/chats/{cid}/files/plan", headers=LAB).status_code == 409
    two = client.post(f"/api/diet/chats/{cid}/messages", json={"message": "Alex, 34, 168 cm, 74 kg..."}, headers=LAB).json()
    assert two["targets"]["kcal_per_day"] == 1500 and two["totals"]["Monday"]["kcal"] == 1500
    assert [s["tool"] for s in two["steps"]] == ["set_profile", "save_week_plan", "memory", "memory"]
    assert "Refused" in two["steps"][3]["result"]["error"]  # no consent: the allergy is not kept
    assert [m["path"] for m in two["memory"]] == ["/memories/alex.md"]
    pdf = client.get(f"/api/diet/chats/{cid}/files/plan", headers=LAB)
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF") and "meal-plan.pdf" in pdf.headers["content-disposition"]
    assert client.get(f"/api/diet/chats/{cid}/files/xlsx", headers=LAB).content[:2] == b"PK"
    assert client.delete("/api/diet/memory/alex-smith", headers=LAB).json() == {"memory": []}


def test_meat_free_products_are_not_meat() -> None:
    veg = {"diet": "vegetarian", "allergies": [], "dislikes": []}
    assert rules.forbidden_in("Quorn mince chilli; veggie sausages and mash; plant-based chicken pieces", veg) == []
    assert rules.forbidden_in("Beef mince chilli", veg) == ["mince (not vegetarian)", "beef (not vegetarian)"] or \
        set(rules.forbidden_in("Beef mince chilli", veg)) == {"mince (not vegetarian)", "beef (not vegetarian)"}


class StreamedClient(ScriptedClient):
    """The scripted replies, streamed: text arrives as deltas and tool input as JSON in pieces."""

    def __init__(self, script: list[list[dict]]) -> None:
        super().__init__(script)
        from types import SimpleNamespace as NS
        from backend.tests.test_aftercare import reply

        client = self

        class Stream:
            def __init__(self, params: dict) -> None:
                client.calls.append(("messages.stream", params))
                blocks = client.script.pop(0)
                self.final = reply(params["model"], *blocks,
                                   stop="tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn")
                self.events = []
                for i, b in enumerate(blocks):
                    if b["type"] == "text":
                        self.events.append(NS(type="content_block_start", index=i, content_block=NS(type="text")))
                        self.events += [NS(type="content_block_delta", index=i, delta=NS(type="text_delta", text=w + " "))
                                        for w in b["text"].split()]
                    else:
                        raw = json.dumps(b["input"])
                        self.events.append(NS(type="content_block_start", index=i,
                                              content_block=NS(type="tool_use", name=b["name"])))
                        self.events += [NS(type="content_block_delta", index=i,
                                           delta=NS(type="input_json_delta", partial_json=raw[k:k + 50]))
                                        for k in range(0, len(raw), 50)]

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def __iter__(self):
                return iter(self.events)

            def get_final_message(self):
                return self.final

        self.messages.stream = lambda **params: Stream(params)  # type: ignore[method-assign]


def test_a_streamed_turn_shows_the_planner_working(tmp_path: Path) -> None:
    script = [
        [use("set_profile", dict(ALEX), 2)],
        [use("save_week_plan", week(), 3)],
        [text("Your week is ready to download.")],
    ]
    fake = StreamedClient(script)
    settings = Settings(port=8000, budget_usd=2.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models", heartbeat_s=0.2)
    client = TestClient(create_app(settings, client=fake), base_url="http://localhost:8000")
    cid = client.post("/api/diet/chats", json={"user": "alex"}, headers=LAB).json()["chat_id"]
    with client.stream("POST", f"/api/diet/chats/{cid}/stream", json={"message": "Plan my week"}, headers=LAB) as r:
        events = [json.loads(line) for line in r.iter_lines() if line.strip()]
    kinds = [e["type"] for e in events]
    assert kinds[0] == "run" and kinds[-1] == "done"
    assert {"thinking", "tool_start", "writing", "step", "text"} <= set(kinds)
    assert [e["tool"] for e in events if e["type"] == "tool_start"] == ["set_profile", "save_week_plan"]
    assert any(e["type"] == "writing" and e["tool"] == "save_week_plan" and e["chars"] >= 400 for e in events)
    assert "".join(e["text"] for e in events if e["type"] == "text").strip() == "Your week is ready to download."
    done = events[-1]
    assert done["plan"] and done["totals"]["Monday"]["kcal"] == 1500 and done["reply"] == "Your week is ready to download."
