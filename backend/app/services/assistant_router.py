"""Automatic model routing for the assistant: the lab picks the model and effort for each message when Auto is on.

It decides from cheap signals that can be explained in one line first: the attachments and their kinds, pictures,
whether the message asks for work in the sandbox (make, build, chart, deck, pdf, run, analyse), its length, signs of
work big enough for sub-agents, the chat's last turn and its MCP servers. Only when those leave it unclear does it ask
the cheapest Claude model one short question (low effort, at most 60 tokens, strict JSON: {tier, reason}); an answer
that cannot be read means the middle tier.

Three tiers, each a list of models in order of preference (ROUTES, the one place they are set):
  quick     the local model when one is set up, else Haiku at low effort
  standard  Sonnet at medium effort
  deep      Opus at high effort
A model the lab does not offer is skipped and the tier below is tried; a GPT deployment is used only when nothing
else is offered. Pictures never go to the local model (it may not read them) and PDFs go to Claude only. With Auto,
the model and effort the person chose on the page are a ceiling when they send one: routing and escalation never go
above it.

Escalation: when the routed model refuses, writes nothing, is cut off at the length limit, or every tool call in two
replies in a row fails, the rest of the turn moves to the next tier up, once, and says so.

Each routed turn is written to generated/assistant/routing.jsonl with what it cost and what the same tokens would have
cost on Sonnet at medium effort, so the control layer can show what routing saved.
"""
from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from ..shared import cost_usd, is_local

TIERS = ("quick", "standard", "deep")
LOCAL = "{local}"  # stands for the local model in ROUTES, when one is set up
ROUTES: dict[str, list[tuple[str, str]]] = {  # tier -> (model, effort), most preferred first
    "quick": [(LOCAL, ""), ("claude-haiku-5-5", "low")],
    "standard": [("claude-sonnet-5-5", "medium")],
    "deep": [("claude-opus-5-5", "high")],
}
BASELINE = ("claude-sonnet-5-5", "medium")  # what the savings are measured against
EFFORT_RANK = {"": 0, "low": 1, "medium": 2, "high": 3, "xhigh": 4, "max": 5}
CLASSIFIER_MAX_TOKENS = 60
IMAGE_EXT = {"png", "jpg", "jpeg", "gif", "webp"}

WORK = re.compile(r"\b(make|build|create|generate|draw|plot|chart|graph|deck|slides?|presentation|pptx|pdf|docx|"
                  r"xlsx|excel|spreadsheet|csv|report|run|execute|script|code|analy[sz]e|analysis|calculate|"
                  r"summari[sz]e (?:the|this) (?:file|document)|convert|export|download|scrape|fetch)\b", re.I)
DEEP = re.compile(r"\b(prove|proof|derive|step by step|reason(?:ing)? through|in depth|thorough(?:ly)?|"
                  r"architect(?:ure)?|design (?:a|the)|strategy|trade-?offs?|debug|root cause|optimi[sz]e|"
                  r"rigorous|research|evaluate|critique|plan (?:a|the|out)|multi-step|complex|hard)\b", re.I)
SPLIT = re.compile(r"\b(in parallel|each of|for (?:each|every)|several|sub-?agents?|all of these|one per)\b", re.I)
QUICK = re.compile(r"^\s*(what|who|when|where|which|how many|how much|is|are|does|do|can|define|translate|spell|"
                   r"convert \d|hi|hello|thanks|thank you)\b", re.I)
FOLLOW_UP = re.compile(r"^\s*(and|also|what about|now|then|ok|okay|great|thanks|same|again|continue|go on)\b", re.I)


@dataclass
class Route:
    tier: str
    model: str
    effort: str
    reason: str
    by: str  # rules | classifier
    classifier_cost_usd: float = 0.0


@dataclass
class Needs:
    """What the message needs a model to read: pictures (never the local model) and PDFs (Claude only)."""
    images: bool = False
    pdf: bool = False


@dataclass
class AutoState:
    """A routed turn's routing: the first choice, the ceiling, whether it escalated, and its tokens for the savings."""
    route: Route
    needs: Needs
    ceiling: tuple[str, str] | None  # (model, effort) the person chose, when they sent one
    escalated: tuple[str, str] | None = None  # (from model, to model)
    tool_failures: int = 0
    tokens: dict[str, int] = field(default_factory=lambda: {"input_tokens": 0, "output_tokens": 0,
                                                             "cache_read_input_tokens": 0,
                                                             "cache_creation_input_tokens": 0})


def tier_of(model: str) -> str:
    """The tier a model belongs to, for ceilings: Opus is deep, Sonnet and GPT standard, Haiku and local quick."""
    if "opus" in model:
        return "deep"
    if "sonnet" in model or model.startswith("gpt-"):
        return "standard"
    return "quick"


def needs_of(attachments: list[dict[str, Any]]) -> Needs:
    kinds = [(a.get("media_type") or "", (a.get("name") or "").rpartition(".")[2].lower()) for a in attachments]
    return Needs(images=any(m.startswith("image/") or e in IMAGE_EXT for m, e in kinds),
                 pdf=any(m == "application/pdf" or e == "pdf" for m, e in kinds))


def rules(text: str, attachments: list[dict[str, Any]], last_tier: str | None, mcp_enabled: bool) -> tuple[str, str] | None:
    """The tier from signals alone, with the reason, or None when they do not settle it."""
    words = len(text.split())
    deep = DEEP.findall(text)
    split = SPLIT.search(text)
    work = WORK.search(text)
    bullets = sum(1 for line in text.splitlines() if re.match(r"\s*(?:[-*•]|\d+[.)])\s+", line))
    if split and (work or bullets >= 3 or len(attachments) >= 2):
        return "deep", f"several parts that could run as sub-agents (\"{split.group(0)}\")"
    if len(deep) >= 2 or (deep and (words > 250 or work)):
        return "deep", f"asks for careful reasoning (\"{deep[0]}\"" + (", with work to do)" if work else ")")
    if words > 400:
        return "deep", f"a long, detailed request ({words} words)"
    if last_tier == "deep" and FOLLOW_UP.match(text) and words < 40:
        return "deep", "a short follow-up to a turn that needed the deep tier"
    if attachments:
        return "standard", f"{len(attachments)} attached file{'s' if len(attachments) != 1 else ''} to work with"
    if work:
        return "standard", f"needs work in the sandbox (\"{work.group(0)}\")"
    if mcp_enabled and re.search(r"\b(look up|search|find|check|list|get)\b", text, re.I):
        return "standard", "may use the chat's MCP tools"
    if deep:
        return None  # one reasoning word on its own: ask
    if words <= 30 and (QUICK.match(text) or text.rstrip().endswith("?")):
        return "quick", "a short question with nothing to make or read"
    if words <= 8:
        return "quick", "a short message"
    return None


CLASSIFIER_SCHEMA = {"type": "object", "properties": {"tier": {"type": "string", "enum": list(TIERS)},
                                                     "reason": {"type": "string"}},
                     "required": ["tier", "reason"], "additionalProperties": False}
CLASSIFIER_PROMPT = ("Choose the model tier for this message to an assistant that can run code and make files. "
                     "quick: a fact, a definition, small talk, a short rewrite. standard: ordinary work, writing, "
                     "analysis, making a file. deep: hard reasoning, design, proofs, long multi-step work. Reply in "
                     "JSON only: {\"tier\": ..., \"reason\": a few words}.\n\nMessage:\n")


def parse_classifier(text: str) -> tuple[str, str] | None:
    try:
        data = json.loads(text.strip().strip("`").removeprefix("json").strip())
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("tier") not in TIERS:
        return None
    return data["tier"], " ".join(str(data.get("reason") or "").split())[:120] or "the classifier's choice"


class Router:
    """Chooses a model for a tier from the models this lab offers, within what the message needs and the ceiling."""

    def __init__(self, models: list[str], routes: dict[str, list[tuple[str, str]]] | None = None,
                 unavailable: set[str] | None = None):
        """`unavailable`: offered models that cannot answer now (the local model with its server down)."""
        self.routes = routes or ROUTES
        self.models = [m for m in models if m not in (unavailable or set())] or list(models)

    def _candidates(self, tier: str) -> list[tuple[str, str]]:
        local = next((m for m in self.models if is_local(m)), None)
        out = []
        for model, effort in self.routes.get(tier, []):
            if model == LOCAL:
                if local:
                    out.append((local, ""))
            elif model in self.models:
                out.append((model, effort))
        return out

    @staticmethod
    def _fits(model: str, needs: Needs) -> bool:
        if needs.pdf and not model.startswith("claude-"):
            return False
        return not (needs.images and is_local(model))

    def pick(self, tier: str, needs: Needs, ceiling: tuple[str, str] | None) -> tuple[str, str, str]:
        """(model, effort, tier used) for `tier`: falls down the tiers when a model is not offered, does not fit or
        would pass the ceiling; a GPT deployment only when nothing else is offered."""
        top = TIERS.index(tier_of(ceiling[0])) if ceiling else len(TIERS) - 1
        start = min(TIERS.index(tier), top)
        for i in range(start, -1, -1):
            for model, effort in self._candidates(TIERS[i]):
                if self._fits(model, needs):
                    return model, self._cap_effort(model, effort, ceiling), TIERS[i]
        for i in range(start + 1, len(TIERS)):  # nothing at or below: the lowest tier above that fits the needs
            for model, effort in self._candidates(TIERS[i]):
                if self._fits(model, needs) and (not ceiling or i <= top):
                    return model, self._cap_effort(model, effort, ceiling), TIERS[i]
        if ceiling and ceiling[0] in self.models:
            return ceiling[0], ceiling[1], tier_of(ceiling[0])
        gpt = [m for m in self.models if m.startswith("gpt-") and not needs.pdf]
        if gpt:
            return gpt[0], "medium", "standard"
        model = next((m for m in self.models if self._fits(m, needs)), self.models[0])
        return model, "", tier_of(model)

    @staticmethod
    def _cap_effort(model: str, effort: str, ceiling: tuple[str, str] | None) -> str:
        if ceiling and model == ceiling[0] and ceiling[1] and EFFORT_RANK.get(effort, 0) > EFFORT_RANK.get(ceiling[1], 0):
            return ceiling[1]
        return effort

    def next_up(self, state: AutoState, current: str) -> tuple[str, str, str] | None:
        """The tier above the current model's, within the ceiling, or None when there is nowhere higher to go."""
        tier = tier_of(current)
        top = TIERS.index(tier_of(state.ceiling[0])) if state.ceiling else len(TIERS) - 1
        for i in range(TIERS.index(tier) + 1, top + 1):
            for model, effort in self._candidates(TIERS[i]):
                if model != current and self._fits(model, state.needs):
                    return model, self._cap_effort(model, effort, state.ceiling), TIERS[i]
        return None


def baseline_cost(tokens: dict[str, int]) -> float:
    """What the turn's tokens would have cost on the baseline model (Sonnet), at list prices."""
    return cost_usd(SimpleNamespace(**tokens), BASELINE[0]) or 0.0


class RoutingLog:
    """Every routed turn, one JSON line each, and the summary the control layer shows."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()

    def append(self, record: dict[str, Any]) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")

    def records(self) -> list[dict[str, Any]]:
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except FileNotFoundError:
            return []
        out = []
        for line in lines:
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out

    def summary(self) -> dict[str, Any]:
        rows = self.records()
        by_tier = {t: sum(1 for r in rows if r.get("tier") == t) for t in TIERS}
        actual = sum(float(r.get("cost_usd") or 0) for r in rows)
        baseline = sum(float(r.get("baseline_usd") or 0) for r in rows)
        return {"turns": len(rows), "by_tier": by_tier,
                "share": {t: round(n / len(rows), 4) if rows else 0.0 for t, n in by_tier.items()},
                "by_classifier": sum(1 for r in rows if r.get("by") == "classifier"),
                "escalations": sum(1 for r in rows if r.get("escalated_to")),
                "actual_usd": round(actual, 6), "baseline_usd": round(baseline, 6),
                "saved_usd": round(baseline - actual, 6), "baseline_model": BASELINE[0]}


def record_for(chat_id: str, turn_id: str, state: AutoState, cost: float) -> dict[str, Any]:
    return {"at": time.time(), "chat_id": chat_id, "turn_id": turn_id, **asdict(state.route),
            "escalated_to": state.escalated[1] if state.escalated else None, "cost_usd": round(cost, 6),
            "baseline_usd": round(baseline_cost(state.tokens), 6), "tokens": state.tokens}
