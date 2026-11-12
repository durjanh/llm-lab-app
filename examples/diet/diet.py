"""The diet planner: an agent that asks a few questions, then designs a week of meals, which the person downloads.

Shared by the lab's /diet page (backend/app/services/diet.py) and the command line (diet_agent.py). The model talks,
asks and writes the meals. Code does what must be right every time:
- the targets: daily calories (Mifflin-St Jeor, an activity factor, a goal, and a floor it never goes under) and
  protein, from set_profile;
- refusals: no plan for under-18s, no weight loss for someone underweight, pregnant or breastfeeding, and no plan at
  all when an eating disorder is mentioned (a fixed reply, before any model sees the message);
- the plan's checks: seven days, the right number of meals, each day within 10% of the calorie target, enough
  protein, nothing the person is allergic to or does not eat, prep times that fit, some variety;
- the shopping list and the files (a PDF plan, a PDF shopping list, an Excel workbook), made from the checked plan.

Memory is the memory agent's (python/22_memory_agent.py): Claude's own memory tool, or the same commands as a plain
tool for GPT and the local model. One rule is added. Health details (allergies, conditions, weight, height) are kept
only if the person has agreed; without that, the code refuses to write them, whatever the model decides.

Calories and protein per meal are the model's estimates. The code checks that they add up to the targets; it does
not look up nutrition data. This is a lab example, not medical or dietetic advice.
"""
from __future__ import annotations

import importlib
import io
import json
import re
import sys
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
if str(REPO / "python") not in sys.path:
    sys.path.insert(0, str(REPO / "python"))
memory_agent = importlib.import_module("22_memory_agent")

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
ACTIVITY = {"sedentary": 1.2, "light": 1.375, "moderate": 1.55, "active": 1.725, "very_active": 1.9}
GOAL_CHANGE = {"lose": -500, "maintain": 0, "gain": 300}  # kcal a day
FLOOR = {"female": 1400, "male": 1600}  # never planned below these without a clinician
PROTEIN_PER_KG = {"lose": 1.6, "maintain": 1.2, "gain": 1.6}
AISLES = ["produce", "meat_fish", "dairy_eggs", "bakery", "tins_jars", "dry_goods", "frozen", "spices_condiments",
          "plant_protein", "other"]
AISLE_NAMES = {"produce": "Fruit and vegetables", "meat_fish": "Meat and fish", "dairy_eggs": "Dairy and eggs",
               "bakery": "Bakery", "tins_jars": "Tins and jars", "dry_goods": "Rice, pasta, grains and baking",
               "frozen": "Frozen", "spices_condiments": "Herbs, spices and sauces", "plant_protein": "Tofu, beans and pulses",
               "other": "Other"}

# Words that mean an ingredient contains something. Matched as whole words (plurals too), on dish names and items.
MEAT = ["chicken", "beef", "pork", "lamb", "bacon", "ham", "turkey", "sausage", "mince", "steak", "chorizo", "salami",
        "duck", "gelatine", "venison", "pancetta", "prosciutto"]
FISH = ["fish", "salmon", "tuna", "cod", "haddock", "mackerel", "sardine", "anchovy", "anchovies", "trout", "pollock",
        "sea bass", "hake"]
SHELLFISH = ["prawn", "shrimp", "crab", "lobster", "mussel", "scallop", "clam", "oyster", "squid", "calamari"]
DAIRY = ["milk", "cheese", "yoghurt", "yogurt", "butter", "cream", "feta", "mozzarella", "parmesan", "halloumi",
         "ghee", "whey", "paneer", "ricotta", "cheddar", "creme fraiche", "kefir"]
NOT_DAIRY = ["peanut butter", "nut butter", "almond butter", "cashew butter", "cocoa butter", "butter bean",
             "butternut", "coconut milk", "oat milk", "soy milk", "soya milk", "almond milk", "rice milk",
             "coconut cream", "coconut yoghurt", "coconut yogurt", "dairy-free", "vegan cheese", "plant milk"]
# Meat words that name a meat-free product when a word like these comes first ("Quorn mince", "vegan sausages").
MEAT_FREE = re.compile(
    r"\b(?:quorn|veggie|vegan|vegetarian|meat-?free|plant-?based|meatless|soya?|tofu|mycoprotein|jackfruit|"
    r"lentil|bean|mushroom)\s+(?:\w+\s+)?(?:mince|sausages?|burgers?|chicken|bacon|ham|steaks?|pieces|fillets?|"
    r"nuggets?|meatballs?)\b", re.I)
ALLERGENS = {
    "nuts": ["almond", "walnut", "cashew", "pecan", "hazelnut", "pistachio", "macadamia", "brazil nut", "peanut",
             "nut butter", "pesto", "praline", "marzipan"],
    "peanuts": ["peanut", "groundnut", "satay"],
    "dairy": DAIRY,
    "gluten": ["wheat", "bread", "pasta", "flour", "barley", "rye", "couscous", "bulgur", "noodle", "tortilla", "wrap",
               "pitta", "bagel", "seitan", "semolina", "spelt", "cracker", "crouton", "soy sauce", "spaghetti",
               "penne", "naan", "baguette", "sourdough", "crumpet", "muffin", "granola"],
    "eggs": ["egg", "mayonnaise", "meringue", "frittata", "omelette"],
    "fish": FISH,
    "shellfish": SHELLFISH,
    "soy": ["soy", "soya", "tofu", "tempeh", "edamame", "miso"],
    "sesame": ["sesame", "tahini", "hummus", "houmous"],
    "celery": ["celery", "celeriac"],
    "mustard": ["mustard"],
}
SYNONYMS = {"nut": "nuts", "tree nuts": "nuts", "tree nut": "nuts", "peanut": "peanuts", "lactose": "dairy",
            "milk": "dairy", "coeliac": "gluten", "celiac": "gluten", "wheat": "gluten", "egg": "eggs",
            "seafood": "shellfish", "soya": "soy", "sesame seeds": "sesame"}
DIETS = {"omnivore": [], "pescatarian": MEAT, "vegetarian": MEAT + FISH + SHELLFISH,
         "vegan": MEAT + FISH + SHELLFISH + DAIRY + ALLERGENS["eggs"] + ["honey"],
         "halal": ["pork", "bacon", "ham", "chorizo", "salami", "gelatine", "pancetta", "prosciutto", "wine", "lard"],
         "kosher": ["pork", "bacon", "ham", "chorizo", "salami", "gelatine", "pancetta", "prosciutto", "lard"]
                   + SHELLFISH}
REFER = ("diabetes", "diabetic", "kidney", "renal", "heart", "cardiac", "liver", "coeliac", "crohn", "colitis",
         "ibs", "cancer", "pcos", "hypertension", "blood pressure", "cholesterol", "gout", "medication")

# Said before any model runs: an eating disorder, or a request for a starvation diet. No plan, a fixed reply.
EATING_DISORDER = re.compile(
    r"\b(anorexi\w*|bulimi\w*|binge\w*|purg\w*|eating disorder|make myself (?:sick|throw up|vomit)|"
    r"starv\w* myself|stop eating|(?:under|less than|below|only)\s+(?:[1-9]\d{2})\s*(?:k?cals?|calories))\b", re.I)
SAFETY_REPLY = ("I can't plan meals for this. If food or eating is worrying you, please talk to your GP, or to Beat, "
                "the UK eating disorder charity (beateatingdisorders.org.uk). If you feel unsafe right now, call 999, "
                "or NHS 111 for urgent advice.")

# Health details the memory may keep only with the person's agreement: allergies, conditions, body measurements.
# Words such as "weight" alone are not matched, so "Goal: lose weight" may be kept.
HEALTH_DETAIL = re.compile(
    r"\b(allerg\w*|intoleran\w*|coeliac|celiac|diabet\w*|pregnan\w*|breastfeed\w*|kidney|heart condition|"
    r"blood pressure|cholesterol|medication|bmi|\d{2,3}(?:\.\d+)?\s?(?:kg|kilos?|cm|lbs?|st|stone)|\d\s?(?:ft|foot|feet))\b",
    re.I)


def _singular(word: str) -> str:
    for plural, single in (("ies", "y"), ("oes", "o"), ("ses", "s"), ("s", "")):
        if word.endswith(plural) and len(word) > len(plural) + 2 and not word.endswith("ss"):
            return word[: -len(plural)] + single
    return word


def contains(text: str, words: list[str]) -> list[str]:
    """Which of the words appear in the text, as whole words, singular or plural ("mushrooms" finds "mushroom")."""
    text = text.lower()
    found = []
    for w in words:
        forms = {w, _singular(w)}
        if any(re.search(rf"\b{re.escape(f)}(?:s|es)?\b", text) for f in forms) or \
                (w.endswith("y") and re.search(rf"\b{re.escape(w[:-1])}ies\b", text)):
            found.append(w)
    return found


def forbidden_in(text: str, profile: dict) -> list[str]:
    """What in this text the person must not eat: allergies, their diet's exclusions and their dislikes."""
    found: list[str] = []
    for allergy in profile.get("allergies") or []:
        key = SYNONYMS.get(allergy.lower().strip(), allergy.lower().strip())
        words = ALLERGENS.get(key, [key])
        checked = text.lower()
        if key == "dairy":
            for safe in NOT_DAIRY:
                checked = checked.replace(safe, " ")
        found += [f"{w} ({allergy} allergy)" for w in contains(checked, words)]
    diet = (profile.get("diet") or "omnivore").lower()
    checked = MEAT_FREE.sub(" ", text.lower())  # "Quorn mince" and "veggie sausages" are not meat
    if diet == "vegan":
        for safe in NOT_DAIRY:
            checked = checked.replace(safe, " ")
    found += [f"{w} (not {diet})" for w in contains(checked, DIETS.get(diet, []))]
    found += [f"{w} (disliked)" for w in contains(text, [d.lower().strip() for d in profile.get("dislikes") or [] if d.strip()])]
    return found


# ---------------------------------------------------------------------------------------------------------- tools

SET_PROFILE = {
    "name": "set_profile",
    "description": "Records what you have learned about the person and works out their daily calorie and protein "
                   "targets. Call it once you know every field; call it again if something changes. It may refuse "
                   "(under 18, or a goal that would not be safe): then explain kindly and do not plan meals.",
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "sex": {"type": "string", "enum": ["female", "male"], "description": "for the energy formula"},
            "age": {"type": "integer"},
            "height_cm": {"type": "number"},
            "weight_kg": {"type": "number"},
            "activity": {"type": "string", "enum": list(ACTIVITY)},
            "goal": {"type": "string", "enum": list(GOAL_CHANGE)},
            "diet": {"type": "string", "enum": list(DIETS)},
            "allergies": {"type": "array", "items": {"type": "string"}, "description": "allergies and intolerances"},
            "dislikes": {"type": "array", "items": {"type": "string"}},
            "conditions": {"type": "array", "items": {"type": "string"},
                           "description": "medical conditions that affect eating, if the person mentions any"},
            "pregnant_or_breastfeeding": {"type": "boolean"},
            "meals_per_day": {"type": "integer", "description": "meals and snacks a day, 3 to 5"},
            "cooking_minutes": {"type": "integer", "description": "the most time for any one meal"},
        },
        "required": ["sex", "age", "height_cm", "weight_kg", "activity", "goal", "diet", "allergies", "dislikes",
                     "meals_per_day", "cooking_minutes"],
    },
}

INGREDIENT = {"type": "object", "properties": {
    "item": {"type": "string"}, "quantity": {"type": "number"},
    "unit": {"type": "string", "enum": ["g", "ml", "item", "tbsp", "tsp", "slice", "pinch"]},
    "aisle": {"type": "string", "enum": AISLES}}, "required": ["item", "quantity", "unit", "aisle"]}
MEAL = {"type": "object", "properties": {
    "slot": {"type": "string", "enum": ["breakfast", "lunch", "dinner", "snack"]},
    "name": {"type": "string"}, "ingredients": {"type": "array", "items": INGREDIENT},
    "method": {"type": "string", "description": "one or two short sentences"},
    "kcal": {"type": "integer"}, "protein_g": {"type": "integer"}, "prep_minutes": {"type": "integer"}},
    "required": ["slot", "name", "ingredients", "method", "kcal", "protein_g", "prep_minutes"]}
SAVE_WEEK_PLAN = {
    "name": "save_week_plan",
    "description": "Saves the week's meal plan after code checks it against the targets and the person's needs. If it "
                   "returns problems, fix them and call it again with the whole plan. Once saved, the person can "
                   "download it as a PDF, a shopping list and a spreadsheet.",
    "input_schema": {
        "type": "object",
        "properties": {
            "days": {"type": "array", "items": {"type": "object", "properties": {
                "day": {"type": "string", "enum": DAYS}, "meals": {"type": "array", "items": MEAL}},
                "required": ["day", "meals"]}},
            "notes": {"type": "string", "description": "a few lines of tips: batch cooking, swaps, leftovers"},
        },
        "required": ["days", "notes"],
    },
}
TOOLS = [SET_PROFILE, SAVE_WEEK_PLAN]


def targets_for(p: dict) -> dict:
    """Daily calories and protein, or a refusal. The arithmetic and the limits are code, not the model."""
    age, height, weight = p["age"], p["height_cm"], p["weight_kg"]
    if age < 18:
        return {"refused": "Plans for under-18s need a GP or a registered dietitian. Do not plan meals; suggest that."}
    if not (120 <= height <= 230 and 30 <= weight <= 300 and age <= 110):
        return {"error": "Those measurements look wrong. Check height in cm and weight in kg with the person."}
    bmi = weight / (height / 100) ** 2
    if (p.get("conditions") and any(re.search(r"eating disorder|anorexi|bulimi", c, re.I) for c in p["conditions"])):
        return {"refused": "With an eating disorder, meal plans should come from the person's care team. Do not plan."}
    if p["goal"] == "lose" and bmi < 18.5:
        return {"refused": f"A BMI of {bmi:.1f} is underweight, so a weight-loss plan would not be safe. Offer a "
                           "maintenance plan instead, and suggest a GP."}
    if p["goal"] == "lose" and p.get("pregnant_or_breastfeeding"):
        return {"refused": "Weight loss is not planned during pregnancy or breastfeeding. Offer a maintenance plan, and "
                           "suggest checking with a midwife or GP."}
    bmr = 10 * weight + 6.25 * height - 5 * age + (5 if p["sex"] == "male" else -161)
    tdee = bmr * ACTIVITY[p["activity"]]
    floor = FLOOR[p["sex"]]
    kcal = max(round((tdee + GOAL_CHANGE[p["goal"]]) / 50) * 50, floor)
    out = {"kcal_per_day": kcal, "protein_g_per_day": round(weight * PROTEIN_PER_KG[p["goal"]]),
           "bmr": round(bmr), "maintenance_kcal": round(tdee), "bmi": round(bmi, 1),
           "floor_applied": kcal == floor and tdee + GOAL_CHANGE[p["goal"]] < floor}
    notes = []
    if out["floor_applied"]:
        notes.append(f"The target was raised to {floor} kcal, the least this planner goes to.")
    if p.get("conditions") and any(any(w in c.lower() for w in REFER) for c in p["conditions"]):
        notes.append("Tell the person to show this plan to their GP or dietitian, because of their condition.")
    if p.get("pregnant_or_breastfeeding"):
        notes.append("Remind them to check with their midwife or GP, and avoid foods unsafe in pregnancy.")
    if notes:
        out["notes"] = notes
    return out


@dataclass
class Chat:
    """One person's conversation: their memory, profile, targets and the checked plan."""
    user: str
    consent: bool
    memory: Any
    profile: dict | None = None
    targets: dict | None = None
    plan: dict | None = None
    history: list = field(default_factory=list)

    def call(self, name: str, args: dict) -> dict:
        if name == "set_profile":
            return self._set_profile(args)
        if name == "save_week_plan":
            return self._save_week_plan(args)
        return {"error": f"There is no tool called {name}."}

    def _set_profile(self, a: dict) -> dict:
        missing = [k for k in SET_PROFILE["input_schema"]["required"] if a.get(k) in (None, "")]
        if missing:
            return {"error": f"Ask the person for: {', '.join(missing)}."}
        try:
            for k in ("age", "meals_per_day", "cooking_minutes"):
                a[k] = int(a[k])
            for k in ("height_cm", "weight_kg"):
                a[k] = float(a[k])
        except (TypeError, ValueError):
            return {"error": "age, meals_per_day and cooking_minutes must be whole numbers; height_cm and weight_kg numbers."}
        if a["sex"] not in FLOOR or a["activity"] not in ACTIVITY or a["goal"] not in GOAL_CHANGE or a["diet"] not in DIETS:
            return {"error": "sex, activity, goal and diet must be one of the listed values."}
        if not 3 <= a["meals_per_day"] <= 5 or not 5 <= a["cooking_minutes"] <= 180:
            return {"error": "meals_per_day must be 3 to 5, and cooking_minutes 5 to 180."}
        targets = targets_for(a)
        if "error" in targets:
            return targets
        self.profile = {k: a.get(k) for k in SET_PROFILE["input_schema"]["properties"]}
        if "refused" in targets:
            self.targets, self.plan = None, None
            return {"saved_profile": True, **targets}
        self.targets, self.plan = targets, None
        return {"saved_profile": True, "targets": targets,
                "next": f"Design 7 days of {a['meals_per_day']} meals, each day within 10% of {targets['kcal_per_day']} "
                        f"kcal and at least {round(targets['protein_g_per_day'] * 0.85)} g protein, then call save_week_plan."}

    def check_plan(self, plan: dict) -> list[str]:
        """Everything wrong with a plan, for the model to fix. Empty when it may be saved."""
        p, t = self.profile or {}, self.targets or {}
        problems: list[str] = []
        days = plan.get("days") or []
        if sorted(d.get("day") for d in days) != sorted(DAYS):
            problems.append("The plan needs exactly one entry for each day, Monday to Sunday.")
        dinners: dict[str, int] = {}
        for d in days:
            meals = d.get("meals") or []
            if len(meals) != p.get("meals_per_day"):
                problems.append(f"{d.get('day')}: {len(meals)} meals; the person wants {p.get('meals_per_day')} a day.")
            kcal = sum(int(m.get("kcal") or 0) for m in meals)
            protein = sum(int(m.get("protein_g") or 0) for m in meals)
            target = t.get("kcal_per_day", 0)
            if target and abs(kcal - target) > 0.10 * target:
                problems.append(f"{d.get('day')}: {kcal} kcal; it must be within 10% of {target} "
                                f"({round(target * 0.9)} to {round(target * 1.1)}).")
            if t.get("protein_g_per_day") and protein < 0.85 * t["protein_g_per_day"]:
                problems.append(f"{d.get('day')}: {protein} g protein; aim for at least "
                                f"{round(0.85 * t['protein_g_per_day'])} g.")
            for m in meals:
                text = " ".join([m.get("name", "")] + [i.get("item", "") for i in m.get("ingredients") or []])
                for bad in forbidden_in(text, p):
                    problems.append(f"{d.get('day')} {m.get('slot')} '{m.get('name')}': contains {bad}.")
                if not m.get("ingredients"):
                    problems.append(f"{d.get('day')} {m.get('slot')} '{m.get('name')}': list its ingredients.")
                if int(m.get("prep_minutes") or 0) > (p.get("cooking_minutes") or 999):
                    problems.append(f"{d.get('day')} {m.get('slot')} '{m.get('name')}': {m.get('prep_minutes')} minutes; "
                                    f"the person has {p.get('cooking_minutes')} at most.")
                if m.get("slot") == "dinner":
                    key = m.get("name", "").strip().lower()
                    dinners[key] = dinners.get(key, 0) + 1
        problems += [f"'{name}' is dinner {n} times; use it twice at most." for name, n in dinners.items() if n > 2]
        return problems[:15]

    def _save_week_plan(self, plan: dict) -> dict:
        if not self.targets:
            return {"error": "Call set_profile first: the plan is checked against the targets it works out."}
        problems = self.check_plan(plan)
        if problems:
            return {"error": "Not saved. Fix these and send the whole plan again.", "problems": problems}
        order = {d: i for i, d in enumerate(DAYS)}
        plan["days"] = sorted(plan["days"], key=lambda d: order[d["day"]])
        self.plan = plan
        totals = daily_totals(plan)
        return {"saved": True, "daily_kcal": {d: v["kcal"] for d, v in totals.items()},
                "shopping_items": sum(len(v) for v in shopping_list(plan).values()),
                "next": "Tell the person the plan is ready to download (PDF, shopping list, spreadsheet), in a few "
                        "lines. Save their preferences to memory if you have not."}


# ------------------------------------------------------------------------------------------------------ memory

class DietMemory(memory_agent.MemoryStore):
    """The memory agent's store, with one more rule: health details only with the person's agreement."""

    def __init__(self, root: Path, consent: bool):
        super().__init__(root)
        self.consent = consent

    def guard(self, text: str) -> None:  # type: ignore[override]
        problem = memory_agent.privacy_problem(text)
        if problem == "health information" and self.consent:
            problem = None
        if problem is None and not self.consent and HEALTH_DETAIL.search(text):
            problem = "a health detail (allergies, conditions or body measurements) the person has not agreed to keep"
        if problem:
            raise memory_agent.MemoryCommandError(f"Refused: this looks like {problem}, which must not be kept in memory. "
                                                  "Store the rest without it, or leave it out.")


def safe_user(name: str) -> str:
    """A memory folder name: lower case letters, digits and hyphens."""
    return re.sub(r"[^a-z0-9-]+", "-", (name or "").lower()).strip("-")[:40] or "guest"


def new_chat(memory_root: Path, user: str, consent: bool) -> Chat:
    user = safe_user(user)
    return Chat(user=user, consent=consent, memory=DietMemory(memory_root / user, consent))


# Body measurements change: a weight older than this is checked again, not reused without a word.
WEIGHT_FRESH_DAYS = 28


def instructions(chat: Chat, today: date) -> str:
    consent = ("The person HAS agreed that you may remember health details (allergies, conditions, weight, height)."
               if chat.consent else
               "The person has NOT agreed that you may remember health details: do not save allergies, conditions, "
               "weight or height to memory. Ask for them again in each conversation, in one short question, and say "
               "once that ticking 'Remember my health details' before starting a conversation would save them asking.")
    return f"""You are a friendly meal planner for one person. Today is {today:%A %d %B %Y}.
You have a memory folder at /memories that lasts between conversations. {consent}

How to work:
1. Before your first reply, view /memories and read every file there. Greet returning people by name and use what you
   know. Never ask for something memory already holds; ask only for what is missing or out of date:
   - Age: memory keeps the age with the date it was given ("Age: 34 (on 12 Nov 2026)"). Work out today's age from it
     yourself; do not ask again.
   - Sex and height (adults): reuse them; they do not change.
   - Weight: memory keeps it with its date. Given within the last {WEIGHT_FRESH_DAYS} days: use it, and say which
     figure and date you are using so they can correct it. Older: ask only "Are you still X?", nothing else about it.
   - Goal, diet, activity, meals, cooking time, likes and dislikes: use them, and ask in one line whether anything has
     changed, rather than asking each again.
2. Ask what you still need, at most three questions in one message, in plain words: name, goal (lose, maintain or
   gain weight), sex (for the energy formula), age, height, weight, how active they are, diet (omnivore, pescatarian,
   vegetarian, vegan, halal, kosher), allergies and intolerances, foods they dislike, any medical condition that
   affects eating, pregnancy or breastfeeding if relevant, meals a day (3 to 5, snacks count), and the most minutes
   they want to spend on one meal. Accept stone and pounds or feet and inches, and convert them yourself.
3. Call set_profile. Never work out calories yourself: use its targets. If it refuses, explain kindly, suggest the
   GP or a dietitian, and do not plan meals.
4. Design seven days that meet the targets: realistic British supermarket ingredients with quantities for one person,
   variety across the week, leftovers used sensibly, prep times within their limit. Then call save_week_plan with the
   whole week. If it returns problems, fix every one and call it again.
5. When it is saved, say so briefly and point them to the download buttons. Do not paste the whole plan into chat.
6. Save to memory, in one file per topic: their name, sex, age with today's date, goal, activity, diet, dislikes,
   meals a day, cooking time, foods they liked, and (only if they agreed) allergies, conditions, and weight and height
   in kg and cm, each with today's date ("Weight: 74 kg (on {today:%d %b %Y})"). Edit a fact when it changes, with
   the new date; never add a second version. If a memory write is refused, carry on without it.
You are not a doctor or dietitian. Keep replies short."""


def samples() -> list[dict]:
    return [
        {"label": "Start a plan", "text": "Hi, can you plan my meals for next week? I'd like to lose a little weight."},
        {"label": "Answer the questions",
         "text": "I'm Alex, female, 34, 168 cm and 74 kg. I walk to work and do yoga twice a week. Vegetarian, no "
                 "mushrooms, allergic to peanuts. Three meals a day, 30 minutes at most."},
        {"label": "Next week (memory)", "text": "Hello again! Same as last week, but I've started running three times "
                                                "a week, so I want to keep my weight steady now."},
        {"label": "A safety check", "text": "I want to get down fast. Can you plan me under 800 calories a day?"},
    ]


# ------------------------------------------------------------------------------------------------------ the loop

def _streamed(stream: Callable[..., Any], params: dict, emit: Callable[[dict], None]) -> Any:
    """One model call, streamed: the reply's words and each tool call's progress go to emit as they arrive."""
    writing: dict[int, dict] = {}  # content block index -> {"tool": name, "chars": n, "told": n}
    with stream(**params) as s:
        for event in s:
            kind = getattr(event, "type", "")
            if kind == "content_block_start" and getattr(event.content_block, "type", "") == "tool_use":
                writing[event.index] = {"tool": event.content_block.name, "chars": 0, "told": 0}
                emit({"type": "tool_start", "tool": event.content_block.name})
            elif kind == "content_block_delta":
                delta = event.delta
                if getattr(delta, "type", "") == "text_delta":
                    emit({"type": "text", "text": delta.text})
                elif getattr(delta, "type", "") == "input_json_delta" and event.index in writing:
                    w = writing[event.index]
                    w["chars"] += len(delta.partial_json)
                    if w["chars"] - w["told"] >= 400:  # often enough to see it move, not a message per token
                        w["told"] = w["chars"]
                        emit({"type": "writing", "tool": w["tool"], "chars": w["chars"]})
        return s.get_final_message()


def diet_turn(create: Callable[..., Any], chat: Chat, model: str, text: str, today: date | None = None,
              max_rounds: int = 12, on_response: Callable[[Any], None] = lambda r: None,
              stream: Callable[..., Any] | None = None,
              emit: Callable[[dict], None] = lambda e: None) -> tuple[str, list[dict]]:
    """One message from the person to the agent's reply. Tool calls run here, round after round. With stream, each
    model call is streamed and its progress, and every tool call and result, goes to emit as it happens."""
    if EATING_DISORDER.search(text):
        chat.history.append({"role": "user", "content": [{"type": "text", "text": text}]})
        chat.history.append({"role": "assistant", "content": [{"type": "text", "text": SAFETY_REPLY}]})
        step = {"tool": "safety screen", "args": {}, "result": {"stopped": "eating disorder signs"}}
        emit({"type": "step", "step": step})
        emit({"type": "text", "text": SAFETY_REPLY})
        return SAFETY_REPLY, [step]
    tool = memory_agent.memory_tool(model)
    system = instructions(chat, today or date.today())
    if tool is memory_agent.MEMORY_FUNCTION:
        system += "\n" + memory_agent.MEMORY_GUIDE
    chat.history.append({"role": "user", "content": [{"type": "text", "text": text}]})
    steps: list[dict] = []
    for _ in range(max_rounds):
        params = {"model": model, "max_tokens": 16000, "system": system, "tools": [tool, *TOOLS],
                  "messages": chat.history}
        emit({"type": "thinking"})
        response = _streamed(stream, params, emit) if stream else create(**params)
        on_response(response)
        chat.history.append({"role": "assistant",
                             "content": [b.model_dump(exclude_none=True) if hasattr(b, "model_dump") else b
                                         for b in response.content]})
        uses = [b for b in response.content if getattr(b, "type", None) == "tool_use"]
        if not uses:
            reply = "".join(b.text for b in response.content if getattr(b, "type", None) == "text").strip()
            if getattr(response, "stop_reason", "") == "max_tokens":
                reply += "\n\n(The planner ran out of room mid-reply. Ask it to carry on.)"
            elif not reply:
                reply = ("(The planner stopped without saying anything. Send your message again, or say "
                         "\"please carry on\".)")
            emit({"type": "text", "text": ""})
            return reply.strip(), steps
        results = []
        for b in uses:
            args = dict(b.input) if isinstance(b.input, dict) else {}
            if b.name == "memory":
                try:
                    result: Any = {"output": chat.memory.execute(args)}
                except (memory_agent.MemoryCommandError, KeyError, TypeError, ValueError) as exc:
                    result = {"error": str(exc)}
            else:
                result = chat.call(b.name, args)
            shown = {"days": f"{len(args.get('days') or [])} days"} if b.name == "save_week_plan" else args
            steps.append({"tool": b.name, "args": shown, "result": result})
            emit({"type": "step", "step": steps[-1]})
            results.append({"type": "tool_result", "tool_use_id": b.id, "content": json.dumps(result),
                            **({"is_error": True} if "error" in result else {})})
        chat.history.append({"role": "user", "content": results})
    return "(The planner stopped: too many steps in one turn.)", steps


# ------------------------------------------------------------------------------------------- the plan, as files

def daily_totals(plan: dict) -> dict[str, dict]:
    return {d["day"]: {"kcal": sum(int(m["kcal"]) for m in d["meals"]),
                       "protein_g": sum(int(m["protein_g"]) for m in d["meals"])} for d in plan["days"]}


def shopping_list(plan: dict) -> OrderedDict[str, list[dict]]:
    """Every ingredient for the week, added up by item and unit, grouped by aisle."""
    totals: dict[tuple[str, str, str], float] = {}
    names: dict[str, str] = {}
    for d in plan["days"]:
        for m in d["meals"]:
            for i in m["ingredients"]:
                key = (i.get("aisle", "other"), i["item"].strip().lower(), i["unit"])
                names.setdefault(key[1], i["item"].strip())
                totals[key] = totals.get(key, 0) + float(i["quantity"])
    out: OrderedDict[str, list[dict]] = OrderedDict()
    for aisle in AISLES:
        items = sorted((names[k[1]], q, k[2]) for k, q in totals.items() if k[0] == aisle)
        if items:
            out[aisle] = [{"item": n, "quantity": round(q, 1) if q % 1 else int(q), "unit": u} for n, q, u in items]
    return out


def _amount(q: Any, unit: str) -> str:
    return f"{q} {unit}" if unit not in ("item",) else f"{q}"


def plan_pdf(chat: Chat) -> bytes:
    """The week as a printable PDF: targets, then a table per day, then the notes."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    plan, t, p = chat.plan, chat.targets or {}, chat.profile or {}
    styles = getSampleStyleSheet()
    small = styles["BodyText"].clone("small", fontSize=8, leading=10)
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=landscape(A4), leftMargin=14 * mm, rightMargin=14 * mm, topMargin=12 * mm,
                            bottomMargin=12 * mm, title="Weekly meal plan")
    who = p.get("name") or chat.user
    story: list[Any] = [
        Paragraph(f"Weekly meal plan for {who}", styles["Title"]),
        Paragraph(f"Target {t.get('kcal_per_day')} kcal and {t.get('protein_g_per_day')} g protein a day · "
                  f"{(p.get('diet') or '').title()} · {p.get('meals_per_day')} meals a day · up to "
                  f"{p.get('cooking_minutes')} minutes a meal", styles["BodyText"]),
        Paragraph("Calories and protein are estimates. This is not medical or dietetic advice.", small),
        Spacer(1, 4 * mm)]
    totals = daily_totals(plan)
    for i, d in enumerate(plan["days"]):
        rows = [["Meal", "Dish", "Ingredients", "Method", "kcal", "Protein", "Min"]]
        for m in d["meals"]:
            ing = ", ".join(f"{i_['item']} {_amount(i_['quantity'], i_['unit'])}" for i_ in m["ingredients"])
            rows.append([m["slot"].title(), Paragraph(m["name"], small), Paragraph(ing, small),
                         Paragraph(m.get("method", ""), small), m["kcal"], f"{m['protein_g']} g", m["prep_minutes"]])
        rows.append(["", Paragraph(f"<b>{d['day']} total</b>", small), "", "", totals[d["day"]]["kcal"],
                     f"{totals[d['day']]['protein_g']} g", ""])
        table = Table(rows, colWidths=[20 * mm, 50 * mm, 95 * mm, 70 * mm, 14 * mm, 16 * mm, 10 * mm], repeatRows=1)
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#162141")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white), ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("VALIGN", (0, 0), (-1, -1), "TOP"), ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e3e4e8")),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f6f6f7"))]))
        story += [Paragraph(d["day"], styles["Heading2"]), table]
        if i % 2 == 1 and i < 6:
            story.append(PageBreak())
    if plan.get("notes"):
        story += [Paragraph("Notes", styles["Heading2"]), Paragraph(plan["notes"].replace("\n", "<br/>"), styles["BodyText"])]
    doc.build(story)
    return buf.getvalue()


def shopping_pdf(chat: Chat) -> bytes:
    """The week's shopping list as a printable PDF, by aisle, with tick boxes."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    styles = getSampleStyleSheet()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, title="Shopping list")
    story: list[Any] = [Paragraph(f"Shopping list for the week · {(chat.profile or {}).get('name') or chat.user}",
                                  styles["Title"])]
    for aisle, items in shopping_list(chat.plan).items():
        story.append(Paragraph(AISLE_NAMES[aisle], styles["Heading3"]))
        for i in items:
            # "[ ]" rather than a box character: the PDF's built-in font has no empty box
            story.append(Paragraph(f"[&nbsp;&nbsp;]&nbsp; {i['item']}: {_amount(i['quantity'], i['unit'])}",
                                   styles["BodyText"]))
        story.append(Spacer(1, 2 * mm))
    doc.build(story)
    return buf.getvalue()


def plan_xlsx(chat: Chat) -> bytes:
    """The plan, daily totals, shopping list and targets as an Excel workbook."""
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    wb = Workbook()
    head = (Font(bold=True, color="FFFFFF"), PatternFill("solid", fgColor="162141"))

    def sheet(title: str, header: list[str], rows: list[list[Any]], first: bool = False) -> None:
        ws = wb.active if first else wb.create_sheet()
        ws.title = title
        ws.append(header)
        for cell in ws[1]:
            cell.font, cell.fill = head
        for r in rows:
            ws.append(r)
        for col in ws.columns:
            ws.column_dimensions[col[0].column_letter].width = min(60, max(10, *(len(str(c.value or "")) for c in col)))

    plan = chat.plan
    sheet("Plan", ["Day", "Meal", "Dish", "Ingredients", "Method", "kcal", "Protein (g)", "Prep (min)"],
          [[d["day"], m["slot"], m["name"],
            "; ".join(f"{i['item']} {_amount(i['quantity'], i['unit'])}" for i in m["ingredients"]),
            m.get("method", ""), m["kcal"], m["protein_g"], m["prep_minutes"]]
           for d in plan["days"] for m in d["meals"]], first=True)
    t = chat.targets or {}
    sheet("Daily totals", ["Day", "kcal", "Target kcal", "Protein (g)", "Target protein (g)"],
          [[day, v["kcal"], t.get("kcal_per_day"), v["protein_g"], t.get("protein_g_per_day")]
           for day, v in daily_totals(plan).items()])
    sheet("Shopping list", ["Aisle", "Item", "Quantity", "Unit"],
          [[AISLE_NAMES[a], i["item"], i["quantity"], i["unit"]] for a, items in shopping_list(plan).items() for i in items])
    sheet("Targets", ["Measure", "Value"],
          [[k.replace("_", " "), v] for k, v in t.items() if not isinstance(v, list)] +
          [["note", "Calories and protein are estimates. Not medical or dietetic advice."]])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


FILES = {"plan": ("meal-plan.pdf", "application/pdf", plan_pdf),
         "shopping": ("shopping-list.pdf", "application/pdf", shopping_pdf),
         "xlsx": ("meal-plan.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", plan_xlsx)}
