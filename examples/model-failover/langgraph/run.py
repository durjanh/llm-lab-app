"""A live run: the first Claude model then the first GPT deployment (both from config/model-failover.json) behind
failover_model, with an injected 429 on Claude, and the checkpoints kept in Blob + Table (Azurite or Azure if configured, else a folder under generated/).

    export ANTHROPIC_API_KEY=...            # or sign in with `ant auth login`
    export AZURE_OPENAI_ENDPOINT=... AZURE_OPENAI_DEPLOYMENTS=gpt-5.4-mini   # and az login
    python run.py

The first turn's call to Claude hits an injected 429 (retry-after 30 s) and goes to GPT; the second turn skips Claude, whose
breaker is open, and sees the first turn's messages from the checkpoint. The script reads only the environment: it never
opens a .env file.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "shared"))
import catalog  # noqa: E402  (the model names: config/model-failover.json)
import lab_store  # noqa: E402
from blob_saver import AzureBackend, BlobTableSaver, DirBackend  # noqa: E402
from failover_graph import build_graph, failover_model  # noqa: E402
from langchain_core.messages import HumanMessage  # noqa: E402
from rules import Fault  # noqa: E402


def main() -> None:
    from langchain_anthropic import ChatAnthropic
    first = catalog.first("anthropic")
    claude = ChatAnthropic(model=first["model"], max_tokens=100, max_retries=0)
    models = [(first["name"], claude)]
    gpt = catalog.first("azure-openai")
    if os.environ.get("AZURE_OPENAI_ENDPOINT") and gpt:
        from azure.identity import DefaultAzureCredential, get_bearer_token_provider
        from langchain_openai import AzureChatOpenAI
        token = get_bearer_token_provider(DefaultAzureCredential(), "https://cognitiveservices.azure.com/.default")
        models.append((gpt["name"], AzureChatOpenAI(azure_endpoint=os.environ["AZURE_OPENAI_ENDPOINT"], azure_deployment=gpt["model"],
                                                       azure_ad_token_provider=token, api_version="2025-04-01-preview", max_retries=0)))
    else:
        print("No GPT deployment configured: after the injected 429 there is nothing to switch to.")
    events: list[dict] = []
    store = lab_store.make_store()
    backend = AzureBackend(store) if store.kind in ("azure", "azurite") else DirBackend(lab_store.ROOT / "generated" / "model-failover-examples" / "langgraph")
    chat = failover_model(models, events=events, faults={first["name"]: [Fault(429, 30.0)]})
    graph = build_graph(chat, BlobTableSaver(backend), summariser=claude, events=events)
    config = {"configurable": {"thread_id": "failover-demo"}}
    for question in ("Name one planet.", "And what is the next one out from the sun?"):
        out = graph.invoke({"messages": [HumanMessage(question)]}, config)
        print(f"> {question}\n{out['messages'][-1].content}  [{out['answered_by']}]")
    print("events:", events)
    print("checkpoints:", len(backend.rows("failover-demo")))


if __name__ == "__main__":
    main()
