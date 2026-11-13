# Claude on other clouds

Claude is also served by Amazon Bedrock, Google Cloud Vertex AI and Microsoft Foundry. The Anthropic SDK has one client class for each, and after you build the client, `client.messages.create(...)` is the same call you use against the first-party API. What changes is the account, the sign-in, the model id and which features exist.

These three scripts are short examples, checked with `python -m py_compile` only. They need cloud accounts the lab does not have, so nobody has run them here.

| Script | Client class | Sign-in | Model id |
|---|---|---|---|
| `bedrock.py` | `AnthropicBedrockMantle(aws_region=...)` | AWS credentials (SigV4): `aws configure`, SSO, environment variables or an instance role | `anthropic.claude-haiku-5-5` |
| `vertex.py` | `AnthropicVertex(project_id=..., region=...)` | Google Application Default Credentials: `gcloud auth application-default login` or a service account | `claude-haiku-5-5` |
| `foundry.py` | `AnthropicFoundry(resource=..., azure_ad_token_provider=...)` | Entra ID through `azure-identity`; an API key also works but the lab does not use keys | your deployment name, by default `claude-haiku-5-5` |

```sh
pip install -r requirements.txt
AWS_REGION=us-east-1 python bedrock.py
GOOGLE_CLOUD_PROJECT=my-project python vertex.py
FOUNDRY_RESOURCE=my-resource python foundry.py
```

## What each one needs

**Amazon Bedrock.** An AWS account and Bedrock model access for each Claude model (some models are open to everyone, others need a request or verification). Pick a region that serves the model: the global endpoint routes across regions at no extra cost, a regional endpoint keeps data in one region for a 10% premium. Auth is AWS credentials, with IAM permission `bedrock-mantle:CreateInference` on the model; a short-lived Bedrock bearer token also works. Install `anthropic[bedrock]`. `AnthropicBedrockMantle` is the Messages API on the `bedrock-mantle` endpoint; the older `AnthropicBedrock` class is the `InvokeModel` path.

**Google Vertex AI.** A project with the Vertex AI API on and the Claude model enabled in Model Garden. Auth is Application Default Credentials, so a service account on the workload in production. `region` can be `global` (recommended), a multi-region such as `us` or `eu`, or a single region. Install `anthropic[vertex]`.

**Microsoft Foundry.** A Foundry resource, a Claude deployment inside it, and an Azure RBAC role (Foundry User or Cognitive Services User) for whoever calls it. Foundry has two hosting options per deployment: hosted on Azure (inference stays in Azure, a subset of models) and hosted on Anthropic (all models, more features). Billing is through the Azure Marketplace. Entra ID is supported: the Python client takes `azure_ad_token_provider`, and the documented token scope is `https://ai.azure.com/.default`. This matches the lab's keyless rule (`az login` locally, managed identity in Azure). Note the scope differs from the `https://cognitiveservices.azure.com/.default` scope the lab uses for Azure OpenAI.

## How model ids differ

| Platform | Pattern | Example |
|---|---|---|
| First-party API | the bare id | `claude-haiku-5-5` |
| Amazon Bedrock | `anthropic.` prefix | `anthropic.claude-haiku-5-5` |
| Google Vertex AI | the bare id for current models; `id@date` for dated snapshots | `claude-haiku-5-5`, `claude-opus-4-5@20251101` |
| Microsoft Foundry | the deployment name you chose (defaults to the model id) | `claude-haiku-5-5` or `my-claude-deployment` |

Never add a date suffix to a current model id. Each platform adds models on its own schedule, so check its model list before assuming a new model is there (Bedrock, for instance, serves some models only on its older `bedrock-runtime` endpoint).

## Features that lag or differ

Messages, streaming, tool use, structured outputs, prompt caching, adaptive thinking, citations and PDFs work on all three. The differences, as the docs and the platform table stand today (check the live docs before relying on one):

| Feature | Bedrock | Vertex | Foundry |
|---|---|---|---|
| Claude Managed Agents | no | no | no |
| Message Batches API, Models API | no | no | no |
| Server-side fallback (`fallbacks`) | no, use client-side fallback | no | no |
| Web search | no | basic version only | basic version only when hosted on Azure |
| Web fetch, code execution | no | no | web fetch basic only, code execution only when hosted on Anthropic |
| Files API, Agent Skills, programmatic tool calling | no | no | only when hosted on Anthropic |
| MCP connector | no | no | beta |
| `inference_geo` (data residency parameter) | no | no | no |
| Anthropic rate-limit headers | n/a | n/a | not sent; use Azure monitoring |

Billing, quotas, logging and data handling come from the cloud provider, not Anthropic: Foundry bills in Claude Consumption Units on the Azure bill, Bedrock and Vertex have their own pricing pages.

## Why use them

Same models, but inside a cloud you already have: existing identity and RBAC, private networking, one invoice, regional data residency and the provider's compliance cover. The cost is a feature lag and a second set of quotas. If you need a feature that is missing, call the first-party API for that part.

## Where this fits in the lab

`examples/sdks/claude/` uses the first-party client with an API key. `examples/medassist/hosted` runs an agent on Foundry's hosted-agent service, which is a different thing from calling a Claude model through Foundry.
