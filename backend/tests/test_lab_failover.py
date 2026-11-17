"""Failover on every page: the gateway every service uses switches model on 429, 529, 5xx or a timeout, across the
failover catalog, with breakers shared by the whole lab."""
from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace
from typing import Any

import anthropic
import httpx
import pytest

from backend.app.services.lab_failover import FailoverGateway
from backend.app.services.model_router import AllPoolsFailed, ModelRouter, Pool
from backend.app.shared import NeedsClaude
from local_model import _NO_FALLBACK

SONNET, HAIKU, GPT, LOCAL = "claude-sonnet-5-5", "claude-haiku-5-5", "gpt-5.4-mini", "ai/local-model"


def error(code: int) -> anthropic.APIStatusError:
    return anthropic.APIStatusError(f"error {code}", response=httpx.Response(
        code, request=httpx.Request("POST", "http://test/v1/messages")), body=None)


class Inner:
    """Stands in for the gateway underneath: each model answers, or raises what `fail` says, and every call notes
    whether the client's own one-step fallback was switched off."""

    def __init__(self, fail: dict[str, BaseException] | None = None) -> None:
        self.fail, self.calls, self.fallback_off = fail or {}, [], []
        self.client = "the SDK client"

    def create(self, **params: Any) -> Any:
        self.calls.append(params["model"])
        self.fallback_off.append(_NO_FALLBACK.get())
        if params["model"] in self.fail:
            raise self.fail[params["model"]]
        return SimpleNamespace(model=params["model"], text="hello")

    @contextmanager
    def stream(self, **params: Any):
        self.calls.append(params["model"])
        if params["model"] in self.fail:
            raise self.fail[params["model"]]
        yield SimpleNamespace(model=params["model"])


def gateway(fail: dict[str, BaseException] | None = None, enabled: bool = True) -> tuple[FailoverGateway, Inner]:
    pools = [Pool(SONNET, SONNET, "anthropic"), Pool(HAIKU, HAIKU, "anthropic"), Pool(GPT, GPT, "azure-openai")]
    inner = Inner(fail)
    router = ModelRouter(pools, cooldown_s=30, sleep=lambda s: None)
    return FailoverGateway(inner, router, enabled=enabled), inner


def test_a_failing_model_hands_the_call_to_the_next_and_its_breaker_is_shared() -> None:
    gw, inner = gateway({SONNET: error(529)})
    assert gw.create(model=SONNET, max_tokens=10, messages=[]).model == HAIKU
    assert inner.calls == [SONNET, HAIKU] and all(inner.fallback_off)  # the client never switches it a second time
    [switch] = gw.report()["switches"]
    assert (switch["from"], switch["to"]) == (SONNET, HAIKU) and switch["asked"] == SONNET
    inner.calls.clear()
    gw.create(model=SONNET, max_tokens=10, messages=[])  # any page, later: the open breaker skips it
    assert inner.calls == [HAIKU]


def test_a_model_outside_the_catalog_is_called_as_it_was() -> None:
    """The local model is not in the catalog: without this it would be sent to the catalog's first model."""
    gw, inner = gateway({LOCAL: error(529)})
    with pytest.raises(anthropic.APIStatusError):
        gw.create(model=LOCAL, max_tokens=10, messages=[])
    assert inner.calls == [LOCAL] and gw.report()["switches"] == []


def test_a_model_that_cannot_do_the_request_is_passed_over_not_marked_down() -> None:
    gw, inner = gateway({GPT: NeedsClaude("needs web search")})
    gw.router.inject(SONNET, "529", 1)
    gw.router.inject(HAIKU, "529", 1)
    with pytest.raises(AllPoolsFailed):  # both Claude models down, GPT cannot do it: that is the honest answer
        gw.create(model=SONNET, max_tokens=10, messages=[])
    state = {p["name"]: p["state"] for p in gw.router.status()["pools"]}
    assert state[GPT] == "closed"  # healthy: not opened for being unable
    unable = NeedsClaude("needs web search")
    none_can, _ = gateway({SONNET: unable, HAIKU: unable, GPT: unable})
    with pytest.raises(NeedsClaude):  # nothing failed: no model could do it, which is the clearer error
        none_can.create(model=SONNET, max_tokens=10, messages=[])


def test_a_stream_fails_over_only_before_it_starts() -> None:
    gw, inner = gateway({SONNET: error(429)})
    with gw.stream(model=SONNET, max_tokens=10, messages=[]) as s:
        assert s.model == HAIKU
    assert inner.calls == [SONNET, HAIKU]


def test_off_means_every_call_goes_only_to_the_model_asked_for() -> None:
    gw, inner = gateway({SONNET: error(529)}, enabled=False)
    with pytest.raises(anthropic.APIStatusError):
        gw.create(model=SONNET, max_tokens=10, messages=[])
    assert inner.calls == [SONNET] and gw.report() == {"enabled": False, "models": [], "routed_calls": 0, "switches": []}


def test_everything_else_passes_through_to_the_gateway_underneath() -> None:
    gw, _ = gateway()
    assert gw.client == "the SDK client"


def test_the_failover_page_gets_the_direct_gateway_and_every_other_page_the_failover_one(tmp_path) -> None:
    from backend.app.main import create_app
    from backend.app.settings import Settings
    from backend.tests.test_api import FakeClient

    settings = Settings(port=8000, budget_usd=1.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    c = create_app(settings, client=FakeClient()).state.container
    assert isinstance(c.failover, FailoverGateway) and c.diet.claude is c.failover
    assert c.model_failover.claude is c.failover.inner and c.model_failover.router is c.failover.router


def test_a_page_reports_the_model_that_answered_not_the_one_asked_for(tmp_path) -> None:
    """Found on a real run: Haiku was asked, hit a 529, Sonnet answered, and the songbird page said Haiku wrote it."""
    import json

    from fastapi.testclient import TestClient

    from backend.app.main import create_app
    from backend.app.settings import Settings
    from backend.tests.test_aftercare import ScriptedClient, text
    from backend.tests.test_api import LAB
    from backend.tests.test_songbird import GOOD

    settings = Settings(port=8000, budget_usd=1.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    app = create_app(settings, client=ScriptedClient([[text(json.dumps(GOOD))]]))
    app.state.container.failover.router.inject(SONNET, "529", 1)
    r = TestClient(app, base_url="http://localhost:8000").post(
        "/api/songbird/compose", headers=LAB, json={"description": "a duet", "model": SONNET})
    assert r.status_code == 200 and r.json()["model"] == HAIKU


# ----- review findings -----

def test_when_every_listed_model_fails_the_clients_own_fallback_is_still_tried(monkeypatch) -> None:
    """Before failover went lab-wide, a 429 went once to fallback_model(). The router alone dropped that."""
    from backend.app.services import lab_failover

    gw, inner = gateway({SONNET: error(529), HAIKU: error(529), GPT: error(529)})
    monkeypatch.setattr(lab_failover, "fallback_model", lambda model: "claude-opus-5-5")
    assert gw.create(model=SONNET, max_tokens=10, messages=[]).model == "claude-opus-5-5"
    assert inner.calls[-1] == "claude-opus-5-5" and gw.report()["switches"][0]["to"] == "claude-opus-5-5"
    monkeypatch.setattr(lab_failover, "fallback_model", lambda model: HAIKU)  # in the list, already tried: no rerun
    gw2, _ = gateway({SONNET: error(529), HAIKU: error(529), GPT: error(529)})
    with pytest.raises(AllPoolsFailed):
        gw2.create(model=SONNET, max_tokens=10, messages=[])


def test_a_history_too_long_everywhere_is_said_ahead_of_needs_claude() -> None:
    from backend.app.core.errors import ApiError

    too_long = ApiError(413, "context_too_long", "The history is too long.")
    gw, _ = gateway({SONNET: too_long, HAIKU: too_long, GPT: NeedsClaude("needs web search")})
    with pytest.raises(ApiError) as e:
        gw.create(model=SONNET, max_tokens=10, messages=[])
    assert e.value.kind == "context_too_long"


def test_the_switch_setting_reports_a_typo_instead_of_staying_on(capsys) -> None:
    from backend.app.shared import EnvSettings

    assert EnvSettings.from_env({"LLM_LAB_FAILOVER": "disabled"}).failover is False
    assert EnvSettings.from_env({"LLM_LAB_FAILOVER": "Off"}).failover is False
    assert EnvSettings.from_env({"LLM_LAB_FAILOVER": "maybe"}).failover is True
    assert "LLM_LAB_FAILOVER='maybe' is not on or off" in capsys.readouterr().err


def test_the_wrapper_can_be_copied_without_endless_lookups() -> None:
    import copy

    gw, _ = gateway()
    assert copy.copy(gw).inner is gw.inner
