"""The local model's routing (python/local_model.py), with fakes in place of both servers: no Docker, no key, no cost."""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace

import pytest

from backend.app import shared  # noqa: F401  (puts python/ on sys.path)

import local_model as L
from backend.app.core.errors import to_api_error

MODEL = "ai/qwen3.5:9b-q4_K_XL"


@pytest.fixture(autouse=True)
def local(monkeypatch):
    monkeypatch.setattr(L, "LOCAL_MODEL", MODEL)


class Recorder:
    """Stands in for client.messages on either side, and records what it was sent."""

    def __init__(self):
        self.calls = []

    def create(self, **params):
        self.calls.append(("create", params))
        return "reply"

    @contextmanager
    def stream(self, **params):
        self.calls.append(("stream", params))
        yield "stream"

    def count_tokens(self, **params):
        self.calls.append(("count_tokens", params))
        return "count"


class FakeRemote:
    def __init__(self):
        self.messages, self.beta = Recorder(), type("Beta", (), {"messages": Recorder()})()
        self.files = "anthropic files"


class FakeLocal(L.LocalModel):
    """The real request preparation, with a recorder where the local server would be."""

    def __init__(self):
        self.url, self.openai_url = "http://local", "http://local/v1"
        self.client = type("C", (), {"messages": Recorder()})()


def ask(**extra):
    return {"model": MODEL, "max_tokens": 100, "messages": [{"role": "user", "content": "hi"}], **extra}


def test_local_model_requests_go_to_the_local_server_and_the_rest_to_anthropic():
    remote, local = FakeRemote(), FakeLocal()
    client = L.LabClient(remote, local)
    client.messages.create(**ask())
    client.messages.create(**ask(model="claude-haiku-5-5"))
    with client.messages.stream(**ask()):
        pass
    client.beta.messages.create(**ask(model="claude-opus-5-5", betas=["x"]))
    assert [c[0] for c in local.client.messages.calls] == ["create", "stream"]
    assert [c[1]["model"] for c in remote.messages.calls] == ["claude-haiku-5-5"]
    assert remote.beta.messages.calls[0][1]["model"] == "claude-opus-5-5"
    assert client.files == "anthropic files"  # everything else is Anthropic's, as before


def test_thinking_is_off_unless_asked_for_and_anthropic_only_parameters_are_dropped():
    body, schema = L.prepare(ask(betas=["server-side-fallback-2026-07-01"], fallbacks="default",
                                 output_config={"effort": "low"}))
    assert body["extra_body"] == {"chat_template_kwargs": {"enable_thinking": False, "reasoning_effort": "low"}}
    assert "betas" not in body and "fallbacks" not in body and "output_config" not in body and schema is None
    body, _ = L.prepare(ask(thinking={"type": "adaptive"}))
    assert body["extra_body"]["chat_template_kwargs"]["enable_thinking"] is True and "thinking" not in body


def test_a_json_schema_is_taken_out_of_output_config():
    schema = {"type": "object", "properties": {"n": {"type": "integer"}}}
    _, found = L.prepare(ask(output_config={"format": {"type": "json_schema", "schema": schema}}))
    assert found == schema


def test_a_streamed_reply_that_must_be_json_asks_for_it_in_the_system_prompt():
    local = FakeLocal()
    schema = {"type": "object", "properties": {"n": {"type": "integer"}}}
    with local.stream(ask(system="Be brief.", output_config={"format": {"type": "json_schema", "schema": schema}})):
        pass
    system = local.client.messages.calls[0][1]["system"]
    assert system.startswith("Be brief.") and '"integer"' in system


@pytest.mark.parametrize("extra, what", [
    ({"tools": [{"type": "web_search_20260209", "name": "web_search"}]}, "web_search"),
    ({"container": "cntr_1"}, "code execution container"),
    ({"mcp_servers": [{"url": "https://x"}]}, "MCP"),
    ({"messages": [{"role": "user", "content": [{"type": "document", "source": {"type": "base64", "data": "x"}}]}]}, "PDF"),
    ({"messages": [{"role": "user", "content": [{"type": "image", "source": {"type": "file", "file_id": "f"}}]}]}, "Files API"),
])
def test_what_only_claude_can_do_is_refused_not_dropped(extra, what):
    with pytest.raises(L.NeedsClaude, match=what):
        L.prepare(ask(**extra))


def test_custom_tools_and_base64_images_are_allowed():
    tools = [{"name": "lookup", "description": "d", "input_schema": {"type": "object", "properties": {}}}]
    image = {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBOR"}}
    body, _ = L.prepare(ask(tools=tools, messages=[{"role": "user", "content": [image, {"type": "text", "text": "?"}]}]))
    assert body["tools"] == tools


def test_a_plain_conversation_converts_to_chat_form_and_one_with_tool_calls_does_not():
    chat = L._to_chat({"system": "S", "messages": [{"role": "user", "content": "hi"},
                                                   {"role": "assistant", "content": [{"type": "text", "text": "yo"}]}]})
    assert chat == [{"role": "system", "content": "S"}, {"role": "user", "content": "hi"},
                    {"role": "assistant", "content": [{"type": "text", "text": "yo"}]}]
    assert L._to_chat({"messages": [{"role": "assistant", "content": [{"type": "tool_use", "id": "1"}]}]}) is None


def test_the_page_sees_a_clear_status_for_each_failure():
    assert to_api_error(L.NeedsClaude("needs Claude")).status == 400
    assert to_api_error(L.ModelUnavailable("not answering")).status == 503


def limited(status=429):
    """The error the SDK raises once its own retries are used up."""
    exc = L.anthropic.RateLimitError.__new__(L.anthropic.RateLimitError)
    exc.status_code = status
    return exc


class Limited(Recorder):
    """Claude, rate limited."""

    def __init__(self, status=429):
        super().__init__()
        self.status = status

    def create(self, **params):
        self.calls.append(("create", params))
        raise limited(self.status)

    def stream(self, **params):
        self.calls.append(("stream", params))
        raise limited(self.status)


class Provider:
    """Stands in for the local model or GPT, which take the request as one dict."""

    def __init__(self):
        self.calls = []

    def create(self, params):
        self.calls.append(("create", params))
        return "reply"

    @contextmanager
    def stream(self, params):
        self.calls.append(("stream", params))
        yield "stream"


def fallback_client(monkeypatch, status=429, setting="auto"):
    monkeypatch.setattr(L, "ENV", replace(L.ENV, rate_limit_fallback=setting))
    monkeypatch.setattr(L, "GPT_MODELS", ["gpt-5.4-mini"])
    remote, gpt = FakeRemote(), Provider()
    remote.messages = Limited(status)
    return L.LabClient(remote, FakeLocal(), gpt=gpt), remote, gpt


@pytest.mark.parametrize("status", [429, 529])
def test_a_rate_limited_or_overloaded_claude_request_is_answered_by_gpt(monkeypatch, status):
    client, remote, gpt = fallback_client(monkeypatch, status)
    assert client.messages.create(**ask(model="claude-haiku-5-5")) == "reply"
    with client.messages.stream(**ask(model="claude-haiku-5-5")) as s:
        assert s == "stream"
    assert [c[1]["model"] for c in gpt.calls] == ["gpt-5.4-mini", "gpt-5.4-mini"]


def test_no_fallback_when_switched_off_or_the_error_is_not_a_rate_limit(monkeypatch):
    client, _, gpt = fallback_client(monkeypatch, setting="none")
    with pytest.raises(L.anthropic.RateLimitError):
        client.messages.create(**ask(model="claude-haiku-5-5"))
    assert not gpt.calls
    assert L.fallback_model("claude-haiku-5-5", "auto") == "gpt-5.4-mini"
    assert L.fallback_model("gpt-5.4-mini", "auto") == L.ENV.model
    assert L.fallback_model(MODEL, "auto") is None  # the local model is never rate limited


def test_a_request_only_claude_can_serve_reports_the_rate_limit_not_the_fallbacks_refusal(monkeypatch):
    client, _, _ = fallback_client(monkeypatch)
    client._local = client.messages._local = None  # route the fallback through a real GPT check

    class Refuses(Provider):
        def create(self, params):
            raise L.NeedsClaude("needs Claude")

    client.messages._gpt = Refuses()
    with pytest.raises(L.anthropic.RateLimitError):
        client.messages.create(**ask(model="claude-haiku-5-5"))


def test_a_model_that_cannot_read_images_says_so_clearly():
    exc = L.anthropic.APIStatusError.__new__(L.anthropic.APIStatusError)
    Exception.__init__(exc, "Error code: 500 - image input is not supported - hint: provide the mmproj")
    exc.status_code = 500

    class Refuses:
        def create(self, **params):
            raise exc

    local = FakeLocal()
    local.client = type("C", (), {"messages": Refuses()})()
    with pytest.raises(L.NoVision, match="cannot read images"):
        local.create(ask())
    assert to_api_error(L.NoVision("x")).status == 400
