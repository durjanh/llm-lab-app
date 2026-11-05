"""A Foundry Agent Service support agent: grounded answers from an Azure AI Search index, order status from a
back-end API through an OpenAPI tool, and context kept across turns by a conversation.

    python examples/support-agent/support_agent.py index    # the support articles, into an AI Search index
    python examples/support-agent/support_agent.py create   # the agent: Azure AI Search tool + OpenAPI tool
    python examples/support-agent/support_agent.py test     # a scripted conversation, then the same question in a new one
    python examples/support-agent/support_agent.py chat     # talk to it; one conversation for the whole session
    python examples/support-agent/support_agent.py delete   # the agent and the index (setup.sh --delete for the rest)

Run examples/support-agent/setup.sh first: it makes the project's search connection, gives the project's managed
identity its search roles, and deploys the order-status API where Foundry can call it.

Which component does what:
- Azure AI Search tool: grounded answers, with citations, from the company's index (through a project connection).
- OpenAPI tool: calls the order-status API, described by its OpenAPI spec. Foundry makes the call, not this script.
- Conversation: holds the turns, so "do I get anything back for the delay?" knows which order. A memory store is
  something else: long-term memory across separate conversations (preview), not needed for one chat.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

import httpx
from azure.ai.projects import AIProjectClient
from azure.ai.projects.models import (AISearchIndexResource, AzureAISearchQueryType, AzureAISearchTool,
                                      AzureAISearchToolResource, OpenApiAnonymousAuthDetails, OpenApiFunctionDefinition,
                                      OpenApiTool, PromptAgentDefinition)
from azure.identity import DefaultAzureCredential
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE.parents[1] / ".env")
AGENT = "SupportDesk"
INDEX = "support-kb"
CONNECTION = "support-search"
SEARCH_API = "2024-07-01"

INSTRUCTIONS = """You are the customer support agent for a home technology shop (fictional).
- Answer questions about policies, returns, delivery, warranties and products only from the support articles,
  found with the Azure AI Search tool. Cite the article. If the articles do not say, say so; do not guess.
- For an order's status, delivery date or tracking, call getOrderStatus with the order number. If the customer has
  not given one in this conversation, ask for it. Never invent order details.
- Earlier turns of this conversation are context: if the customer already gave an order number, use it.
- Be brief: two or three sentences, with dates written out (for example 8 November)."""

ARTICLES = [
    ("delivery-standard", "Delivery times", "Delivery",
     "Standard delivery takes 3 to 5 working days from dispatch. Next-day delivery is available for orders placed "
     "before 2pm on a working day. Every order gets a tracking number by email when it is dispatched."),
    ("delivery-delays", "Late deliveries and compensation", "Delivery",
     "If an order arrives more than 3 days after its original estimated delivery date, we refund the delivery fee in "
     "full, automatically, within 5 working days of the order arriving. If it arrives more than 10 days late you can "
     "also cancel the order for a full refund. Delays caused by the carrier count the same as our own."),
    ("returns", "Returns", "Returns",
     "You can return any item within 30 days of delivery for a full refund, as long as it is unused and in its "
     "original packaging. Start a return from your account; the return label is free. Refunds reach your card within "
     "5 working days of the item arriving back with us. Opened filter cartridges cannot be returned unless faulty."),
    ("faulty", "Faulty items", "Returns",
     "If an item develops a fault within 12 months, we repair or replace it free of charge, including postage. After "
     "12 months the manufacturer's warranty applies. Please do not open the casing, as that voids the warranty."),
    ("warranty", "Warranties", "Products",
     "The Tessaline router and the Brindlewave hub carry a 2-year manufacturer's warranty. Vellacor sensors and "
     "Kestramine pumps carry 1 year. Quorvex filter cartridges are consumables and have no warranty beyond 12 months "
     "for faults."),
    ("brindlewave-reset", "Resetting the Brindlewave hub", "Products",
     "To reset the Brindlewave hub, hold the button on the back for 10 seconds until the light flashes blue, then "
     "set it up again in the app. A red light after a reset means it cannot reach your router: check the cable."),
    ("tessaline-dropouts", "Tessaline router dropping the connection", "Products",
     "If a Tessaline router drops the connection after a firmware update, restart it, then turn off 'smart channel' "
     "in the app. If the drops continue for more than a day, contact us for a replacement under warranty."),
]

STEPS = [  # one conversation: each turn leans on the earlier ones
    "Where is my order SO-10533?",
    "That's later than you first said. Do I get anything back for the delay?",
    "And if I decide I don't want it once it arrives, can I send it back?",
]


def env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        sys.exit(f"Set {name} in the lab's .env (examples/support-agent/setup.sh prints ORDER_API_URL).")
    return value


CREDENTIAL = DefaultAzureCredential()


def search(method: str, path: str, **kw) -> httpx.Response:
    """Azure AI Search's REST API, signed in with Entra: the service has key sign-in switched off."""
    token = CREDENTIAL.get_token("https://search.azure.com/.default").token
    r = httpx.request(method, f"{env('AZURE_SEARCH_ENDPOINT')}{path}", params={"api-version": SEARCH_API},
                      headers={"Authorization": f"Bearer {token}"}, timeout=60, **kw)
    if r.status_code >= 400 and not (method == "DELETE" and r.status_code == 404):
        sys.exit(f"Search {method} {path}: {r.status_code} {r.text[:300]}")
    return r


def index(_project=None, _args=None) -> None:
    """The support articles as a search index: keyword search, plus a semantic configuration for reranking."""
    search("PUT", f"/indexes/{INDEX}", json={
        "name": INDEX,
        "fields": [{"name": "id", "type": "Edm.String", "key": True},
                   {"name": "title", "type": "Edm.String", "searchable": True, "retrievable": True},
                   {"name": "category", "type": "Edm.String", "filterable": True, "facetable": True},
                   {"name": "content", "type": "Edm.String", "searchable": True, "retrievable": True}],
        "semantic": {"configurations": [{"name": "default", "prioritizedFields": {
            "titleField": {"fieldName": "title"}, "prioritizedContentFields": [{"fieldName": "content"}]}}]}})
    docs = [{"@search.action": "mergeOrUpload", "id": i, "title": t, "category": c, "content": body}
            for i, t, c, body in ARTICLES]
    search("POST", f"/indexes/{INDEX}/docs/index", json={"value": docs})
    print(f"Index {INDEX}: {len(docs)} support articles")


def create(project: AIProjectClient, _args=None) -> None:
    """The agent: instructions, the Azure AI Search tool over the index, and the OpenAPI tool for orders."""
    spec = httpx.get(f"{env('ORDER_API_URL').rstrip('/')}/openapi.json", timeout=60).json()  # wakes the app too
    connection = project.connections.get(CONNECTION)
    agent = project.agents.create_version(
        agent_name=AGENT,
        description="Support agent (fictional shop): policy answers from AI Search, order status from the order API.",
        definition=PromptAgentDefinition(
            model=env("FOUNDRY_MODEL"),
            instructions=INSTRUCTIONS,
            tools=[
                AzureAISearchTool(azure_ai_search=AzureAISearchToolResource(indexes=[AISearchIndexResource(
                    project_connection_id=connection.id, index_name=INDEX,
                    query_type=AzureAISearchQueryType.SEMANTIC, top_k=3)])),
                # Anonymous: the API serves invented orders. A real one would use OpenApiManagedAuthDetails (the
                # project's managed identity, no secret) or a project connection holding its key.
                OpenApiTool(openapi=OpenApiFunctionDefinition(
                    name="orders", spec=spec, description="Look up an order's status, delivery date and tracking.",
                    auth=OpenApiAnonymousAuthDetails())),
            ],
        ),
    )
    print(f"Saved {agent.name} version {agent.version}: Azure AI Search tool ({INDEX}, semantic) and OpenAPI tool "
          f"({spec['servers'][0]['url']}). It is in the Foundry portal too.")


def ask(openai, conversation: str, text: str) -> tuple[str, list[str]]:
    """One customer message in the conversation. Foundry runs both tools itself; the output reports each call."""
    r = openai.responses.create(conversation=conversation, input=text,
                                extra_body={"agent_reference": {"name": AGENT, "type": "agent_reference"}})
    tools = []
    for item in r.output:
        if item.type == "message":
            continue
        detail = item.model_dump(exclude_none=True)
        args = detail.get("arguments") or detail.get("queries") or detail.get("input") or ""
        tools.append(item.type)
        print(f"    [{item.type}] {str(args)[:160]}")
    return r.output_text, tools


def test(project: AIProjectClient, _args=None) -> None:
    """The scripted conversation, with checks, then the second question again in a brand-new conversation."""
    openai = project.get_openai_client()
    conversation = openai.conversations.create().id
    checks = []
    replies = []
    for text in STEPS:
        print(f"\ncustomer: {text}")
        reply, tools = ask(openai, conversation, text)
        replies.append((reply, tools))
        print(f"agent:    {reply}")
    (r1, t1), (r2, t2), (r3, t3) = replies
    checks.append(("turn 1 called the order API", any("openapi" in t for t in t1)))
    checks.append(("turn 1 gave the new delivery date", bool(re.search(r"\b\d{1,2}\s+\w+|\w+\s+\d{1,2}\b", r1))))
    checks.append(("turn 2 searched the support articles", any("search" in t for t in t2)))
    checks.append(("turn 2 knew the order without being told again", "SO-10533" not in STEPS[1]
                   and re.search(r"delivery fee|refund", r2, re.I) is not None))
    checks.append(("turn 3 gave the 30-day return rule", "30" in r3))
    openai.conversations.delete(conversation)

    print("\nThe same second question, in a new conversation (no earlier turns):")
    fresh = openai.conversations.create().id
    print(f"customer: {STEPS[1]}")
    reply, _ = ask(openai, fresh, STEPS[1])
    print(f"agent:    {reply}")
    checks.append(("a new conversation asks which order", re.search(r"order number|which order|SO-", reply, re.I) is not None))
    openai.conversations.delete(fresh)
    print()
    for name, ok in checks:
        print(f"  {'pass' if ok else 'FAIL'}  {name}")


def chat(project: AIProjectClient, _args=None) -> None:
    openai = project.get_openai_client()
    conversation = openai.conversations.create().id
    print("Support desk (fictional shop). Orders SO-10482, SO-10517, SO-10533 and SO-10560 exist. Empty line to end.")
    try:
        while text := input("\nyou: ").strip():
            reply, _ = ask(openai, conversation, text)
            print(f"agent: {reply}")
    finally:
        openai.conversations.delete(conversation)


def delete(project: AIProjectClient, _args=None) -> None:
    try:
        project.agents.delete(agent_name=AGENT)
        print(f"Deleted {AGENT}")
    except Exception as exc:  # already gone
        print(f"{AGENT}: {exc}")
    search("DELETE", f"/indexes/{INDEX}")
    print(f"Deleted index {INDEX}. setup.sh --delete removes the connection, roles and order API.")


COMMANDS = {"index": index, "create": create, "test": test, "chat": chat, "delete": delete}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("command", choices=COMMANDS)
    args = ap.parse_args()
    if args.command == "index":
        return index()
    with AIProjectClient(endpoint=env("FOUNDRY_PROJECT_ENDPOINT"), credential=CREDENTIAL) as project:
        COMMANDS[args.command](project, args)


if __name__ == "__main__":
    main()
