"""GPT through the lab's client (python/gpt_model.py), with a fake in place of Azure OpenAI: no Azure, no cost."""
from __future__ import annotations

from types import SimpleNamespace as NS

import openai
import pytest

from backend.app import shared  # noqa: F401  (puts python/ on sys.path)

import gpt_model as G
import local_model as L
from backend.app.core.errors import to_api_error

MODEL = "gpt-5.4-mini"


def ask(**extra):
    return {"model": MODEL, "max_tokens": 100, "messages": [{"role": "user", "content": "hi"}], **extra}


def usage(prompt=10, completion=5, cached=0):
    return NS(prompt_tokens=prompt, completion_tokens=completion, prompt_tokens_details=NS(cached_tokens=cached))


class FakeOpenAI:
    """Records each request and answers with the reply, or the chunks, it was given."""

    def __init__(self, reply=None, chunks=None, error=None):
        self.requests, self.reply, self.chunks, self.error = [], reply, chunks, error
        self.chat = NS(completions=NS(create=self.create))

    def create(self, **body):
        self.requests.append(body)
        if self.error:
            raise self.error
        return iter(self.chunks) if body.get("stream") else self.reply


def gpt(**fake) -> tuple[G.GptModel, FakeOpenAI]:
    client = FakeOpenAI(**fake)
    return G.GptModel("https://example.openai.azure.com/", client=client), client


def chunk(content=None, calls=None, finish=None):
    return NS(usage=None, choices=[NS(delta=NS(content=content, refusal=None, tool_calls=calls), finish_reason=finish)])


def call(index, piece, id=None, name=None):
    return NS(index=index, id=id, function=NS(name=name, arguments=piece))


def test_a_conversation_with_tools_images_and_tool_results_becomes_chat_completions():
    image = {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBOR"}}
    messages = [
        {"role": "user", "content": [image, {"type": "text", "text": "Make the page."}]},
        {"role": "assistant", "content": [{"type": "thinking", "thinking": "…", "signature": "s"},
                                          {"type": "text", "text": "Writing it."},
                                          {"type": "tool_use", "id": "t1", "name": "write_file", "input": {"path": "a"}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": [
            {"type": "text", "text": "Saved."}, image]}, {"type": "text", "text": "Now check it."}]},
    ]
    tools = [{"name": "write_file", "description": "Write a file.", "strict": True, "cache_control": {"type": "ephemeral"},
              "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"],
                               "additionalProperties": False}}]
    body = G.to_request(ask(system=[{"type": "text", "text": "You build sites."}], messages=messages, tools=tools,
                            tool_choice={"type": "any"}, temperature=0.2, cache_control={"type": "ephemeral"}))
    chat = body["messages"]
    assert chat[0] == {"role": "system", "content": "You build sites."}
    assert chat[1]["content"][0]["image_url"]["url"].startswith("data:image/png;base64,")
    assert chat[2]["tool_calls"][0]["function"] == {"name": "write_file", "arguments": '{"path": "a"}'}
    assert chat[2]["content"] == "Writing it."  # thinking is Claude's own and is left out
    assert chat[3] == {"role": "tool", "tool_call_id": "t1", "content": "Saved."}
    assert chat[4]["content"][1]["type"] == "image_url" and chat[4]["content"][-1]["text"] == "Now check it."
    assert body["tools"][0]["function"]["strict"] is True and body["tool_choice"] == "required"
    assert "temperature" not in body and "cache_control" not in body  # reasoning models refuse temperature


def test_effort_sets_reasoning_and_max_tokens_leaves_room_for_it():
    assert G.to_request(ask())["reasoning_effort"] == "low"
    body = G.to_request(ask(output_config={"effort": "high"}))
    assert body["reasoning_effort"] == "high" and body["max_completion_tokens"] > 100
    assert G.to_request(ask(thinking={"type": "adaptive"}))["reasoning_effort"] == "medium"


def test_a_json_schema_becomes_a_response_format_strict_only_when_openai_allows_it():
    closed = {"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"], "additionalProperties": False}
    open_ = {"type": "object", "properties": {"n": {"type": "integer"}}}
    fmt = lambda s: G.to_request(ask(output_config={"format": {"type": "json_schema", "schema": s}}))["response_format"]
    assert fmt(closed)["json_schema"]["strict"] is True
    assert fmt(open_)["json_schema"]["strict"] is False


def test_a_reply_comes_back_as_an_anthropic_message_with_tool_calls_and_cached_tokens():
    reply = NS(choices=[NS(finish_reason="tool_calls", message=NS(content="On it.", refusal=None, tool_calls=[
        NS(id="c1", function=NS(name="lookup", arguments='{"q": "x"}'))]))], usage=usage(100, 20, cached=40))
    model, client = gpt(reply=reply)
    m = L.LabClient(remote=NS(messages=None, beta=NS(messages=None)), gpt=model).messages.create(**ask())
    assert client.requests[0]["model"] == MODEL
    assert [b.type for b in m.content] == ["text", "tool_use"] and m.content[1].input == {"q": "x"}
    assert m.stop_reason == "tool_use" and m.usage.input_tokens == 60 and m.usage.cache_read_input_tokens == 40


def test_a_stream_gives_claudes_events_text_then_a_tool_calls_input_as_it_is_written():
    chunks = [chunk(content="Here "), chunk(content="it is."),
              chunk(calls=[call(0, "", id="c1", name="write_file")]), chunk(calls=[call(0, '{"path": "index')]),
              chunk(calls=[call(0, '.html"}')], finish="tool_calls"), NS(usage=usage(), choices=[])]
    model, _ = gpt(chunks=chunks)
    with model.stream(ask(tools=[{"name": "write_file", "description": "", "input_schema": {"type": "object"}}])) as s:
        events = list(s)
        final = s.get_final_message()
    kinds = [(e.type, getattr(getattr(e, "delta", None), "type", None) or getattr(getattr(e, "content_block", None), "type", None))
             for e in events if e.type.startswith("content_block")]
    assert kinds == [("content_block_start", "text"), ("content_block_delta", "text_delta"),
                     ("content_block_delta", "text_delta"), ("content_block_stop", None),
                     ("content_block_start", "tool_use"), ("content_block_delta", "input_json_delta"),
                     ("content_block_delta", "input_json_delta"), ("content_block_stop", None)]
    assert final.content[0].text == "Here it is." and final.content[1].input == {"path": "index.html"}
    assert final.stop_reason == "tool_use" and final.usage.output_tokens == 5


def test_text_stream_and_get_final_message_work_as_with_claude():
    model, _ = gpt(chunks=[chunk(content="Hello"), chunk(content=" there", finish="stop"), NS(usage=usage(), choices=[])])
    with model.stream(ask()) as s:
        assert "".join(s.text_stream) == "Hello there"
        assert s.get_final_message().stop_reason == "end_turn"


@pytest.mark.parametrize("extra", [
    {"tools": [{"type": "web_search_20260209", "name": "web_search"}]},
    {"messages": [{"role": "user", "content": [{"type": "document", "source": {"type": "base64", "data": "x"}}]}]},
])
def test_what_only_claude_can_do_is_refused_with_a_message_naming_gpt(extra):
    with pytest.raises(L.NeedsClaude, match="Azure OpenAI"):
        G.to_request(ask(**extra))
    with pytest.raises(L.NeedsClaude):
        gpt()[0].count_tokens(ask())


def test_azure_failures_become_the_errors_the_lab_already_shows():
    model, _ = gpt(error=openai.APIConnectionError(request=None))
    with pytest.raises(L.ModelUnavailable) as caught:
        model.create(ask())
    assert to_api_error(caught.value).status == 503
