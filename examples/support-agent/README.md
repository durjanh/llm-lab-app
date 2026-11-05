# Support agent: Azure AI Search tool, OpenAPI tool and a conversation

This is a Microsoft Foundry Agent Service agent for a fictional shop. It answers policy questions from an Azure AI Search index, looks up orders through the shop's order-status API, and keeps context across turns.

| Need | Component | Here |
|---|---|---|
| Grounded answers from the company's index | **Azure AI Search tool**, through a project connection | `support-kb`: 7 articles on delivery, returns, warranty and products, searched with the semantic ranker |
| Order status from a back-end API | **OpenAPI tool**: the agent reads the API's OpenAPI spec and Foundry makes the call | `order_api.py` in Azure Container Apps, with four invented orders |
| Context across a multi-turn chat | A **conversation**, which holds every turn | One conversation per chat. A **memory store** is different: long-term memory across separate conversations, in preview. |

This is the exam question's answer: Azure AI Search tool, OpenAPI tool and conversation. Bing grounding searches the public web, not your index. Chat and embedding deployments are not tools.

```sh
examples/support-agent/setup.sh                          # once: search connection, roles, order API (prints ORDER_API_URL)
echo "ORDER_API_URL=https://..." >> .env                 # the URL it printed
python examples/support-agent/support_agent.py index     # the articles, into AI Search
python examples/support-agent/support_agent.py create    # the agent, with both tools
python examples/support-agent/support_agent.py test      # the scripted conversation, then a fresh one
python examples/support-agent/support_agent.py chat      # talk to it
```

To remove it all: `support_agent.py delete` (the agent and the index), then `setup.sh --delete` (the connection, roles and API). With azd, `infra/` creates the connection, the roles and the order API itself, and writes `ORDER_API_URL` to `.env`.

## The test conversation

All three turns happen in one conversation:

1. "Where is my order SO-10533?" The agent calls `getOrderStatus` and gets: delayed, a new delivery date and the reason.
2. "That's later than you first said. Do I get anything back for the delay?" There is no order number in this turn, so the conversation supplies it. The agent searches the articles and finds that a delay of more than 3 days gets the delivery fee refunded.
3. "And if I decide I don't want it once it arrives, can I send it back?" It searches again and finds the 30-day returns rule.

Then turn 2 is asked again in a **new** conversation. With no earlier turns, the agent has to ask which order. That shows the context lives in the conversation, not in the agent.

## Sign-in and permissions

- **Search connection:** `authType: AAD`. The tool queries the index as the project's managed identity, so that identity needs Search Index Data Reader, plus Search Service Contributor to read the index definition. The search service has key sign-in switched off.
- **Order API:** anonymous, because it serves invented data. A real API would use `OpenApiManagedAuthDetails`: the project's managed identity requests a token for the API's audience, and the API checks it. The coding sandbox in this repository checks tokens the same way, with Container Apps authentication. Otherwise, use a project connection that holds the API's key.
- **This script** signs in with `az login`. It needs Search Index Data Contributor on the search service to build the index.
