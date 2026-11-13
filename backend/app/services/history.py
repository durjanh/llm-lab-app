"""Turning a model's reply into the assistant turn of a conversation that is sent again.

The Messages API refuses an assistant turn with no content, and a refusal or an empty reply has none. Any service that
keeps a history (a tool loop, or a retry that shows the model its last answer) builds that turn here, so an empty reply
becomes a short note instead of a request the next call cannot send.
"""
from __future__ import annotations

from typing import Any


def no_reply(response: Any) -> str:
    """What stands in for a reply with no text: a refusal, an empty answer, or one cut off before any text."""
    return f"(No reply: stop_reason {getattr(response, 'stop_reason', None)}.)"


def assistant_blocks(response: Any) -> list[dict[str, Any]]:
    """The reply's text and tool_use blocks as request content, never empty."""
    blocks: list[dict[str, Any]] = []
    for b in response.content:
        if getattr(b, "type", None) == "text":
            blocks.append({"type": "text", "text": b.text})
        elif getattr(b, "type", None) == "tool_use":
            blocks.append({"type": "tool_use", "id": b.id, "name": b.name, "input": dict(b.input)})
    return blocks or [{"type": "text", "text": no_reply(response)}]


def assistant_text(text: str, response: Any) -> str:
    """The reply's text for a text-only history, never empty."""
    return text or no_reply(response)
