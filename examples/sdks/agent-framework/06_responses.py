"""Chat Completions against Responses under the same Agent Framework agent: where the conversation lives, and what it costs.

The same two-turn conversation runs three ways:
- chat: Chat Completions. The session keeps every message on this machine and sends the whole history each turn.
- responses: Responses with store on (its default). The session keeps only the last response id and Azure keeps
  the history, by default for 30 days. The model still reads the whole history, so input tokens are much the same.
- responses, store off: Responses used statelessly, like Chat Completions. Nothing is kept on the server.
Then the code interpreter, a hosted tool only the Responses client offers: the model runs Python in Azure's sandbox.

    .venv/bin/python 06_responses.py
"""
import asyncio

from _af import chat_client, trace
from agent_framework import Agent, tool
from agent_framework.openai import OpenAIChatClient

from shared import engagements, tasks

FOLLOW_UP = "Of those, which has used the most budget? One line."


def local_messages(state) -> int:
    """How many messages the session holds on this machine (the in-memory history provider keeps them in state)."""
    if isinstance(state, dict):
        return sum(local_messages(v) for v in state.values())
    if isinstance(state, list):
        return len(state) if state and hasattr(state[0], "role") else sum(local_messages(v) for v in state)
    return 0


def tokens(response) -> str:
    usage = getattr(response, "usage_details", None) or {}
    return f"{usage.get('input_token_count', '?')} in, {usage.get('output_token_count', '?')} out"


async def conversation(label: str, api: str, options: dict | None = None) -> None:
    print(f"\n=== {label} ===")
    agent = Agent(chat_client(api=api), tasks.SYSTEM, name="analyst",
                  tools=[tool(f) for f in engagements.READ_TOOLS], middleware=[trace])
    session = agent.create_session()
    for turn, prompt in enumerate([tasks.QUESTION, FOLLOW_UP], 1):
        response = await agent.run(prompt, session=session, options=options or {})
        print(f"  turn {turn}: {tokens(response)}")
    print(f"  answer: {response.text.strip()}")
    print(f"  on this machine: {local_messages(session.state)} messages")
    print(f"  on the server:   {session.service_session_id or 'nothing'}")


async def code_interpreter() -> None:
    print("\n=== Hosted code interpreter (Responses only) ===")
    agent = Agent(chat_client(api="responses"), "Use the code interpreter for any arithmetic.", name="calculator",
                  tools=[OpenAIChatClient.get_code_interpreter_tool()])
    try:
        response = await agent.run("A classifier got 12 of 12 right. Compute the 95% Wilson score interval for its "
                                   "accuracy. Reply with the interval as two percentages.")
    except Exception as exc:  # not every region or model offers the hosted tools
        print(f"  not available here: {type(exc).__name__}: {str(exc)[:200]}")
        return
    kinds = sorted({c.type for m in response.messages for c in m.contents})
    print(f"  content types in the reply: {kinds}")
    print(f"  answer: {response.text.strip()}")


async def main() -> None:
    await conversation("Chat Completions", "chat")
    await conversation("Responses, store on", "responses")
    await conversation("Responses, store off", "responses", {"store": False})
    await code_interpreter()


asyncio.run(main())
