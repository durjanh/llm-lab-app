"""The control layer: policies per consumer, the spending ledger, guardrails, virtual keys and the proxy. A fake
client stands in for the model, so nothing here costs anything or touches the network."""
from __future__ import annotations

import json
import os
import stat
import threading
from pathlib import Path
from typing import Any

import pytest
from anthropic.types import Message
from fastapi.testclient import TestClient

from backend.app.core.errors import ApiError
from backend.app.core.telemetry import use_area
from backend.app.main import create_app
from backend.app.services.control_layer import ControlLayer, ControlledClient, find_secret, mask_request
from backend.app.settings import MODELS, Settings

HAIKU, SONNET, OPUS = "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"
LAB = {"x-llm-lab": "1", "host": "localhost:8000"}
REAL_KEY = "sk-ant-api03-REAL-LAB-KEY-that-must-never-leave-the-server-000000"
DAY = 86400.0
T0 = 1_795_000_000.0  # a fixed moment, 2026-11-18 in UTC


class Clock:
    def __init__(self, at: float = T0):
        self.at = at

    def __call__(self) -> float:
        return self.at


def message(model: str = HAIKU, text: str = "Hello.", input_tokens: int = 1000, output_tokens: int = 100) -> Message:
    return Message.model_validate({
        "id": "msg_test", "type": "message", "role": "assistant", "model": model,
        "content": [{"type": "text", "text": text}], "stop_reason": "end_turn", "stop_sequence": None,
        "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens}})


class FakeStream:
    def __init__(self, final: Message):
        self.final = final
        self.current_message_snapshot = None

    def __enter__(self) -> "FakeStream":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def __iter__(self):
        yield {"type": "message_start", "message": {"id": "msg_test", "type": "message", "role": "assistant",
                                                    "model": self.final.model, "content": [], "usage": {
                                                        "input_tokens": 1000, "output_tokens": 0}}}
        yield {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}
        yield {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello."}}
        yield {"type": "text", "text": "Hello.", "snapshot": "Hello."}  # the SDK helper's own event: not sent on
        yield {"type": "content_block_stop", "index": 0}
        yield {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 100}}
        yield {"type": "message_stop"}

    def get_final_message(self) -> Message:
        return self.final


class FakeMessages:
    def __init__(self, owner: "FakeClient"):
        self.owner = owner

    def create(self, **p: Any) -> Message:
        self.owner.requests.append(json.loads(json.dumps(p, default=str)))
        return message(p["model"])

    def stream(self, **p: Any) -> FakeStream:
        self.owner.requests.append(json.loads(json.dumps(p, default=str)))
        return FakeStream(message(p["model"]))

    def count_tokens(self, **p: Any) -> Any:
        return type("Count", (), {"input_tokens": 42})()


class FakeClient:
    api_key = REAL_KEY  # as the real SDK client holds it: it must never reach a response

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.messages = FakeMessages(self)
        self.beta = type("Beta", (), {"messages": FakeMessages(self)})()
        self.models = type("Models", (), {"retrieve": lambda _s, model: {"id": model}})()


def control(tmp_path: Path, clock: Clock | None = None) -> ControlLayer:
    return ControlLayer(tmp_path / "control-layer", lambda: list(MODELS), clock or Clock())


def ask(model: str = HAIKU, text: str = "Hi", effort: str | None = None, max_tokens: int = 1000) -> dict[str, Any]:
    p: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "messages": [{"role": "user", "content": text}]}
    if effort:
        p["output_config"] = {"effort": effort}
    return p


# ---------- policies ----------

def test_a_consumer_without_a_policy_is_not_touched(tmp_path: Path) -> None:
    c = control(tmp_path)
    c.set_policy("tutor", {"allowed_models": [HAIKU]})
    params = ask(OPUS)
    sent, ticket = c.admit(params, "assistant")
    assert sent is params and ticket.reserved == 0
    c.settle(ticket, message(OPUS))
    assert c.spent("assistant")[0] > 0  # still counted, so the page can show it


def test_models_and_effort_outside_the_policy_are_refused_with_403(tmp_path: Path) -> None:
    c = control(tmp_path)
    c.set_policy("tutor", {"allowed_models": [HAIKU, SONNET], "max_effort": "medium"})
    with pytest.raises(ApiError) as e:
        c.admit(ask(OPUS), "tutor")
    assert e.value.status == 403 and OPUS in e.value.message
    with pytest.raises(ApiError) as e:
        c.admit(ask(SONNET, effort="high"), "tutor")
    assert e.value.status == 403 and "effort high" in e.value.message
    sent, _ = c.admit(ask(SONNET, effort="low"), "tutor")
    assert sent["model"] == SONNET
    assert [b["status"] for b in c.blocked()] == [403, 403]


def test_requests_per_minute(tmp_path: Path) -> None:
    clock = Clock()
    c = control(tmp_path, clock)
    c.set_policy("tutor", {"rpm": 2})
    for _ in range(2):
        c.settle(c.admit(ask(), "tutor")[1], None)
    with pytest.raises(ApiError) as e:
        c.admit(ask(), "tutor")
    assert e.value.status == 429 and "a minute" in e.value.message
    clock.at += 61
    c.admit(ask(), "tutor")


def test_daily_and_monthly_budgets_block_then_roll_over(tmp_path: Path) -> None:
    clock = Clock()
    c = control(tmp_path, clock)
    c.set_policy("coding", {"daily_usd": 0.03})
    c.settle(c.admit(ask(OPUS), "coding")[1], message(OPUS, input_tokens=3000, output_tokens=600))
    with pytest.raises(ApiError) as e:
        c.admit(ask(OPUS), "coding")
    assert e.value.status == 429 and "daily budget" in e.value.message
    clock.at += DAY  # a new day: the daily budget is fresh
    c.admit(ask(OPUS), "coding")
    c2 = control(tmp_path / "m", clock)
    c2.set_policy("coding", {"monthly_usd": 0.03})
    c2.settle(c2.admit(ask(OPUS), "coding")[1], message(OPUS, input_tokens=3000, output_tokens=600))
    with pytest.raises(ApiError):
        c2.admit(ask(OPUS), "coding")
    clock.at += 31 * DAY  # next month
    c2.admit(ask(OPUS), "coding")


def test_two_calls_at_once_cannot_both_pass_a_budget_with_room_for_one(tmp_path: Path) -> None:
    c = control(tmp_path)
    one = ask(OPUS, max_tokens=1000)
    from backend.app.services.control_layer import estimate_cost
    c.set_policy("coding", {"daily_usd": round(estimate_cost(one, OPUS) * 1.5, 6)})
    results: list[str] = []
    gate = threading.Barrier(2)

    def go() -> None:
        gate.wait()
        try:
            c.admit(dict(one), "coding")
            results.append("in")
        except ApiError as exc:
            results.append(str(exc.status))

    threads = [threading.Thread(target=go) for _ in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == ["429", "in"]


def test_routing_sends_calls_to_another_model_and_records_the_saving(tmp_path: Path) -> None:
    c = control(tmp_path)
    c.set_policy("tutor", {"route_to": HAIKU})
    sent, ticket = c.admit(ask(OPUS), "tutor")
    assert sent["model"] == HAIKU
    c.settle(ticket, message(HAIKU))
    _, savings, _ = c.ledger()
    assert sum(savings["tutor"].values()) > 0


def test_downgrade_after_a_share_of_the_budget(tmp_path: Path) -> None:
    c = control(tmp_path)
    c.set_policy("assistant", {"daily_usd": 1.0, "downgrade_at": 0.5, "downgrade_to": HAIKU})
    sent, t = c.admit(ask(SONNET), "assistant")
    assert sent["model"] == SONNET
    c.settle(t, message(SONNET, input_tokens=200_000, output_tokens=20_000))  # $0.60 of $1.00
    sent, _ = c.admit(ask(SONNET), "assistant")
    assert sent["model"] == HAIKU


def test_policy_checks(tmp_path: Path) -> None:
    c = control(tmp_path)
    for bad, why in [({"colour": "red"}, "Unknown"), ({"allowed_models": ["gpt-9"]}, "Not one of"),
                     ({"max_effort": "huge"}, "Max effort"), ({"daily_usd": -1}, "above 0"),
                     ({"downgrade_at": 0.5}, "needs both"),
                     ({"downgrade_at": 0.5, "downgrade_to": HAIKU}, "budget to measure"),
                     ({"allowed_models": [SONNET], "route_to": HAIKU}, "not in this policy")]:
        with pytest.raises(ApiError) as e:
            c.set_policy("tutor", bad)
        assert e.value.status == 400 and why in e.value.message, bad
    with pytest.raises(ApiError):
        c.set_policy("Not A Name", {})


# ---------- guardrails ----------

@pytest.mark.parametrize("secret", [
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", "AKIAABCDEFGHIJKLMNOP", "ghp_" + "a1" * 18,
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...", "DefaultEndpointsProtocol=https;AccountKey=" + "A" * 60])
def test_obvious_secrets_are_refused(tmp_path: Path, secret: str) -> None:
    c = control(tmp_path)
    c.set_policy("coding", {"refuse_secrets": True})
    with pytest.raises(ApiError) as e:
        c.admit(ask(text=f"here is my config: {secret}"), "coding")
    assert e.value.status == 403 and secret not in e.value.message


def test_secrets_in_tool_results_count_and_plain_text_does_not() -> None:
    params = {"messages": [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t",
                                                         "content": [{"type": "text", "text": "AKIAABCDEFGHIJKLMNOP"}]}]}]}
    assert find_secret(params) == "an AWS access key"
    assert find_secret(ask(text="the sky key is blue; skip-ant-thing")) is None


def test_masking_emails_and_phones_in_what_people_send_only(tmp_path: Path) -> None:
    params = {"system": "Write to help@lab.example", "messages": [
        {"role": "user", "content": "I am jo@example.com, call 07700 900123 or +44 20 7946 0958."},
        {"role": "assistant", "content": "Noted jo@example.com"},
        {"role": "user", "content": [{"type": "text", "text": "Also ann@example.org"}]}]}
    out = mask_request(params)
    assert out["messages"][0]["content"] == "I am [email], call [phone] or [phone]."
    assert out["messages"][1]["content"] == "Noted jo@example.com"  # the model's own words are left
    assert out["messages"][2]["content"][0]["text"] == "Also [email]"
    assert out["system"] == params["system"] and params["messages"][0]["content"].startswith("I am jo@")
    c = control(tmp_path)
    c.set_policy("tutor", {"mask_pii": True})
    sent, _ = c.admit(params, "tutor")
    assert "jo@example.com" not in json.dumps(sent["messages"][0])


# ---------- audit and keys ----------

def test_every_change_is_audited_and_keys_are_kept_only_as_hashes(tmp_path: Path) -> None:
    c = control(tmp_path)
    c.set_policy("tutor", {"allowed_models": [HAIKU]})
    c.set_policy("tutor", {"allowed_models": [HAIKU, SONNET]})
    made = c.create_key("Laptop agent")
    key = made["key"]
    assert key.startswith("llmlab-") and made["prefix"] == key[:13]
    c.revoke_key(made["id"])
    c.remove_policy("tutor")
    actions = [a["action"] for a in c.audit()]
    assert actions == ["policy removed", "key revoked", "key created", "policy changed", "policy set"]
    assert all(a["who"] == "this machine" for a in c.audit())
    stored = (tmp_path / "control-layer" / "keys.json").read_text()
    assert key not in stored and c._hash(key) in stored
    assert stat.S_IMODE(os.stat(tmp_path / "control-layer" / "keys.json").st_mode) == 0o600
    assert key not in (tmp_path / "control-layer" / "audit.jsonl").read_text()
    assert all("hash" not in k and "key" not in k for k in c.keys())


def test_authentication_accepts_only_an_active_key(tmp_path: Path) -> None:
    c = control(tmp_path)
    key = c.create_key("CI")
    assert c.authenticate(key["key"])["id"] == key["id"]
    assert c.authenticate(key["key"] + "x") is None and c.authenticate(None) is None
    assert c.authenticate("llmlab-not-a-real-key") is None
    c.revoke_key(key["id"])
    assert c.authenticate(key["key"]) is None


# ---------- the client wrapper ----------

def test_the_wrapper_applies_the_area_policy_and_settles_streams(tmp_path: Path) -> None:
    c = control(tmp_path)
    c.set_policy("tutor", {"allowed_models": [HAIKU]})
    fake = FakeClient()
    client = ControlledClient(fake, c)
    with use_area("tutor"):
        with pytest.raises(ApiError):
            client.messages.create(**ask(OPUS))
        with client.beta.messages.stream(**ask(HAIKU)) as s:
            list(s)
    with use_area("diet"):  # no policy: passes as asked
        client.messages.create(**ask(OPUS))
    assert [r["model"] for r in fake.requests] == [HAIKU, OPUS]
    assert c.spent("tutor")[0] > 0 and c.spent("diet")[0] > 0
    assert c._reserved.get("tutor", 0) == 0


# ---------- the page and the proxy ----------

def lab(tmp_path: Path, budget: float = 5.0) -> tuple[TestClient, Any, FakeClient]:
    settings = Settings(port=8000, budget_usd=budget, frontend_dist=tmp_path, models_dir=tmp_path / "none",
                        sites_dir=tmp_path / "sites", casework_dir=tmp_path / "casework",
                        generated_dir=tmp_path / "generated")
    fake = FakeClient()
    app = create_app(settings, client=fake)
    return TestClient(app, base_url="http://localhost:8000"), app.state.container, fake


def new_key(client: TestClient, name: str = "Coding agent") -> dict[str, Any]:
    r = client.post("/api/control-layer/keys", headers=LAB, json={"name": name})
    assert r.status_code == 200, r.text
    return r.json()


def test_the_page_routes_need_the_lab_header_and_never_show_a_key(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path)
    assert client.get("/api/control-layer", headers={"host": "localhost:8000"}).status_code == 403
    made = new_key(client)
    overview = client.get("/api/control-layer", headers=LAB)
    assert overview.status_code == 200
    text = overview.text
    assert made["key"] not in text and '"hash"' not in text and REAL_KEY not in text
    r = client.put("/api/control-layer/policies/tutor", headers=LAB, json={"allowed_models": ["nope"]})
    assert r.status_code == 400
    r = client.put("/api/control-layer/policies/tutor", headers=LAB, json={"max_effort": "low", "rpm": 5})
    assert r.status_code == 200 and r.json()["max_effort"] == "low"
    body = client.get("/api/control-layer", headers=LAB).json()
    assert any(row["id"] == "tutor" and row["policy"]["rpm"] == 5 for row in body["consumers"])
    assert body["audit"][0]["action"] == "policy set"


def test_the_proxy_refuses_missing_wrong_and_revoked_keys_and_other_hosts(tmp_path: Path) -> None:
    client, c, _ = lab(tmp_path)
    body = ask()
    assert client.post("/control/v1/messages", json=body).status_code == 401
    r = client.post("/control/v1/messages", json=body, headers=LAB)  # the lab header alone is not enough
    assert r.status_code == 401 and r.json()["error"]["type"] == "authentication_error"
    assert client.post("/control/v1/messages", json=body, headers={"x-api-key": "llmlab-wrong"}).status_code == 401
    made = new_key(client)
    ok = client.post("/control/v1/messages", json=body, headers={"x-api-key": made["key"]})
    assert ok.status_code == 200
    r = client.post("/control/v1/messages", json=body,
                    headers={"authorization": f"Bearer {made['key']}", "host": "evil.example"})
    assert r.status_code == 403
    client.delete(f"/api/control-layer/keys/{made['id']}", headers=LAB)
    assert client.post("/control/v1/messages", json=body, headers={"x-api-key": made["key"]}).status_code == 401


def test_a_proxied_call_is_charged_and_logged_under_its_key(tmp_path: Path) -> None:
    client, c, fake = lab(tmp_path)
    made = new_key(client)
    r = client.post("/control/v1/messages", json=ask(), headers={"authorization": f"Bearer {made['key']}"})
    assert r.status_code == 200
    reply = r.json()
    assert reply["content"][0]["text"] == "Hello." and REAL_KEY not in r.text
    consumer = f"key:{made['id']}"
    assert c.spend.calls == 1
    assert c.spend.call_log.calls()[-1]["area"] == consumer
    assert c.control.spent(consumer)[0] > 0
    assert made["key"] not in json.dumps(fake.requests)  # the client's key is never passed upstream
    row = next(r for r in client.get("/api/control-layer", headers=LAB).json()["consumers"] if r["id"] == consumer)
    assert row["label"] == "Coding agent" and row["kind"] == "key"


def test_the_proxy_streams_the_wire_events_only(tmp_path: Path) -> None:
    client, c, _ = lab(tmp_path)
    made = new_key(client)
    r = client.post("/control/v1/messages", json={**ask(), "stream": True}, headers={"x-api-key": made["key"]})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    events = [line[len("event: "):] for line in r.text.splitlines() if line.startswith("event: ")]
    assert events == ["message_start", "content_block_start", "content_block_delta", "content_block_stop",
                      "message_delta", "message_stop"]
    data = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: ")]
    assert data[2]["delta"]["text"] == "Hello."
    assert c.spend.calls == 1 and REAL_KEY not in r.text


def test_a_keys_own_policy_applies_to_its_calls(tmp_path: Path) -> None:
    client, c, _ = lab(tmp_path)
    made = new_key(client)
    r = client.put(f"/api/control-layer/policies/key:{made['id']}", headers=LAB, json={"allowed_models": [HAIKU]})
    assert r.status_code == 200
    r = client.post("/control/v1/messages", json=ask(SONNET), headers={"x-api-key": made["key"]})
    assert r.status_code == 403 and r.json()["error"]["type"] == "permission_error"
    r = client.post("/control/v1/messages", json={**ask(SONNET), "stream": True}, headers={"x-api-key": made["key"]})
    assert r.status_code == 403  # refused before the stream begins, as a normal HTTP error
    assert client.post("/control/v1/messages", json=ask(HAIKU), headers={"x-api-key": made["key"]}).status_code == 200


def test_the_proxy_checks_the_request(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path)
    key = {"x-api-key": new_key(client)["key"]}
    for body, status in [({**ask(), "model": "gpt-9"}, 400), ({**ask(), "max_tokens": 0}, 400),
                         ({"model": HAIKU, "max_tokens": 10, "messages": []}, 400), ({**ask(), "betas": ["x"]}, 400)]:
        assert client.post("/control/v1/messages", json=body, headers=key).status_code == status, body
    assert client.post("/control/v1/messages/count_tokens", json=ask(), headers=key).json() == {"input_tokens": 42}
    models = client.get("/control/v1/models", headers=key).json()
    assert HAIKU in [m["id"] for m in models["data"]]


def test_the_proxy_respects_the_labs_spending_cap(tmp_path: Path) -> None:
    client, c, _ = lab(tmp_path, budget=0.0)
    key = {"x-api-key": new_key(client)["key"]}
    r = client.post("/control/v1/messages", json=ask(), headers=key)
    assert r.status_code == 429 and r.json()["error"]["type"] == "rate_limit_error"
