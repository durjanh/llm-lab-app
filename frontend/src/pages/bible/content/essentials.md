## The 60-second project pitch
*Pages to open: [Home](/) · [Coding agent](/coding-agent) · [Harness engineering](/harness) · [Foundry operations](/foundry-operations)*

"I built LLM Lab, about 50 interactive pages on how LLMs work and how to build with them. The backend is FastAPI in layers: thin routers, services, and gateways that are the only code touching the Anthropic and Azure SDKs, all wired in one composition root so tests can swap in fakes and run with no keys and no cost. The frontend is React and TypeScript with one route per lab. Every paid call goes through a spending cap and a guard that only accepts requests from the lab page. Long jobs, such as the coding agent, the harness and the site builder, run in the background and stream events to the page as NDJSON. Agents that run commands do it in a sandbox, and actions that change things wait for a human to approve them. On Azure it is all keyless with Entra ID, provisioned with Bicep through azd, and deployed by a GitHub Actions pipeline that signs in with OIDC and stops the release if the evaluation score drops."

## A. Temperature, top-p, top-k: how the model picks the next token
*Pages to open: [Sampling](/sampling) · [Transformer explainer](/transformer) · [Reasoning models](/reasoning-models) · [Confidence](/confidence)*

**The mechanics in four steps**
1. For each position the model outputs **logits**, one raw score for every token in the vocabulary (about 50,000 to 200,000 of them).
2. **Softmax** turns the logits into probabilities that add up to 1.
3. **Temperature, top-k and top-p** reshape or cut that distribution.
4. One token is **sampled** from what is left, added to the input, and the loop repeats. That loop is why LLMs are called *autoregressive*.

| Setting | What it does | Typical values |
|---|---|---|
| **Temperature (T)** | Divides every logit by T before the softmax. T < 1 sharpens the distribution, so likely tokens become even more likely. T > 1 flattens it, so more unusual tokens get picked. T near 0 is effectively **greedy**: it always takes the top token. | 0 to 0.3 for extraction, classification, code and JSON. 0.7 to 1.0 for writing and brainstorming. *Current Claude models and GPT reasoning models don't accept it (see below).* |
| **Top-k** | Keeps only the k most likely tokens and renormalises. The cut is a fixed count whatever the shape of the distribution. | k = 40 to 50 is common. Many APIs don't expose it. |
| **Top-p (nucleus)** | Keeps the *smallest* set of tokens whose probabilities add up to p. When the model is confident, that might be 2 tokens. When it isn't, it might be 200. That adaptive cut is why top-p is usually preferred to top-k. | 0.9 to 0.95 |
| **max_tokens** | A hard cap on output length. When the model hits it, the response ends with stop_reason `max_tokens` and is cut off mid-answer, so check for it. | Depends on the task |
| **Stop sequences** | Stop generating as soon as a given string appears. | `"</answer>"` |
| **Frequency / presence penalty** (OpenAI) | Lowers the scores of tokens that have already appeared, which reduces repetition. | 0 to 1 |

**Worked example.** Logits [2.0, 1.0, 0.1] give probabilities of roughly [0.66, 0.24, 0.10] at T = 1. At T = 0.5 the logits double to [4, 2, 0.2], which gives about [0.86, 0.12, 0.02], so the model becomes more decisive. At T = 2 they halve to [1, 0.5, 0.05], which gives about [0.48, 0.29, 0.19], so it becomes more random.

**Likely questions**
- **Q: What does temperature actually do?**
  **A:** It scales the logits before the softmax. Low temperature makes the most likely token dominate, so the output is focused and repeatable. High temperature spreads probability onto less likely tokens, so the output is more varied but more likely to go off track. It doesn't make the model smarter. It only changes how it picks from what it already predicts.
- **Q: Temperature vs top-p: which would you tune?**
  **A:** Usually one, not both, because they interact and it becomes hard to reason about which caused a change. Temperature changes the *shape* of the distribution. Top-p cuts its *tail*. On models that allow it, I use a low temperature plus a schema for structured work, and leave the defaults for writing.
- **Q: Can you set temperature on every model?**
  **A:** No. Current Claude models don't accept a temperature setting, and reasoning models such as GPT-5 refuse temperature and top_p as well. You steer them with the prompt instead: examples, structured outputs, and the effort or thinking budget. My lab's GPT translation layer drops those parameters for that reason. The sampling knobs still matter for open models (GPT-2 in the browser, the local model) and for older deployments. And because the answers still vary between calls, you can sample several times and take a majority vote (self-consistency).
- **Q: Is temperature 0 deterministic?**
  **A:** Not guaranteed. Batching on the server, floating-point non-determinism on GPUs, and routing in mixture-of-experts models can all change the output slightly. If you need repeatable results, pin the model version, keep the prompt fixed, use structured outputs, and cache the answers.
- **Q: The model keeps hallucinating. Will lowering the temperature fix it?**
  **A:** Only a little. Low temperature reduces random drift, but the model can still be confidently wrong at temperature 0. The real fixes are grounding (RAG with citations), allowing "I don't know", checking the answer against the source (groundedness detection), and evaluation.

## B. How to save tokens (and money)
*Pages to open: [Context & cost](/context) · [Routing](/routing) · [Context engineering](/context-engineering) · [Tokens](/tokens) · [Images as tokens](/vision)*

**Start by measuring.** Log input, output and cached tokens for every call (the API returns them in `usage`), count tokens before you send a request (`count_tokens`), and work out the cost per request and per user task, not just per month. In this lab, `SpendTracker` prices every reply by the model that actually answered.

**Biggest levers, roughly in order of impact**
1. **Use the smallest model that passes your evals.** From this lab's price table (per million tokens): Opus $4 in / $20 out, Sonnet $2 / $10, Haiku $0.10 / $0.50. Haiku is 40 times cheaper than Opus. Send simple work such as classification, extraction and routing to the small model. Keep the large model for hard reasoning. A **cascade** tries the cheap model first and escalates only when a confidence check fails. *(Routing page.)*
2. **Prompt caching.** Put everything that doesn't change first (tools, system prompt, reference documents) and mark a cache breakpoint. Later calls read that prefix at about **0.1 times** the input price. Writing it to the cache costs 1.25 times the input price for the 5-minute cache. Any change before the breakpoint breaks the cache, so put dynamic content (dates, user names) after it. There is a minimum prefix length, so check the docs for each model. In this repo the data agent caches its tools and the last message, and the site builder caches the whole conversation.
   *Example:* a 10,000-token system prompt sent 1,000 times a day on Sonnet is 10M input tokens, about $20 a day. With caching it is about $2 for the cached reads plus one write every five minutes.
3. **Output tokens cost about 5 times as much as input tokens.** Set `max_tokens`, ask for concise answers, use structured outputs and JSON schemas so the model doesn't write prose around the data, and use stop sequences.
4. **Keep the context small.** Retrieve the top-k chunks (and rerank them) instead of pasting whole documents. Summarise or compact long conversations. Trim large tool results before sending them back. Drop old tool outputs. Have sub-agents return a summary instead of their full transcript. *(Context & cost, Context engineering.)*
5. **Batch APIs** (Anthropic Message Batches, Azure OpenAI Global Batch) cost about 50% less for work that can wait up to 24 hours, such as evaluations, bulk classification and back-fills.
6. **Limit the reasoning budget.** Thinking tokens are billed as output. Set a thinking budget or a low effort level for easy tasks.
7. **Need fewer turns.** Good tool descriptions and parallel tool calls mean fewer round trips. Each turn re-sends the whole conversation, so a 20-turn agent loop pays for the early messages 20 times (caching softens this).
8. **Images:** on Claude, an image costs about width × height / 750 tokens, so resize images to the size the task needs.
9. **Don't call an LLM when plain code will do.** Regex, rules, a small classifier, or an answer cache for repeated questions. Make sure a cache can't serve one user's answer to another, or keep serving an answer after the source has changed.
10. **Use a local or open model in development.** This lab runs one in Docker Model Runner at no cost per token.

**Guardrails on spend:** a global cap (`--budget`, `require_budget` on every paid route), a budget for each run of an agent, and Azure budgets with alerts.

**Likely questions**
- **Q: Your LLM bill doubled last month. What do you do?**
  **A:** First, find out where the money goes: break the cost down by feature, model and input versus output tokens. Usually it is one of these: conversations growing without limit, a large prompt that isn't cached, a big model doing simple work, or an agent stuck in a loop. Then fix the biggest one first, and use the evals to check that quality hasn't dropped.
- **Q: How does prompt caching work and when does it not help?**
  **A:** The provider stores the processed state of a prompt prefix that hasn't changed, so later requests skip that work and pay about a tenth of the input price for it. It doesn't help when the prefix changes on every call, when traffic is too sparse to hit the cache within its lifetime (5 minutes by default, 1 hour as an option), or when the prefix is shorter than the minimum.

## C. Deploying to production and keeping it running
*Pages to open: [Foundry operations](/foundry-operations) · [Rate limits](/resilience) · [Evals](/evals) · [Guardrails](/guardrails) · [Prompt injection](/injection) · [Coding agent](/coding-agent)*

**How this lab does it (you can describe it as your own setup)**
- **Infrastructure as code:** Bicep (`infra/`) through `azd up`. It creates the Foundry (AI Services) account and project, the model deployments, Azure AI Search, Container Apps for the sandbox, and the role assignments. `azd provision --preview` shows what will change before anything is applied. `azd down --purge` removes everything, and the purge matters because deleted AI Services accounts are only soft-deleted and keep their name and quota until purged.
- **CI/CD (`.github/workflows/infra.yml`):** on a pull request, the pipeline only compiles the Bicep and checks the scripts, with no Azure access, so a branch can never reach the subscription. On main, it signs in with **OIDC workload identity federation** (no stored secret), previews the changes, provisions, then runs an **evaluation gate** (`eval_gate.py`). The gate uses an LLM judge to score groundedness and relevance on labelled cases and fails the build if either score is below its threshold. A concurrency group stops two deployments running at once, and a deployment is never cancelled half way.
- **Identity:** keyless. Entra ID with `DefaultAzureCredential`, managed identities in Azure, and least-privilege RBAC roles (for example, Cognitive Services OpenAI User and Search Index Data Reader) instead of API keys.
- **Model deployments as code:** SKU, capacity, pinned model version, version upgrade policy and content filter (`examples/foundry-cicd/deployments.bicep`).

**What "keeping it running" means: the checklist**
| Area | What to do |
|---|---|
| **Capacity** | Quota is measured in tokens per minute (TPM) and requests per minute (RPM), per subscription, region, model and deployment type. **Global Standard** has the highest quota and routes requests to any region. **Data Zone / Regional** keep data inside an area for residency. **Provisioned (PTU)** reserves throughput for steady, high volume and predictable latency, and can spill over to pay-as-you-go. |
| **Resilience** | Retry 429 (rate limited) and 529 / 503 (overloaded) with exponential backoff and jitter, and honour `retry-after`. Set timeouts. Fall back to another model or region (this lab sends the request once to `fallback_model()` after the SDK's retries run out). Use a circuit breaker so you stop hammering a service that is failing. Never retry 400s. |
| **Long-running work** | Run it in the background and stream progress to the client (this lab uses `Run` with NDJSON). Use queues and make steps idempotent so a retry can't do something twice. |
| **Observability** | OpenTelemetry traces using the **generative AI semantic conventions**, one span per model call and per tool call, sent to Application Insights or Foundry tracing. Track tokens, cost, latency (time to first token and total, p50 and p95), error rate, 429 rate, and refusal or `max_tokens` stops. Alert on all of them. Log transcripts, with PII handled properly. |
| **Quality** | An offline evaluation gate before every release, run on a golden set. Online evaluation on a sample of production traffic. Pin the model version, and treat a model upgrade or a prompt change as a release: evaluate it, then canary it. Keep prompts in git. Collect user feedback (thumbs up or down) as eval data. |
| **Safety** | Content Safety filters, Prompt Shields against injection, groundedness detection, sandboxed tool execution, human approval for anything that changes data, least privilege for tools, and rate limits per user. |
| **Cost** | A budget cap for each run and each user, Azure Cost Management budgets and alerts, and a cost-per-task dashboard. |
| **Hosting** | Container Apps or App Service with health probes. Use revisions for blue/green or canary releases, autoscale, and scale to zero for idle sandboxes. |
| **Lifecycle** | Watch the retirement dates of model versions. Test the replacement with the eval gate before the auto-upgrade does it for you. |

**Likely questions**
- **Q: How would you take an LLM prototype to production?**
  **A:** Infrastructure as code with keyless identity first. Then a golden evaluation set and a release gate in CI, so changes are measured instead of judged by eye. Then resilience: retries, fallbacks and timeouts sized to the quota. Then tracing and cost monitoring. Then safety: content filters, injection defences and human approval for risky actions. Finally a staged rollout. In my lab the pipeline signs in with OIDC, previews changes with what-if, provisions with azd and then fails the build if groundedness drops below the threshold.
- **Q: You're getting a lot of 429s in production. What do you do?**
  **A:** Check whether the limit being hit is TPM or RPM, and on which deployment. Short term: backoff with jitter that honours `retry-after`, plus a fallback deployment in another region or on another model. Medium term: ask for more quota, move to Global Standard, or buy PTU if the load is steady. Also reduce demand: cache prompts and answers, trim the context, and move background work to batch.
- **Q: How do you know the system is still giving good answers next month?**
  **A:** Pin the model version and run the same golden set on every change. Sample live traffic into online evaluations (groundedness, relevance, an LLM judge checked against human labels). Watch the drift signals: rising refusals, more thumbs-down, longer outputs. Alert when any of them moves.
- **Q: How do you secure an agent that can call tools?**
  **A:** Give it least-privilege identities and as few tools as it needs. Treat everything a tool returns as untrusted data, not instructions. Run code in a sandbox that can't reach the backend's credentials. Ask a human to approve writes and anything that can't be undone. Keep an audit log. In my lab, the coding agent's shell runs in an OS sandbox or a Docker or Azure dynamic session, never next to the backend's credentials.

## D. Running an open model locally
*Pages to open: [Live Claude](/live) · [Coding agent](/coding-agent) · [Hardware for AI](/hardware) · [Routing](/routing)*

**The short answer**
"I ran an open model, Qwen 3.5 9B quantised to 4-bit, on my MacBook with Docker Model Runner, which is built into Docker Desktop. One script, `tools/local-model.sh`, does the deployment: it turns on Model Runner on port 12434, pulls the model from Docker Hub, raises the context window to 32k for agent prompts, and sends a test request. On a Mac, Model Runner runs llama.cpp directly on the host with Metal, so the model uses the GPU, which an ordinary container can't reach. Model Runner serves the Anthropic Messages API, so the lab calls the local model with the same Anthropic SDK as Claude. One setting, `LLM_LAB_LOCAL_MODEL`, switches every page over, and it costs nothing per token."

**Key terms**
- **Docker Model Runner**: Docker Desktop's built-in server for open models. It runs llama.cpp, and serves both the Anthropic API (`/anthropic`) and the OpenAI API (`/engines/v1`) on port 12434.
- **Quantisation**: storing weights in fewer bits. At 4-bit, a 9B model is about 7 GB instead of about 18 GB at 16-bit, at some cost in accuracy.
- **Context size**: the number of tokens the server holds for one request. Agent prompts with instructions, tools and history need more than the default, so the script sets 32,768.
- **Keep-alive**: how long the model stays loaded in memory after the last request. The first request after that loads it again and takes a few seconds.
- **Constrained decoding (a grammar)**: llama.cpp forces each next token to fit a JSON schema, so structured output is valid by construction.

**How it's used**
- One client, `LabClient` in `python/local_model.py`, decides where each request goes. A local model name goes to `localhost:12434`, a GPT deployment to Azure OpenAI, and anything else to Claude. No page needs to know which model it's talking to.
- **Thinking off by default:** Qwen reasons before every answer unless told not to, which is slow and uses up the token limit. It's switched off unless a request asks for it.
- **Schemas:** the local Anthropic endpoint ignores JSON schemas, so requests that need one go to the OpenAI-compatible endpoint, where the grammar enforces them.
- **Claude-only features are refused, not dropped:** web search, code execution, files, MCP connectors and PDFs raise `NeedsClaude` with a clear message. Dropping them silently would change what a page is testing.
- It's priced at zero in the spend tracker, and the tests switch it off so they always see Claude.

**Questions they could ask**
- **Q:** Why run a model locally?
  **A:** No cost per token, nothing leaves the machine, and it works offline. That makes it good for development, for repeated experiments, and for data that can't be sent to an outside API.
- **Q:** What's the trade-off?
  **A:** Quality and speed. A 9B model is noticeably weaker than Claude or GPT-5 at long agent tasks and tool calling, and it's slower on a laptop. So I use it for development and side-by-side comparisons, not as the production model, and pages that need Claude-only features stay on Claude.
- **Q:** How would you deploy an open model in production?
  **A:** Not on a laptop. I'd host it on a GPU server behind an OpenAI-compatible inference server such as vLLM, which batches many users' requests to use the GPU efficiently, or use the open models that Microsoft Foundry hosts. Because my client already talks a standard API, the application code wouldn't change: only the base URL and the model name.
- **Q:** Why does the model need a GPU, and why couldn't it run in a normal container on a Mac?
  **A:** Generating each token reads all the weights from memory, so speed depends on memory bandwidth, and the GPU's is far higher than the CPU's. On a Mac, Docker containers run in a Linux VM that can't use the Metal GPU. Model Runner runs llama.cpp on the host instead, so it can.
- **Q:** How do you switch to a different model?
  **A:** Change one environment variable, `LLM_LAB_LOCAL_MODEL`, and rerun the script. Any model from Docker Hub's `ai/` namespace that can call tools works the same way, because the client doesn't depend on the model.
