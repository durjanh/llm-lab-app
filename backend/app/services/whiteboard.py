"""The AI whiteboard: a person sketches on a board, and a model that can read images says what the sketch is, as data:
a function to plot with sliders for its constants, or a 3D solid to turn and cut. The page draws the result. Code
checks what the model says before the page sees it; the model gets one more try if it is wrong.

The model reads and explains. Code does the maths: expressions are checked against a whitelist here and evaluated by
the page's own parser, and the solid's cross-sections and angles are computed by the page.

Three more modes use the same split. Guess my drawing: the model guesses, and code decides whether a guess is the word.
Bring it to life: the model reads a sketched scene into bodies (balls, boxes, lines), code checks them, and the page's
physics engine moves them. Sketch to picture: the image model redraws the sketch in a style.
"""
from __future__ import annotations

import ast
import base64
import json
import re
from typing import Any

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import CLAUDE_MODEL, text_of
from .spend import SpendTracker

SHAPES = ["cube", "cuboid", "square_pyramid", "tetrahedron", "triangular_prism", "cylinder", "cone", "sphere"]
FUNCTIONS = {"sin", "cos", "tan", "asin", "acos", "atan", "sqrt", "abs", "exp", "ln", "log", "floor", "ceil"}
CONSTANTS = {"pi", "e"}
MAX_IMAGE_BYTES = 4 * 2**20

SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["kind", "read_as", "title", "functions", "parameters", "x_range", "solid", "section", "explanation"],
    "properties": {
        "kind": {"type": "string", "enum": ["function", "solid", "unknown"]},
        "read_as": {"type": "string", "description": "what you saw in the sketch, in a few words"},
        "title": {"type": "string"},
        "functions": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["expression", "label"],
            "properties": {"expression": {"type": "string"}, "label": {"type": "string"}}}},
        "parameters": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["name", "value", "min", "max"],
            "properties": {"name": {"type": "string"}, "value": {"type": "number"}, "min": {"type": "number"},
                           "max": {"type": "number"}}}},
        "x_range": {"type": "array", "items": {"type": "number"}},
        "solid": {"type": "object", "additionalProperties": False, "required": ["shape", "width", "depth", "height"],
                  "properties": {"shape": {"type": "string", "enum": SHAPES}, "width": {"type": "number"},
                                 "depth": {"type": "number"}, "height": {"type": "number"}}},
        "section": {"type": "object", "additionalProperties": False, "required": ["enabled", "normal", "offset"],
                    "properties": {"enabled": {"type": "boolean"},
                                   "normal": {"type": "array", "items": {"type": "number"}},
                                   "offset": {"type": "number"}}},
        "explanation": {"type": "string"},
    },
}

SYSTEM = """You read a sketch on a classroom whiteboard and say what it is, as data, so the board can redraw it
properly: a function to plot, or a 3D solid to turn and cut. Then explain it briefly for a secondary-school student.
Use the sketch and the student's words together. If the board is empty or unclear but the words ask for something
("plot y = x^2", "make a cube"), build what the words ask for; "unknown" is only for when neither says what to draw.

Functions:
- kind "function". One entry per function or equation you see, written with x and named constants, using explicit
  * for multiplication and ^ for powers, and only these functions: sin cos tan asin acos atan sqrt abs exp ln log
  floor ceil, and the constants pi and e. "y = x^2 - 3" becomes "x^2 - 3"; "y = A sin x + B" becomes "A*sin(x) + B".
- Every letter other than x, pi and e is a parameter: list it with a sensible value, min and max for a slider.
  Single capital letters are the usual names. Leave parameters empty if there are none.
- x_range: [min, max], usually [-6.3, 6.3] for trigonometry and [-5, 5] otherwise.

Solids:
- kind "solid", the closest shape in the list, with width (x), depth (z) and height (y), around 1 to 3 units. A cube
  has all three equal. A hand-drawn box is a cube unless its sides are clearly different.
- section: if the person asks to cut it, or the sketch shows a cut, set enabled true and give the cutting plane's
  normal [x, y, z] and its offset from the centre along that normal. The regular hexagon through a cube's centre is
  normal [1, 1, 1], offset 0. Otherwise enabled false, normal [0, 1, 0], offset 0.

Fill every field. For the kind you do not use, give empty functions and parameters, x_range [-5, 5], a cube of 2 and a
disabled section. If you cannot tell what the sketch is, kind "unknown" and say what you saw.
The explanation is three to six sentences in plain British English, Markdown allowed, about the maths: what changing
each parameter does, or how the solid's faces, edges and sections work. Do not describe the drawing tools."""

ASK_SYSTEM = """You are a patient maths teacher beside a classroom whiteboard. The board shows the object described
in JSON below, which the student can see. Answer their question in plain British English, briefly (a short paragraph
or a few bullet points), using the numbers on the board where you can. Markdown is allowed."""


def _check_expression(expr: str, params: set[str]) -> str | None:
    """Why this expression is not safe to plot, or None. A whitelist: numbers, x, the parameters, + - * / ^ and the
    named functions; nothing else (no attributes, indexing, keywords or calls of anything else)."""
    try:
        tree = ast.parse(expr.replace("^", "**"), mode="eval")
    except SyntaxError:
        return f"'{expr}' is not a valid expression"
    for node in ast.walk(tree):
        if isinstance(node, (ast.Expression, ast.Load, ast.BinOp, ast.UnaryOp, ast.Add, ast.Sub, ast.Mult, ast.Div,
                             ast.Pow, ast.USub, ast.UAdd)):
            continue
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            continue
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in FUNCTIONS or len(node.args) != 1 or node.keywords:
                return f"'{expr}': only these functions, with one argument each: {', '.join(sorted(FUNCTIONS))}"
            continue
        if isinstance(node, ast.Name):
            if node.id == "x" or node.id in CONSTANTS or node.id in FUNCTIONS or node.id in params:
                continue
            return f"'{expr}' uses '{node.id}', which is not x, pi, e or a listed parameter"
        return f"'{expr}' uses something other than numbers, x, parameters, + - * / ^ and functions"
    return None


def problems(board: dict) -> list[str]:
    """Everything wrong with the model's reading, for it to fix. Empty when the page may draw it."""
    out: list[str] = []
    if board.get("kind") == "function":
        if not board.get("functions"):
            out.append("kind is function but there are no functions")
        names = [p.get("name", "") for p in board.get("parameters") or []]
        for p in board.get("parameters") or []:
            if not str(p.get("name", "")).isidentifier() or p["name"] in {"x", *CONSTANTS, *FUNCTIONS}:
                out.append(f"parameter name '{p.get('name')}' must be a plain letter or word other than x")
            elif not p["min"] < p["max"] or not p["min"] <= p["value"] <= p["max"]:
                out.append(f"parameter {p['name']} needs min < max and its value between them")
        for f in board.get("functions") or []:
            why = _check_expression(str(f.get("expression", "")), set(names))
            if why:
                out.append(why)
        xr = board.get("x_range") or []
        if len(xr) != 2 or not xr[0] < xr[1]:
            out.append("x_range must be [min, max] with min < max")
    elif board.get("kind") == "solid":
        s = board.get("solid") or {}
        if s.get("shape") not in SHAPES:
            out.append(f"solid.shape must be one of {', '.join(SHAPES)}")
        if not all(0.2 <= float(s.get(k) or 0) <= 10 for k in ("width", "depth", "height")):
            out.append("solid width, depth and height must each be between 0.2 and 10")
        n = (board.get("section") or {}).get("normal") or []
        if (board.get("section") or {}).get("enabled") and (len(n) != 3 or not any(n)):
            out.append("section.normal must be three numbers, not all zero")
    return out


# ----- guess my drawing -----

GUESS_MODEL = "claude-haiku-5-5"  # many small calls a round, so the cheapest model that reads images
MAX_GUESSES = 3
# Words to draw, by difficulty, each with the other answers that count as right.
WORDS: dict[str, dict[str, list[str]]] = {
    "easy": {
        "sun": [], "house": ["home", "cottage", "hut"], "tree": [], "fish": [], "star": [], "flower": ["daisy", "tulip"],
        "cat": ["kitten"], "apple": [], "car": ["automobile"], "cloud": [], "heart": [], "boat": ["ship", "sailboat", "yacht"],
        "cup": ["mug", "teacup"], "ladder": [], "balloon": [], "moon": ["crescent"],
    },
    "medium": {
        "bicycle": ["bike", "cycle"], "umbrella": ["parasol"], "guitar": [], "rocket": ["spaceship", "space shuttle"],
        "snowman": [], "butterfly": [], "glasses": ["spectacles", "sunglasses", "eyeglasses"], "key": [],
        "lighthouse": [], "mushroom": ["toadstool"], "clock": ["watch"], "scissors": [], "snail": [],
        "kite": [], "candle": [], "bridge": [],
    },
    "hard": {
        "windmill": ["wind turbine"], "helicopter": ["chopper"], "octopus": ["squid"], "castle": ["fortress"],
        "skateboard": [], "volcano": [], "telescope": [], "giraffe": [], "tractor": [], "anchor": [],
        "microscope": [], "parachute": ["parachutist"], "saxophone": ["sax"], "crane": [],
    },
}
GUESS_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["guesses", "comment"],
    "properties": {
        "guesses": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["label", "confidence"],
            "properties": {"label": {"type": "string"}, "confidence": {"type": "number"}}}},
        "comment": {"type": "string"},
    },
}
GUESS_SYSTEM = """You are playing a drawing game. Someone is sketching one everyday thing on a dark whiteboard, and the
sketch may be unfinished. Say what it is: up to three guesses, most likely first, each a common noun of one or two
words in lower case (never a sentence), with your confidence from 0 to 1. Then one short, friendly comment, at most
twelve words, on what you can see so far. If the board shows only a mark or two, still guess."""


def normalise(label: str) -> str:
    """A guess reduced to plain words: lower case, no articles or punctuation, simple plurals made singular."""
    words = [w for w in re.sub(r"[^a-z ]+", " ", label.lower()).split() if w not in {"a", "an", "the", "of"}]
    words = [w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w for w in words]
    return " ".join(words)


def is_word(word: str, label: str) -> bool:
    """Whether a guess counts as the word: the word itself or one of its listed synonyms, alone or as a whole word in
    a longer guess ("a pine tree" is "tree"; "treehouse" is not)."""
    accepted = {normalise(word)}
    for words in WORDS.values():
        if word in words:
            accepted |= {normalise(w) for w in words[word]}
    guess = normalise(label)
    return bool(guess) and any(re.search(rf"\b{re.escape(a)}\b", guess) for a in accepted if a)


def clean_guesses(answer: dict) -> list[dict[str, Any]]:
    """At most three guesses with a label, confidence clipped to 0..1, most confident first."""
    out = []
    for g in answer.get("guesses") or []:
        label = str(g.get("label", "")).strip().lower()[:40]
        try:
            confidence = max(0.0, min(1.0, float(g.get("confidence", 0))))
        except (TypeError, ValueError):
            confidence = 0.0
        if label:
            out.append({"label": label, "confidence": round(confidence, 2)})
    return sorted(out, key=lambda g: -g["confidence"])[:MAX_GUESSES]


# ----- bring it to life -----

MAX_BODIES = 40
SCENE_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["bodies", "comment"],
    "properties": {
        "bodies": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["kind", "label", "moving", "x", "y", "width", "height", "radius", "angle", "x2", "y2"],
            "properties": {
                "kind": {"type": "string", "enum": ["ball", "box", "line"]}, "label": {"type": "string"},
                "moving": {"type": "boolean"},
                "x": {"type": "number"}, "y": {"type": "number"}, "width": {"type": "number"},
                "height": {"type": "number"}, "radius": {"type": "number"}, "angle": {"type": "number"},
                "x2": {"type": "number"}, "y2": {"type": "number"}}}},
        "comment": {"type": "string"},
    },
}
SCENE_SYSTEM = """You read a sketch of a simple physics scene so a physics engine can run it. The board is {w} units
wide and {h} high; x runs right and y runs DOWN from the top-left corner, and the picture shows the whole board. List
every object as a body, in board units:

- "ball": a circle. x, y is its centre; radius. Balls move (moving true) unless the person says otherwise.
- "box": a rectangle. x, y is its CENTRE; width and height; angle in degrees, clockwise, 0 when its sides are level.
  Boxes move unless they are clearly a shelf, table, wall or platform, which are fixed (moving false).
- "line": a ramp, floor, platform or wall drawn as a single stroke: from x, y to x2, y2. Lines never move.

Fill every field; use 0 for the ones a kind does not need. A triangle or other shape becomes the nearest box or, for a
ramp, a line along its sloping side. Ignore writing and arrows. The page already adds a floor and walls at the board's
edges, so do not add them. A list of shapes the page has already recognised follows the picture: trust its
coordinates over your own reading of the picture, and use the picture to decide what each one is and whether it moves.
The comment is one sentence saying what you expect to happen when it runs."""


def scene_problems(scene: dict, width: float, height: float) -> list[str]:
    """Everything wrong with a scene, for the model to fix. Empty when the page may run it."""
    bodies = scene.get("bodies") or []
    if not bodies:
        return ["there are no bodies: list at least one ball, box or line"]
    out: list[str] = []
    if len(bodies) > MAX_BODIES:
        out.append(f"{len(bodies)} bodies; the limit is {MAX_BODIES}")
    margin = 0.1 * max(width, height)
    inside = lambda x, y: -margin <= x <= width + margin and -margin <= y <= height + margin  # noqa: E731
    for i, b in enumerate(bodies[:MAX_BODIES]):
        kind = b.get("kind")
        try:
            n = {k: float(b.get(k) or 0) for k in ("x", "y", "width", "height", "radius", "angle", "x2", "y2")}
        except (TypeError, ValueError):
            out.append(f"body {i}: every measurement must be a number")
            continue
        if not inside(n["x"], n["y"]):
            out.append(f"body {i} ({kind}): x, y is off the board, which is {width:.0f} by {height:.0f}")
        if kind == "ball":
            if not 3 <= n["radius"] <= min(width, height) / 2:
                out.append(f"body {i} (ball): radius must be between 3 and {min(width, height) / 2:.0f}")
        elif kind == "box":
            if not (4 <= n["width"] <= width and 4 <= n["height"] <= height):
                out.append(f"body {i} (box): width and height must be at least 4 and fit on the board")
        elif kind == "line":
            if not inside(n["x2"], n["y2"]):
                out.append(f"body {i} (line): x2, y2 is off the board")
            elif (n["x2"] - n["x"]) ** 2 + (n["y2"] - n["y"]) ** 2 < 100:
                out.append(f"body {i} (line): it must be at least 10 units long")
            if b.get("moving"):
                out.append(f"body {i} (line): lines are fixed, so moving must be false")
        else:
            out.append(f"body {i}: kind must be ball, box or line")
    return out[:12]


def clean_scene(scene: dict) -> list[dict[str, Any]]:
    """The bodies with only the fields their kind uses, as plain numbers."""
    out = []
    for b in scene["bodies"]:
        n = {k: round(float(b.get(k) or 0), 1) for k in ("x", "y", "width", "height", "radius", "angle", "x2", "y2")}
        base = {"kind": b["kind"], "label": str(b.get("label", ""))[:40], "x": n["x"], "y": n["y"]}
        if b["kind"] == "ball":
            out.append({**base, "moving": bool(b.get("moving")), "radius": n["radius"]})
        elif b["kind"] == "box":
            out.append({**base, "moving": bool(b.get("moving")), "width": n["width"], "height": n["height"],
                        "angle": n["angle"]})
        else:
            out.append({**base, "moving": False, "x2": n["x2"], "y2": n["y2"]})
    return out


PICTURE_STYLES = ["a soft watercolour painting", "a children's picture-book illustration", "pixel art",
                  "a realistic photograph", "a clean flat vector illustration", "a pencil drawing with shading"]


class WhiteboardService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, images: Any = None):
        self.claude, self.spend, self.images = claude, spend, images  # images: the image generation service, or None

    def info(self) -> dict[str, Any]:
        picture = bool(self.images and self.images.info()["configured"])
        return {"shapes": SHAPES, "guess_model": GUESS_MODEL, "words": {level: sorted(words) for level, words in WORDS.items()},
                "picture": picture, "picture_styles": PICTURE_STYLES,
                "picture_why": "" if picture else "Sketch to picture needs a gpt-image-2 deployment: set "
                                                  "AZURE_MEDIA_ENDPOINT in .env and restart the backend."}

    @staticmethod
    def _png(image_b64: str) -> bytes:
        try:
            raw = base64.b64decode(image_b64, validate=True)
        except ValueError:
            raise ApiError(400, "invalid_request", "The image must be a base64 PNG.") from None
        if not raw.startswith(b"\x89PNG") or len(raw) > MAX_IMAGE_BYTES:
            raise ApiError(400, "invalid_request", "Send the board as a PNG under 4 MB.")
        return raw

    def _call(self, model: str, system: str, content: list[dict], schema: dict | None, max_tokens: int) -> tuple[str, float]:
        params: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "system": system,
                                  "messages": [{"role": "user", "content": content}]}
        if schema:
            params["output_config"] = {"format": {"type": "json_schema", "schema": schema}}
        try:
            response = self.claude.create(**params)
        except Exception as exc:
            raise to_api_error(exc) from exc
        return text_of(response), self.spend.charge(response, model) or 0.0

    def read(self, image_b64: str, prompt: str, model: str | None) -> dict[str, Any]:
        """What the sketch is, checked. One retry, with the problems, if the first answer cannot be drawn."""
        model = model or CLAUDE_MODEL
        self._png(image_b64)
        ask = prompt.strip() or "What is this? Redraw it properly."
        content = [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": image_b64}},
                   {"type": "text", "text": f"The student says: {ask}"}]
        cost, tries = 0.0, []
        for attempt in range(2):
            text, spent = self._call(model, SYSTEM, content, SCHEMA, 3000)
            cost += spent
            try:
                board = json.loads(text)
            except json.JSONDecodeError:
                board, found = {}, ["the answer was not valid JSON matching the schema"]
            else:
                found = problems(board)
            tries.append({"attempt": attempt + 1, "problems": found})
            if not found:
                return {"board": board, "tries": tries, "cost_usd": round(cost, 6), "model": model}
            content = content + [{"type": "text", "text": "Your answer could not be drawn: " + "; ".join(found)
                                  + ". Answer again with the whole object, fixed."}]
        raise ApiError(502, "unreadable", "The model's reading could not be drawn: " + "; ".join(tries[-1]["problems"]))

    def ask(self, question: str, board: dict, model: str | None) -> dict[str, Any]:
        model = model or CLAUDE_MODEL
        context = json.dumps(board, ensure_ascii=False)[:6000]
        text, cost = self._call(model, f"{ASK_SYSTEM}\n\n<board>{context}</board>",
                                [{"type": "text", "text": question}], None, 1200)
        return {"answer": text, "cost_usd": round(cost, 6), "model": model}

    def guess(self, image_b64: str, word: str | None, model: str | None) -> dict[str, Any]:
        """What the model thinks the sketch is. The model is never told the word; code decides whether a guess is it."""
        model = model or GUESS_MODEL
        self._png(image_b64)
        if word is not None and not any(word in words for words in WORDS.values()):
            raise ApiError(400, "invalid_request", "That is not one of the game's words.")
        content = [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": image_b64}},
                   {"type": "text", "text": "What is being drawn?"}]
        text, cost = self._call(model, GUESS_SYSTEM, content, GUESS_SCHEMA, 300)
        try:
            answer = json.loads(text)
        except json.JSONDecodeError:
            answer = {}
        guesses = clean_guesses(answer if isinstance(answer, dict) else {})
        matched = next((g["label"] for g in guesses if word and is_word(word, g["label"])), None)
        return {"guesses": guesses, "comment": str(answer.get("comment", ""))[:160] if isinstance(answer, dict) else "",
                "matched": matched, "cost_usd": round(cost, 6), "model": model}

    def scene(self, image_b64: str, hints: list[dict], width: float, height: float, prompt: str,
              model: str | None) -> dict[str, Any]:
        """The sketch as bodies for the page's physics engine, checked. One retry with the problems."""
        model = model or CLAUDE_MODEL
        self._png(image_b64)
        seen = json.dumps(hints[:60], ensure_ascii=False)[:6000] if hints else "none"
        content = [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": image_b64}},
                   {"type": "text", "text": f"Shapes the page recognised (board units): {seen}\n"
                                            f"The person says: {prompt.strip() or 'Bring it to life.'}"}]
        system = SCENE_SYSTEM.format(w=round(width), h=round(height))
        cost, tries = 0.0, []
        for attempt in range(2):
            text, spent = self._call(model, system, content, SCENE_SCHEMA, 4000)
            cost += spent
            try:
                scene = json.loads(text)
            except json.JSONDecodeError:
                scene, found = {}, ["the answer was not valid JSON matching the schema"]
            else:
                found = scene_problems(scene, width, height)
            tries.append({"attempt": attempt + 1, "problems": found})
            if not found:
                return {"bodies": clean_scene(scene), "comment": str(scene.get("comment", ""))[:300], "tries": tries,
                        "cost_usd": round(cost, 6), "model": model}
            content = content + [{"type": "text", "text": "That scene cannot be run: " + "; ".join(found)
                                  + ". Answer again with the whole scene, fixed."}]
        raise ApiError(502, "unreadable", "The model's scene could not be run: " + "; ".join(tries[-1]["problems"]))

    def picture(self, image_b64: str, style: str, subject: str) -> dict[str, Any]:
        """The sketch redrawn by the image model in a style. The sketch goes in as the reference image."""
        if not self.images or not self.images.info()["configured"]:
            raise ApiError(503, "not_configured", self.info()["picture_why"])
        raw = self._png(image_b64)
        what = f" It shows: {subject.strip()}." if subject.strip() else ""
        prompt = (f"Make {style.strip()} of the scene in this rough whiteboard sketch.{what} Use the sketch only as a "
                  "layout: the same objects in the same places and proportions. Paint them as real, solid, coloured "
                  "things with their own materials and light; do not keep the white chalk lines or the dark board. "
                  "Add nothing that is not in the sketch, and no writing or frame.")
        made = self.images.from_sketch(raw, prompt)
        item = made["items"][0]
        return {"id": item["id"], "url": f"/api/imagegen/images/{item['id']}", "prompt": prompt,
                "cost_usd": made["cost_usd"], "seconds": made["seconds"]}
