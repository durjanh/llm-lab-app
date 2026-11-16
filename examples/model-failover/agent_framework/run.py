"""A live run: the first Claude model then the first GPT deployment (both from config/model-failover.json) behind a
FallbackChatClient, with an injected 429 on Claude, and the conversation kept in the lab's Blob + Table layout (Azurite or Azure if configured, else files under generated/).

    export ANTHROPIC_API_KEY=...            # or sign in with `ant auth login`
    export AZURE_OPENAI_ENDPOINT=... AZURE_OPENAI_DEPLOYMENTS=gpt-5.4-mini   # and az login
    python run.py

Two short turns. The first turn's call to Claude hits an injected 429 (retry-after 30 s) and goes to GPT; the second turn
skips Claude, whose breaker is open. Without the Azure settings there is nothing to switch to, and the run says so.
The script reads only the environment: it never opens a .env file.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "shared"))
import catalog  # noqa: E402  (the model names: config/model-failover.json)
import lab_store  # noqa: E402
from agent_framework import Agent, AgentSession  # noqa: E402
from failover import BlobTableHistoryProvider, ClaudeChatClient, FallbackChatClient, InjectFaults  # noqa: E402


def gpt_client():
    from agent_framework.openai import OpenAIChatCompletionClient
    from azure.identity import DefaultAzureCredential
    gpt = catalog.first("azure-openai")
    endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT", "")
    if not (endpoint and gpt):
        return None
    return gpt["name"], OpenAIChatCompletionClient(model=gpt["model"], azure_endpoint=endpoint,
                                                   credential=DefaultAzureCredential(), api_version="preview")


async def main() -> None:
    first = catalog.first("anthropic")
    claude = ClaudeChatClient(first["model"], max_tokens=100)
    clients = [(first["name"], InjectFaults(claude, [(429, 30.0)]))]
    if gpt := gpt_client():
        clients.append(gpt)
    else:
        print("No GPT deployment configured: after the injected 429 there is nothing to switch to.")
    events: list[dict] = []
    client = FallbackChatClient(clients, on_event=events.append)
    store = lab_store.make_store()
    provider = BlobTableHistoryProvider(store, summariser=claude)
    agent = Agent(client, "You answer in one short sentence.", context_providers=[provider])
    session = AgentSession(session_id="failover-demo")
    for question in ("Name one planet.", "And what is the next one out from the sun?"):
        reply = await agent.run(question, session=session)
        print(f"> {question}\n{reply.text}  [{client.last_model}]")
    print("events:", json.dumps(events))
    print("session:", json.dumps(session.to_dict()))
    for s in store.load(lab_store.conv_id_for("failover-demo")).steps:
        print(s.key, s.kind, (s.content[0].get("text") or "")[:60])


if __name__ == "__main__":
    asyncio.run(main())
