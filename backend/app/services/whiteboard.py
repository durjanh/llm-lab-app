"""The AI whiteboard: a person sketches on a board, and a model that can read images says what the sketch is, as data:
a function to plot with sliders for its constants, or a 3D solid to turn and cut. The page draws the result. Code
checks what the model says before the page sees it; the model gets one more try if it is wrong.

The model reads and explains. Code does the maths: expressions are checked against a whitelist here and evaluated by
the page's own parser, and the solid's cross-sections and angles are computed by the page.
"""
from __future__ import annotations

import ast
import base64
import json
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


class WhiteboardService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker):
        self.claude, self.spend = claude, spend

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
        try:
            raw = base64.b64decode(image_b64, validate=True)
        except ValueError:
            raise ApiError(400, "invalid_request", "The image must be a base64 PNG.") from None
        if not raw.startswith(b"\x89PNG") or len(raw) > MAX_IMAGE_BYTES:
            raise ApiError(400, "invalid_request", "Send the board as a PNG under 4 MB.")
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
