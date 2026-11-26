"""The control layer: usage, cost and access rules for every model call the lab makes.

A consumer is a part of the lab (the telemetry area of the request: assistant, coding, sites, tutor...) or a virtual
key that an outside coding agent uses through the lab's proxy ("key:<id>"). Each consumer may have a policy:

- allowed models, and the highest effort it may ask for (a call outside them is refused with 403);
- a daily and a monthly budget in US dollars, and a limit on requests per minute (refused with 429);
- a routing rule: send every call to one model, or move to a cheaper model once a share of the budget is spent;
- guardrails: refuse a request that contains an obvious secret (an API key or a private key), and mask email
  addresses and phone numbers in what is sent.

A consumer with no policy is not touched: its calls go through exactly as before, and are only counted.

It wraps the SDK client itself (ControlledClient), under the call timer and the failover gateway, so it sees every
call: the pages that go through the gateway, and the coding agent, harness, skills and decks that drive the client
directly. A refusal is an ApiError, which the failover router treats as final rather than a reason to switch model.
Spending is reserved before a call (an estimate from the prompt size and max_tokens) and settled to the real cost
after it, so two calls at once cannot both pass a budget that has room for only one.

Policies, keys, the ledger of spending by consumer and day, and the audit log live in generated/control-layer/
(gitignored). Keys are kept only as SHA-256 hashes; the key itself is shown once, when it is made.
"""
from __future__ import annotations

import calendar
import copy
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from collections import deque
from collections.abc import Callable, Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..core.errors import ApiError
from ..core.telemetry import current_area
from ..shared import PRICES, cost_usd

EFFORTS = ["low", "medium", "high", "xhigh", "max"]
CONSUMER = re.compile(r"^(?:[a-z0-9][a-z0-9_-]{0,39}|key:[0-9a-f]{12})$")
KEY_PREFIX = "llmlab-"
MAX_KEYS = 50
MAX_BLOCKED = 200
MAX_AUDIT = 500
MAX_OUTPUT_ESTIMATE = 8000  # tokens assumed for the reply when reserving; max_tokens above this is rarely used in full
LEDGER_DAYS = 400  # days of spending kept per consumer

# Obvious secrets: refused outright, because a masked key is still a leaked key in a log somewhere.
SECRETS = [
    ("an Anthropic API key", re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}")),
    ("an OpenAI-style API key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_\-]{32,}")),
    ("an AWS access key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("a GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("a Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("a private key", re.compile(r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----")),
    ("an Azure storage key", re.compile(r"AccountKey=[A-Za-z0-9+/=]{40,}")),
]
EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")
PHONE = re.compile(r"(?<![\w+])(?:\+\d{1,3}[ -]?)?(?:\(?\d{2,5}\)?[ -]?)\d{3,4}[ -]?\d{3,4}(?![\w])")

POLICY_FIELDS = {"allowed_models", "max_effort", "daily_usd", "monthly_usd", "rpm", "route_to", "downgrade_at",
                 "downgrade_to", "refuse_secrets", "mask_pii", "note"}


def _now_parts(at: float) -> tuple[str, str]:
    d = datetime.fromtimestamp(at, tz=timezone.utc)
    return d.strftime("%Y-%m-%d"), d.strftime("%Y-%m")


def _price(model: str) -> dict[str, float] | None:
    return PRICES.get(model)


def _texts(params: dict[str, Any]) -> Iterator[str]:
    """Every piece of text a request sends: the system prompt, and the text in each message and tool result."""
    system = params.get("system")
    if isinstance(system, str):
        yield system
    elif isinstance(system, list):
        for b in system:
            if isinstance(b, dict) and isinstance(b.get("text"), str):
                yield b["text"]
    for m in params.get("messages") or []:
        yield from _content_texts(m.get("content") if isinstance(m, dict) else None)


def _content_texts(content: Any) -> Iterator[str]:
    if isinstance(content, str):
        yield content
    elif isinstance(content, list):
        for b in content:
            if not isinstance(b, dict):
                continue
            if isinstance(b.get("text"), str):
                yield b["text"]
            if b.get("type") == "tool_result":
                yield from _content_texts(b.get("content"))


def find_secret(params: dict[str, Any]) -> str | None:
    """The kind of the first obvious secret in a request, or None."""
    for text in _texts(params):
        for kind, pattern in SECRETS:
            if pattern.search(text):
                return kind
    return None


def mask_text(text: str) -> str:
    return PHONE.sub("[phone]", EMAIL.sub("[email]", text))


def mask_request(params: dict[str, Any]) -> dict[str, Any]:
    """A copy of the request with email addresses and phone numbers masked in the messages people send (user turns
    and tool results). The system prompt is the lab's own text, so it is left alone."""
    out = copy.deepcopy(params)
    for m in out.get("messages") or []:
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        m["content"] = _mask_content(m.get("content"))
    return out


def _mask_content(content: Any) -> Any:
    if isinstance(content, str):
        return mask_text(content)
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict):
                if isinstance(b.get("text"), str):
                    b["text"] = mask_text(b["text"])
                if b.get("type") == "tool_result":
                    b["content"] = _mask_content(b.get("content"))
    return content


def estimate_cost(params: dict[str, Any], model: str) -> float:
    """A cautious cost for a call before it is made: about four characters a token in, max_tokens (capped) out."""
    price = _price(model)
    if not price:
        return 0.0
    chars = sum(len(t) for t in _texts(params)) + len(json.dumps(params.get("tools") or []))
    out = min(int(params.get("max_tokens") or 1024), MAX_OUTPUT_ESTIMATE)
    return (chars / 4 * price["input"] + out * price["output"]) / 1_000_000


def effort_of(params: dict[str, Any]) -> str | None:
    cfg = params.get("output_config")
    return cfg.get("effort") if isinstance(cfg, dict) and isinstance(cfg.get("effort"), str) else None


class Ticket:
    """One admitted call: what was reserved, the model asked for and the model used."""

    def __init__(self, consumer: str, reserved: float, asked: str, used: str):
        self.consumer, self.reserved, self.asked, self.used = consumer, reserved, asked, used
        self.settled = False


class ControlLayer:
    """Policies, virtual keys, the spending ledger and the audit log, with the checks every call passes."""

    def __init__(self, folder: Path, models: Callable[[], list[str]], clock: Callable[[], float] = time.time):
        self.folder, self.models, self.clock = folder, models, clock
        self._lock = threading.Lock()
        self._reserved: dict[str, float] = {}
        self._requests: dict[str, deque[float]] = {}
        self._blocked: deque[dict[str, Any]] = deque(maxlen=MAX_BLOCKED)
        self._policies: dict[str, dict[str, Any]] = self._read("policies.json", {})
        self._keys: list[dict[str, Any]] = self._read("keys.json", [])
        self._ledger: dict[str, dict[str, float]] = self._read("ledger.json", {})
        self._savings: dict[str, dict[str, float]] = self._read("savings.json", {})
        self._calls: dict[str, dict[str, int]] = self._read("calls.json", {})
        self._last_used_saved = 0.0

    # ---------- files ----------
    def _read(self, name: str, empty: Any) -> Any:
        try:
            data = json.loads((self.folder / name).read_text())
            return data if isinstance(data, type(empty)) else empty
        except (OSError, ValueError):
            return empty

    def _write(self, name: str, data: Any, private: bool = False) -> None:
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            tmp = self.folder / f".{name}.tmp"
            tmp.write_text(json.dumps(data, indent=1))
            if private:
                os.chmod(tmp, 0o600)
            tmp.replace(self.folder / name)
        except OSError:
            pass  # the rules still apply in memory; a full disk must not stop every model call

    def _audit(self, action: str, subject: str, before: Any, after: Any) -> None:
        entry = {"at": round(self.clock(), 3), "who": "this machine", "action": action, "subject": subject,
                 "before": before, "after": after}
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            with (self.folder / "audit.jsonl").open("a") as f:
                f.write(json.dumps(entry) + "\n")
        except OSError:
            pass

    def audit(self, limit: int = 50) -> list[dict[str, Any]]:
        try:
            lines = (self.folder / "audit.jsonl").read_text().splitlines()[-min(limit, MAX_AUDIT):]
        except OSError:
            return []
        out = []
        for line in reversed(lines):
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out

    # ---------- policies ----------
    def policies(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            return copy.deepcopy(self._policies)

    def check_policy(self, raw: dict[str, Any]) -> dict[str, Any]:
        """A clean policy from what the page sent, or a 400 that says what is wrong."""
        unknown = set(raw) - POLICY_FIELDS
        if unknown:
            raise ApiError(400, "invalid_request", f"Unknown policy settings: {', '.join(sorted(unknown))}.")
        models = self.models()
        p: dict[str, Any] = {}
        allowed = raw.get("allowed_models")
        if allowed is not None:
            if not isinstance(allowed, list) or not allowed or not all(isinstance(m, str) for m in allowed):
                raise ApiError(400, "invalid_request", "Allowed models must be a list of at least one model, or left out.")
            bad = [m for m in allowed if m not in models]
            if bad:
                raise ApiError(400, "invalid_request", f"Not one of the lab's models: {', '.join(bad)}.")
            p["allowed_models"] = list(dict.fromkeys(allowed))
        if raw.get("max_effort") not in (None, ""):
            if raw["max_effort"] not in EFFORTS:
                raise ApiError(400, "invalid_request", f"Max effort must be one of {', '.join(EFFORTS)}.")
            p["max_effort"] = raw["max_effort"]
        for name in ("daily_usd", "monthly_usd"):
            if raw.get(name) not in (None, ""):
                try:
                    v = float(raw[name])
                except (TypeError, ValueError):
                    raise ApiError(400, "invalid_request", f"{name} must be a number of dollars.") from None
                if not 0 < v <= 100_000:
                    raise ApiError(400, "invalid_request", f"{name} must be above 0 and at most 100,000.")
                p[name] = round(v, 4)
        if raw.get("rpm") not in (None, ""):
            try:
                v = int(raw["rpm"])
            except (TypeError, ValueError):
                raise ApiError(400, "invalid_request", "Requests per minute must be a whole number.") from None
            if not 1 <= v <= 10_000:
                raise ApiError(400, "invalid_request", "Requests per minute must be between 1 and 10,000.")
            p["rpm"] = v
        for name in ("route_to", "downgrade_to"):
            if raw.get(name) not in (None, ""):
                if raw[name] not in models:
                    raise ApiError(400, "invalid_request", f"{name}: {raw[name]} is not one of the lab's models.")
                if "allowed_models" in p and raw[name] not in p["allowed_models"]:
                    raise ApiError(400, "invalid_request", f"{name}: {raw[name]} is not in this policy's allowed models.")
                p[name] = raw[name]
        if raw.get("downgrade_at") not in (None, ""):
            try:
                v = float(raw["downgrade_at"])
            except (TypeError, ValueError):
                raise ApiError(400, "invalid_request", "downgrade_at must be a share between 0.1 and 1.") from None
            if not 0.1 <= v <= 1:
                raise ApiError(400, "invalid_request", "downgrade_at must be a share between 0.1 and 1.")
            p["downgrade_at"] = v
        if ("downgrade_at" in p) != ("downgrade_to" in p):
            raise ApiError(400, "invalid_request", "A downgrade needs both the share of the budget and the model.")
        if "downgrade_at" in p and not ({"daily_usd", "monthly_usd"} & set(p)):
            raise ApiError(400, "invalid_request", "A downgrade needs a daily or monthly budget to measure against.")
        p["refuse_secrets"] = bool(raw.get("refuse_secrets"))
        p["mask_pii"] = bool(raw.get("mask_pii"))
        if raw.get("note"):
            p["note"] = str(raw["note"])[:200]
        return p

    def set_policy(self, consumer: str, raw: dict[str, Any]) -> dict[str, Any]:
        if not CONSUMER.match(consumer or ""):
            raise ApiError(400, "invalid_request", "A consumer is a lab area name, or key: and a key's id.")
        if consumer.startswith("key:") and not any(k["id"] == consumer[4:] for k in self._keys):
            raise ApiError(404, "not_found", "No such key.")
        policy = self.check_policy(raw)
        with self._lock:
            before = self._policies.get(consumer)
            self._policies[consumer] = policy
            self._write("policies.json", self._policies)
        self._audit("policy set" if before is None else "policy changed", consumer, before, policy)
        return policy

    def remove_policy(self, consumer: str) -> None:
        with self._lock:
            before = self._policies.pop(consumer, None)
            if before is None:
                raise ApiError(404, "not_found", "That consumer has no policy.")
            self._write("policies.json", self._policies)
        self._audit("policy removed", consumer, before, None)

    # ---------- virtual keys ----------
    @staticmethod
    def _hash(key: str) -> str:
        return hashlib.sha256(key.encode()).hexdigest()

    def keys(self) -> list[dict[str, Any]]:
        """For the page: names, prefixes and dates, never the key or its hash."""
        with self._lock:
            return [{k: v for k, v in key.items() if k != "hash"} for key in self._keys]

    def create_key(self, name: str) -> dict[str, Any]:
        name = (name or "").strip()[:60]
        if not name:
            raise ApiError(400, "invalid_request", "Give the key a name, such as the tool or person using it.")
        with self._lock:
            if sum(1 for k in self._keys if not k.get("revoked_at")) >= MAX_KEYS:
                raise ApiError(400, "invalid_request", f"At most {MAX_KEYS} keys can be active at once.")
            key = KEY_PREFIX + secrets.token_urlsafe(32)
            record = {"id": secrets.token_hex(6), "name": name, "prefix": key[: len(KEY_PREFIX) + 6],
                      "hash": self._hash(key), "created_at": round(self.clock(), 3), "last_used_at": None,
                      "revoked_at": None}
            self._keys.append(record)
            self._write("keys.json", self._keys, private=True)
        self._audit("key created", f"key:{record['id']}", None, {"name": name, "prefix": record["prefix"]})
        return {**{k: v for k, v in record.items() if k != "hash"}, "key": key}

    def revoke_key(self, key_id: str) -> None:
        with self._lock:
            record = next((k for k in self._keys if k["id"] == key_id), None)
            if record is None:
                raise ApiError(404, "not_found", "No such key.")
            if record.get("revoked_at"):
                return
            record["revoked_at"] = round(self.clock(), 3)
            self._write("keys.json", self._keys, private=True)
        self._audit("key revoked", f"key:{key_id}", {"name": record["name"]}, None)

    def authenticate(self, presented: str | None) -> dict[str, Any] | None:
        """The active key a request presented, compared in constant time; None for a missing, wrong or revoked key."""
        if not presented or not presented.startswith(KEY_PREFIX):
            return None
        digest = self._hash(presented)
        with self._lock:
            found = None
            for record in self._keys:
                if hmac.compare_digest(record["hash"], digest):
                    found = record
            if found is None or found.get("revoked_at"):
                return None
            now = self.clock()
            found["last_used_at"] = round(now, 3)
            if now - self._last_used_saved > 60:  # "last used" is saved at most once a minute
                self._last_used_saved = now
                self._write("keys.json", self._keys, private=True)
            return {k: v for k, v in found.items() if k != "hash"}

    # ---------- spending ----------
    def spent(self, consumer: str, at: float | None = None) -> tuple[float, float]:
        """(today, this month) in dollars for a consumer, settled calls only."""
        day, month = _now_parts(self.clock() if at is None else at)
        days = self._ledger.get(consumer, {})
        return days.get(day, 0.0), sum(v for d, v in days.items() if d.startswith(month))

    def _settle_locked(self, t: Ticket, cost: float | None, saved: float) -> None:
        self._reserved[t.consumer] = max(0.0, self._reserved.get(t.consumer, 0.0) - t.reserved)
        if cost is None:
            return
        day, _ = _now_parts(self.clock())
        days = self._ledger.setdefault(t.consumer, {})
        days[day] = round(days.get(day, 0.0) + cost, 8)
        if len(days) > LEDGER_DAYS:
            for d in sorted(days)[: len(days) - LEDGER_DAYS]:
                del days[d]
        calls = self._calls.setdefault(t.consumer, {})
        calls[day] = calls.get(day, 0) + 1
        if saved > 0:
            s = self._savings.setdefault(t.consumer, {})
            s[day] = round(s.get(day, 0.0) + saved, 8)

    def settle(self, t: Ticket | None, message: Any) -> None:
        """Releases a call's reservation and records what it really cost, by the model that answered."""
        if t is None or t.settled:
            return
        t.settled = True
        cost, saved = None, 0.0
        usage = getattr(message, "usage", None) if message is not None else None
        if usage is not None:
            served = getattr(message, "model", None)
            model = served if isinstance(served, str) and served in PRICES else t.used
            try:
                cost = cost_usd(usage, model) or 0.0
                if t.asked != model and (at_asked := cost_usd(usage, t.asked)) is not None:
                    saved = max(0.0, at_asked - cost)  # what routing saved against the model the code asked for
            except Exception:  # an odd usage object must not break the reply it came with
                cost = 0.0
        with self._lock:
            self._settle_locked(t, cost, saved)
            if cost is not None:
                self._write("ledger.json", self._ledger)
                self._write("calls.json", self._calls)
                if saved:
                    self._write("savings.json", self._savings)

    # ---------- the checks ----------
    def _block(self, consumer: str, status: int, kind: str, reason: str, model: str) -> ApiError:
        self._blocked.appendleft({"at": round(self.clock(), 3), "consumer": consumer, "status": status,
                                  "reason": reason, "model": model})
        return ApiError(status, kind, f"Control layer ({consumer}): {reason}")

    def admit(self, params: dict[str, Any], consumer: str | None = None) -> tuple[dict[str, Any], Ticket]:
        """Checks one call against its consumer's policy. Returns the request to send (rerouted or masked if the
        policy says so) and a ticket to settle afterwards; raises ApiError when the policy refuses it."""
        consumer = consumer or current_area()
        asked = str(params.get("model", ""))
        with self._lock:
            policy = self._policies.get(consumer)
            if policy is None:  # no policy: exactly as before, only counted
                return params, Ticket(consumer, 0.0, asked, asked)
            now = self.clock()
            if policy.get("rpm"):
                window = self._requests.setdefault(consumer, deque())
                while window and now - window[0] >= 60:
                    window.popleft()
                if len(window) >= policy["rpm"]:
                    raise self._block(consumer, 429, "rate_limited",
                                      f"more than {policy['rpm']} requests a minute; wait and try again.", asked)
                window.append(now)
            allowed = policy.get("allowed_models")
            if allowed and asked not in allowed:
                raise self._block(consumer, 403, "model_not_allowed",
                                  f"{asked} is not allowed here. Allowed: {', '.join(allowed)}.", asked)
            effort = effort_of(params)
            if effort and policy.get("max_effort") and effort in EFFORTS and \
                    EFFORTS.index(effort) > EFFORTS.index(policy["max_effort"]):
                raise self._block(consumer, 403, "effort_not_allowed",
                                  f"effort {effort} is above this consumer's limit of {policy['max_effort']}.", asked)
            if policy.get("refuse_secrets") and (kind := find_secret(params)):
                raise self._block(consumer, 403, "secret_in_request",
                                  f"the request contains what looks like {kind}. Remove it and send again.", asked)
            used = policy.get("route_to") or asked
            today, month = self.spent(consumer, now)
            pending = self._reserved.get(consumer, 0.0)
            if policy.get("downgrade_at"):
                shares = [(today + pending) / policy["daily_usd"] if policy.get("daily_usd") else 0.0,
                          (month + pending) / policy["monthly_usd"] if policy.get("monthly_usd") else 0.0]
                if max(shares) >= policy["downgrade_at"]:
                    used = policy["downgrade_to"]
            estimate = estimate_cost(params, used)
            for limit, spent, label in ((policy.get("daily_usd"), today, "daily"),
                                        (policy.get("monthly_usd"), month, "monthly")):
                if limit and spent + pending + estimate > limit:
                    raise self._block(consumer, 429, "budget_exceeded",
                                      f"the {label} budget of ${limit:.2f} is used up (spent ${spent:.4f}, "
                                      f"${pending:.4f} in progress, this call about ${estimate:.4f}).", used)
            self._reserved[consumer] = pending + estimate
            ticket = Ticket(consumer, estimate, asked, used)
        out = params if used == asked else {**params, "model": used}
        if policy.get("mask_pii"):
            out = mask_request(out)
        return out, ticket

    def blocked(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._blocked)[:limit]

    def ledger(self) -> tuple[dict[str, dict[str, float]], dict[str, dict[str, float]], dict[str, dict[str, int]]]:
        with self._lock:
            return copy.deepcopy(self._ledger), copy.deepcopy(self._savings), copy.deepcopy(self._calls)

    def projection(self, consumer: str) -> float:
        """This month's spending so far, carried on at the same daily rate to the month's end."""
        now = self.clock()
        d = datetime.fromtimestamp(now, tz=timezone.utc)
        _, month = self.spent(consumer, now)
        days_in = calendar.monthrange(d.year, d.month)[1]
        elapsed = d.day - 1 + (d.hour * 3600 + d.minute * 60 + d.second) / 86400
        return month / max(elapsed, 1.0) * days_in


# ---------- the client wrapper ----------

class _ControlledStream:
    """A stream's context manager, settled when it closes with whatever the reply had cost by then."""

    def __init__(self, manager: Any, control: ControlLayer, ticket: Ticket):
        self._manager, self._control, self._ticket = manager, control, ticket
        self._stream: Any = None

    def __enter__(self) -> Any:
        try:
            self._stream = self._manager.__enter__()
        except BaseException:
            self._control.settle(self._ticket, None)
            raise
        return self._stream

    def __exit__(self, kind: Any, exc: Any, trace: Any) -> Any:
        message = None
        try:
            message = getattr(self._stream, "current_message_snapshot", None)
            if message is None and exc is None and hasattr(self._stream, "get_final_message"):
                message = self._stream.get_final_message()
        except Exception:
            message = None
        try:
            return self._manager.__exit__(kind, exc, trace)
        finally:
            self._control.settle(self._ticket, message)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._manager, name)


class _ControlledMessages:
    def __init__(self, messages: Any, control: ControlLayer):
        self._messages, self._control = messages, control

    def create(self, **params: Any) -> Any:
        sent, ticket = self._control.admit(params)
        try:
            response = self._messages.create(**sent)
        except BaseException:
            self._control.settle(ticket, None)
            raise
        self._control.settle(ticket, response)
        return response

    def stream(self, **params: Any) -> Any:
        sent, ticket = self._control.admit(params)
        try:
            manager = self._messages.stream(**sent)
        except BaseException:
            self._control.settle(ticket, None)
            raise
        return _ControlledStream(manager, self._control, ticket)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._messages, name)


class _ControlledBeta:
    def __init__(self, beta: Any, control: ControlLayer):
        self._beta, self._control = beta, control

    @property
    def messages(self) -> _ControlledMessages:
        return _ControlledMessages(self._beta.messages, self._control)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._beta, name)


class ControlledClient:
    """The SDK client (or the lab client that also speaks to GPT and the local model) with every messages.create and
    messages.stream checked against the control layer. Everything else passes straight through."""

    def __init__(self, client: Any, control: ControlLayer):
        self._client, self._control = client, control

    @property
    def messages(self) -> _ControlledMessages:
        return _ControlledMessages(self._client.messages, self._control)

    @property
    def beta(self) -> _ControlledBeta:
        return _ControlledBeta(self._client.beta, self._control)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)
