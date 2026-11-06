"""The local model's routing (python/local_model.py), with fakes in place of both servers: no Docker, no key, no cost."""
from __future__ import annotations

from contextlib import contextmanager

import pytest

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
    assert body["extra_body"] == {"chat_template_kwargs": {"enable_thinking": False}}
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
    with pytest.raises(L.LocalUnsupported, match=what):
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
    assert to_api_error(L.LocalUnsupported("needs Claude")).status == 400
    assert to_api_error(L.LocalUnavailable("not answering")).status == 503
