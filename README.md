# LLM Lab

Hands-on pages that show how large language models and the systems around them work, each ending with the engineering decisions it should change. Every page runs real models or real arithmetic in your browser. A FastAPI backend adds live Claude calls.

This is the full-stack version: a **FastAPI** backend and a **React + TypeScript** frontend, kept separate. It started as a copy of the static site in `~/Dev/Transformer`, which stays as the simple version: plain HTML files you can open from disk.

```
llm-lab-app/
├── backend/     FastAPI: the /api routes, the spending cap, and serving the built frontend
├── frontend/    React + TypeScript, built with Vite: one route per lab
├── python/      runnable lesson scripts (01 to 18), a sample skill, and the shared prices, settings and data
├── tools/       rebuilds the 134 MB GPT-2 model with its internals exposed
├── examples/    copyable Claude Code setup: CLAUDE.md, skills, hooks, a subagent, a plugin
└── models/      the local GPT-2 model (not in git)
```

## Start

All commands run from the `llm-lab-app` folder. You need Python 3.10 or newer and Node.js 20 or newer. On a Mac, use `python3` until the virtual environment is active.

### One-time setup

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
pip install -r python/requirements.txt   # optional: the embedding library for python/05_rag.py
python -m backend --budget 1

cd frontend
npm install
npm run dev
npm run build
cd ..
```

Put your Anthropic API key in a file named `.env` in this folder, as described under [Live Claude features](#live-claude-features).

The tutor's three people, each with their own face and voice, are 3D models too large for git. Download them once:

```sh
for f in mpfb avaturn avatarsdk; do
  curl -L -o frontend/public/avatars/$f.glb https://raw.githubusercontent.com/met4citizen/TalkingHead/main/avatars/$f.glb
done
```

All three come from the [TalkingHead](https://github.com/met4citizen/TalkingHead) project. Sonia (`mpfb.glb`, made with MPFB) is CC0, free for any use. Ava (`avaturn.glb`, made with Avaturn) and Ryan (`avatarsdk.glb`, made with Avatar SDK) are licensed for non-commercial use only, so replace them before using the tutor for anything commercial. The tutor's voice also needs Azure Speech: see [The tutor's voice](#the-tutors-voice).

### Run it

```sh
source .venv/bin/activate
python -m backend --budget 1
```

Open http://localhost:8000. The backend serves the React app and the API from one address. `--budget 1` stops live calls once this run has spent about $1. Press Ctrl+C to stop.

The API documentation is at http://localhost:8000/docs.

### While you change the code

Run the backend and the Vite dev server side by side:

```sh
# terminal 1
source .venv/bin/activate
python -m backend --budget 1 --reload      # restarts when Python code changes

# terminal 2
cd frontend
npm run dev                                 # http://localhost:5173, updates as you save
```

Open http://localhost:5173. Vite forwards `/api` and `/models` to the backend. Run `npm run build` again when you want port 8000 to serve your changes.

### Tests

```sh
pytest backend                         # API tests against a fake Claude client: no key, no cost
cd frontend && npm run typecheck       # TypeScript
cd frontend && npm run build           # type-check and production build
```

### Troubleshooting

| Message | Fix |
|---|---|
| `zsh: command not found: python` | Use `python3`, or activate the environment first with `source .venv/bin/activate`. |
| `error: externally-managed-environment` | You ran `pip` outside the virtual environment. Activate it first. |
| `ModuleNotFoundError: No module named 'fastapi'` | Activate the environment, then `pip install -r backend/requirements.txt`. |
| `The frontend is not built yet` at http://localhost:8000 | Run `npm run build` in `frontend/`, or use the dev server at http://localhost:5173. |
| `Port 8000 is in use by another program` | Something other than the lab holds the port. Stop it, or run `python -m backend --port 8080` and open http://localhost:8080. An earlier lab backend on the port is stopped for you, even one paused with Ctrl+Z. Stop the backend with Ctrl+C; Ctrl+Z only pauses it. |
| `Port 5173 is in use` | Another Vite server is running. Stop it, or start this one with `LLM_LAB_DEV_PORT=5174 npm run dev` and the backend with `LLM_LAB_DEV_PORT=5174 python -m backend`. |
| Live pages say the backend is not running | Start it with `python -m backend`. In development both servers must be running. |
| Live pages say "no API credentials" | Check `.env` exists in this folder with your key, then restart the backend. |
| Live pages say the budget was reached | Restart the backend. Raise `--budget` only if you mean to spend more. |
| "GPT-2 full internals" is greyed out | The model is not in `models/gpt2-explainer/`. Copy it from the old project or rebuild it: see `tools/README.md`. |
| Old colours or text after an update | Press Cmd+Shift+R. The backend tells browsers to recheck pages, and built files get new names when they change. |

## How it fits together

```
browser ──► FastAPI backend :8000 ──► Claude API      (your API key stays here)
   │            └─ serves frontend/dist and models/
   └──► Hugging Face, through jsDelivr: transformers.js and the small browser models
```

In development, the Vite dev server on :5173 serves the pages and forwards `/api` and `/models` to the backend.

### Backend

| Route | What it does |
|---|---|
| `GET /api/status` | Whether credentials were found, the models, prices, and spend so far |
| `GET /api/sample/handbook` | The sample handbook used by the caching demos |
| `POST /api/count_tokens` | Counts tokens with Claude's tokenizer. Free, so not subject to the budget |
| `POST /api/messages` | One Messages API call. `max_tokens` is capped at 16,000 |
| `POST /api/stream` | A streamed call, returned as newline-delimited JSON: `text` lines, then `done` or `error` |

The code is in `backend/app/`, in layers:

- `api/`: thin routes, one module per area (`status`, `messages`, `agents`). Each parses the request, calls a service and shapes the response. `api/deps.py` hands the routes their services and holds the two guards: lab pages only, and the spending cap.
- `services/`: the work. `SpendTracker` charges every reply, `StatusService` and `MessagesService` serve the single-call pages, `HarnessService` and `SkillsService` run the lesson scripts 11 and 12 live, streaming their events through `RunStreamer`, and `DeckService` runs the deck builder: a conversation that uploads your files into Claude's container and builds a PowerPoint deck with the pptx skill. Claude cannot see images in the container, so after each deck it renders the slides to PNG, the backend sends back the slides whose image changed since Claude last checked them, and Claude checks spacing, alignment and overflow and fixes what it finds, up to two rounds, before you get the deck.
  `SiteService` runs the site builder: Claude writes a website into `sites/<id>/site/` on this server through five file tools that cannot leave that folder, and runs no commands. Each file streams to the page as it is written, the backend serves the site sandboxed at `/sites/<id>/` for the preview, and when Claude finishes, headless Chrome screenshots it at 1280 and 390 pixels wide so Claude can fix what it sees, up to two rounds. Sites and their conversations are saved under `sites/`, which git ignores. Any site can be put back as it was before one of its messages: the backend replays the file changes recorded in the conversation up to that point, and moves the replaced files to `sites/<id>/backups/`.
  `DocumentService` runs document automation the way legal document tools do it. Assembly is deterministic: docxtpl fills a Word template's `{{ fields }}`, `{%p if %}` clauses and `{%p for %}` repeats from the interview's answers. Claude works around it with structured outputs a person confirms: it turns a finished document into a template (fields and optional clauses), fills the interview from source documents with a quote and confidence for each answer, and checks the assembled document. Sample files are built in code, in `services/document_samples.py`.
  `TutorService` runs the tutor. For English it streams a short spoken reply while a second call returns corrections, vocabulary and a level estimate as structured JSON. For any other subject it streams one answer in two parts, a few sentences the avatar says and a written, line-by-line explanation, and it reads pictures the learner shares.
- `gateways/claude.py`: the only code that touches the Anthropic SDK. Services depend on its small protocols, so tests swap in a fake client.
- `gateways/azure_speech.py`: the only code that signs in to Azure, with a key or with your Azure login, to give the tutor page a short-lived Speech token.
- `gateways/browser.py`: screenshots for the site builder, from Chrome driven over the DevTools protocol so it can emulate a phone and collect console errors. It finds Chrome, Chromium, Edge or Brave in the usual places; set `LLM_LAB_CHROME` to its path if yours is elsewhere. Without one, sites are built without the screenshot check.
- `container.py` builds the services once and wires them together; `schemas.py` holds the request bodies; `core/errors.py` turns SDK failures into readable API errors; `settings.py` holds the limits; `main.py` builds the app and serves the frontend. Model prices and the refusal-fallback routing live in `python/common.py`, and every environment variable is read in `python/settings.py`, both shared with the lesson scripts, so there is one copy.

Protections, all tested in `backend/tests/`:

- It listens on 127.0.0.1 only.
- POST routes need the `X-LLM-Lab` header and a localhost `Host` and `Origin`. Other websites cannot call it, because the header forces a browser preflight that the backend never approves.
- Unknown request fields are dropped, and the model must be one of the three listed.
- It stops making calls once the estimated spend reaches `--budget`.

### Frontend

```
frontend/src/
├── main.tsx, App.tsx            routes: one per lab, plus redirects from old /page.html links
├── components/                  Layout, Nav, CodeBlock
├── lib/
│   ├── site.ts                  helpers the page scripts use: model loading card, tooltips, formatting
│   ├── useEngine.ts, lifecycle.ts   start a page's script, and stop it when you leave
│   ├── theme.ts                 auto, dark and light
│   └── gpt2.js, embedder.js, reranker.js   browser models
├── services/                    every call to the backend, through one axios client
│   ├── apiClient.ts             ApiClient: the lab header, errors with the server's message, NDJSON streams
│   └── statusService.ts, messagesService.ts, harnessService.ts, skillsService.ts, sampleService.ts
└── pages/
    ├── registry.ts              every page: route, title, nav label, group
    └── <page>/
        ├── <Name>Page.tsx       the page's markup in JSX
        ├── <page>.css           its styles, scoped under .page-<page>
        ├── engine.js            its interactive parts: simulations, charts, models (new parts are TypeScript)
        └── snippets.ts          its code samples
```

Each page is a React component. Its markup, text and code samples are JSX, and the nav, routing, theme and code blocks are React components. The simulations, SVG charts and model inference came across from the original site as plain JavaScript modules: each `engine.js` exports `mount(root, life)`, which `useEngine` calls once the page is on screen. `life` gives the script timers and listeners that all stop when you navigate away, so nothing from one page keeps running on the next. The page component never re-renders, so React never redraws over what the script has drawn.

Each page's CSS is scoped under its root class, `.page-<page>`, so pages cannot restyle each other in the single-page app. The transformer explainer uses `body.tx` instead, because it has its own full-screen layout.

### Adding a page

1. Create `frontend/src/pages/<id>/<Name>Page.tsx` with a `<main className="page-<id>">` root.
2. Add it to `PAGES` in `frontend/src/pages/registry.ts` with its route, title, nav label and group. The nav and routes pick it up from there.
3. For interactive parts, either use React state directly or write an `engine.js` with `mount(root, life)` and call `useEngine(rootRef, mount)`. Use `life.on(...)`, `life.setTimeout(...)` and `life.requestAnimationFrame(...)` for anything on `document`, `window` or a timer.

## The labs

| Group | Route | What it shows | Downloads |
|---|---|---|---|
| Foundations | `/transformer` | Animated transformer. Tiny model, GPT-2 probabilities, or GPT-2 with every internal value real | Optional: 128 MB, or the 134 MB local model |
| | `/building` | How LLMs are built: data cleaning, scaling laws, fine-tuning, preference tuning, training memory | GPT-2, 128 MB, for two demos |
| | `/training` | Train a tiny language model live; watch it learn, overfit and memorise | None |
| | `/tokens` | Tokenizer playground, formats by token count, context budget | 2 MB tokenizer |
| | `/sampling` | Greedy against sampled decoding, confidence per token | GPT-2, 128 MB |
| | `/ml` | Seventeen machine learning algorithms, each running live, with when to use them and where they appear in AI | None |
| | `/course` | The LLM course: Stanford CME 295's eight lectures in order, with "What is GPT" as lecture 0, each linked to the labs that teach it | None |
| | `/what-is-gpt` | What is GPT: Microsoft's explainer made hands-on with live GPT-2, corrected where the source is wrong | GPT-2, 128 MB |
| | `/transformer-tricks` | RoPE, RMSNorm, MQA/GQA, sliding windows, FlashAttention, mixture of experts, speculative decoding | None |
| | `/training-at-scale` | LoRA trained live, training memory, data/tensor/pipeline parallelism and ZeRO | None |
| | `/preference-tuning` | Reward models, PPO clipping, reward hacking and the KL penalty, DPO | None |
| | `/reasoning-models` | GRPO live, verifiable rewards, pass@k and majority voting, thinking budgets | None |
| | `/vision` | Images as tokens: a picture (or your own) cut into patches, flattened, projected into tokens, given positions and attention, and joined with text; measured image token costs for Claude and GPT | None |
| | `/hardware` | CPU, GPU, TPU, NPU, LPU and DPU: your CPU raced against your GPU (WebGPU), a systolic array multiplying, tokens per second from memory bandwidth for real chips, quantisation, and DPU offload | None |
| | `/deep-learning` | The 29 notebooks of *Understanding Deep Learning* (Simon J. D. Prince) as interactive demos: networks, losses, optimisers, backpropagation, initialisation, residual networks, attention, graphs | None |
| Building | `/prompting` | Few-shot measured on a test set, constrained decoding, prompt injection | GPT-2, 128 MB |
| | `/embeddings` | Meaning map, RAG with embeddings, BM25 and hybrid search, plus a reranker | 23 MB, plus 24 MB reranker |
| | `/agents` | Tool-use loop step by step: parallel calls, errors, approval | None |
| | `/context-engineering` | What to put in each request, ordering for caching, long conversations, tool output | None |
| | `/harness` | Autonomous agents: watch one work until done, and switch off harness features to see what breaks | None |
| | `/mcp` | MCP servers: a real server in the backend; raw requests with and without tokens, Claude using its tools with writes gated by the harness | Needs the backend |
| | `/casework` | Case handling on Azure: multi-agent complaint handling with Azure OpenAI and Azure AI Search, groundedness and rule checks, caseworker approval, a hash-chained audit trail and an evaluation gate | Needs the backend, Azure OpenAI and Azure AI Search |
| | `/medassist` | MedAssist on Foundry: a patient portal chat with a Microsoft Foundry prompt agent that reads the signed-in patient's record, shows free slots, books the one they choose and texts them, beside the practice's systems (record, appointments, texts, audit log) | Needs the backend and a Foundry project with the agent created (`examples/medassist`) |
| | `/claude-code` | Claude Code setup: CLAUDE.md, skills, hooks, subagents and plugins, with best practices | None |
| | `/claude-code-inside` | Claude Code behind the scenes: an animated, step-by-step tour for presenting, from `/init` to rewind. Press P for presenter mode | None |
| Quality and safety | `/evals` | Test sets, three kinds of grader, confidence intervals, run-to-run variance | GPT-2, 128 MB |
| | `/confidence` | Calibration, reliability diagrams, routing doubtful answers to a person | GPT-2, 128 MB |
| | `/benchmarks` | What benchmarks test, pass@k, significance, contamination, Elo and Bradley–Terry arenas | None |
| | `/injection` | Attack a toy agent and see which defences hold | None |
| Cost and operations | `/context` | Prefill and decode, KV cache memory, conversation cost with caching | None |
| | `/routing` | Large, small, cascade or router, compared on cost per correct answer | None |
| | `/resilience` | Rate limits: ten minutes of traffic against rate-limited deployments, with backoff, failover, a smaller model, a circuit breaker and a region outage | None |
| | `/live` | Real Claude calls: latency, tokens, effort, caching and cost | Needs the backend and an API key |

Models load from Hugging Face through transformers.js 4.3.0 on jsDelivr the first time a page needs them, and the browser caches them.

## Live Claude features

Live calls use your Anthropic API key. You create it in Anthropic's developer console. The key stays in the backend and is never sent to the browser.

Put it in a file named `.env` in this folder. Git ignores this file, so the key is never committed:

```sh
umask 077 && echo 'ANTHROPIC_API_KEY=your-key-here' > .env
```

A key exported in your shell with `export ANTHROPIC_API_KEY=...` takes priority over the file. Never paste a key into chats, documents or code. If one has been shared, create a new key in the console, delete the old one, and update `.env`.

### The tutor's voice

The tutor (Lab 21) speaks and listens with Azure Speech. Without it, the tutor writes instead of speaking. The backend signs in to Azure in one of two ways; the browser only ever gets a 10-minute token.

- **With your Azure login (no key).** Add the region and the resource ID of an Azure AI Services or Speech resource to `.env`, and sign in with `az login`. Your account needs the **Cognitive Services Speech User** role on that resource; being its Owner is not enough. The resource must have a custom domain.

  ```sh
  AZURE_SPEECH_REGION=uksouth
  AZURE_SPEECH_RESOURCE_ID=/subscriptions/…/resourceGroups/rg-llm-lab/providers/Microsoft.CognitiveServices/accounts/ai-llm-lab-…
  ```

  Optionally, add `AZURE_SPEECH_FALLBACK_RESOURCE_ID` for a second resource. The tutor uses the first one and switches to the fallback for the rest of the session only when Azure refuses a request, for example when a free tier's monthly allowance or its requests per minute run out.

  The lab's own resources are in the resource group `rg-llm-lab` (UK South) in the FootballHackathon subscription, tagged `project=llm-lab`: `speech-llm-lab-knx5wa`, a free-tier (F0) Speech resource used first, and `ai-llm-lab-0eevth`, a paid AI Services resource as the fallback. Keys are switched off on both. A £5 monthly budget, `llm-lab-monthly`, emails the resource group's owners at 80% and 100% of actual spend, and when spending is forecast to pass £5.

- **With a key.** Set `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` instead, for a resource that allows keys.

Azure bills the voice by the character spoken and the listening by the hour of audio, on the resource's own subscription; pronunciation scores cost the same as listening. In UK South, pay-as-you-go, that is £11.32 per million characters and £0.75 per hour, or about £0.25 for a half-hour lesson. The free tier covers 5 hours of listening and 500,000 characters a month. Listening is charged for as long as the microphone is open, so press Done when you have finished speaking.

### Case handling on Azure

The case-handling lab (`/casework`) runs on Azure only: the GPT deployment above for every agent, `text-embedding-3-small` in the same Foundry resource for embeddings, and Azure AI Search for the council's policies. The search service, `srch-llm-lab-kvpjs7`, is on the free tier in `rg-llm-lab`, with keys switched off and the semantic ranker on its free plan. Your account needs **Search Service Contributor** and **Search Index Data Contributor** on it. The lab creates its index, `casework-policies`, on first use.

```sh
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-small
AZURE_SEARCH_ENDPOINT=https://srch-llm-lab-kvpjs7.search.windows.net
```

A case costs about 2 to 4 cents and takes about 30 seconds; the release-gate evaluation runs all five cases, about 13 cents. The audit log is written to `casework/audit.jsonl`, which git ignores.

The MedAssist lab (`/medassist`) talks to the `MedAssist` prompt agent in the Foundry project named by `FOUNDRY_PROJECT_ENDPOINT` (`FOUNDRY_MODEL` is its model, for pricing). Create the agent first with `python examples/medassist/medassist.py create`. Your account needs the **Foundry User** role on the Foundry resource. The agent's function tools run in the backend against the example's SQLite database, `examples/medassist/data/medassist.db` (ignored by git), so the page and the example's command line see the same bookings. A booking conversation costs well under a cent in model tokens; File Search and the Code Interpreter are charged separately by Azure.

### GPT in the document automation lab

Document automation (Lab 22) can use a GPT model in Azure AI Foundry for each of its AI steps instead of Claude, with the same prompts and schemas, to compare the two. Pick it under **GPT (Azure AI Foundry)** in the page's model list. Other pages use Claude only.

```sh
AZURE_OPENAI_ENDPOINT=https://ai-llm-lab-0eevth.openai.azure.com
AZURE_OPENAI_DEPLOYMENTS=gpt-5.4-mini
```

The deployment `gpt-5.4-mini` (Global Standard) is in the same Foundry resource as the speech fallback, `ai-llm-lab-0eevth`, in its project `llm-lab`. Keys are off, so the backend signs in with `az login`; your account needs the **Cognitive Services OpenAI User** role on the resource. It is billed per token on the subscription, at $0.75 per million input tokens and $4.50 per million output tokens, and counts against the backend's `--budget` like Claude.

Live features use Claude Haiku 5.5 by default, where each action costs a small fraction of a cent. The Live page lets you pick Claude Sonnet 5.5 or Claude Opus 5.5 instead, which cost more. The backend logs the estimated cost of every call, and the Live page shows the running total. Your Anthropic console shows the exact amount billed.

## Other folders

- `python/`: runnable scripts for each lab. See `python/README.md`.
- `tools/`: rebuilds the GPT-2 model with its internals exposed. See `tools/README.md`.
- `examples/mcp/`: an MCP server in Python (tools, a resource, a prompt; stdio and authenticated Streamable HTTP), used from Claude Code, from your own harness with approvals, and through the Claude API's MCP connector. Its README covers the design decisions.
- `examples/sdks/`: the same five tasks (structured output, tools, MCP, an agent with human approval, multi-agent) in nine SDKs: OpenAI, OpenAI Agents, Claude, Microsoft Agent Framework, Semantic Kernel, AutoGen, LangChain, LangGraph and CrewAI, each in its own environment, with a comparison cheatsheet.
- `examples/agent-framework/`: the case-handling flow from Lab 25 rebuilt in Microsoft Agent Framework (Python), run in DevUI: typed agents, `@tool` systems of record, a workflow graph with a revision loop, and a human approval pause.
- `examples/medassist/`: MedAssist, a patient portal agent built as a Microsoft Foundry prompt agent: File Search over practice documents, the Code Interpreter, and function tools that read a signed-in patient's record and book or cancel appointments in a dummy SQLite database, with the safety rules enforced in code and nine checked test cases.
- `examples/agents/`: three more Foundry prompt agents, one per common use case: SalesDesk (leads, scoring, follow-ups, calls), ResearchDesk (monitoring, cited reports) and DayPlanner (calendar, inbox, to-do list), each with a dummy database, its rules enforced in its tools, and six checked test cases.
- `examples/claude-code/`: copyable CLAUDE.md, skills, hooks, a subagent and a plugin for the Claude Code labs. They are stored under names Claude Code does not load; the folder's README says where each one goes.

## What has been tested

- All 20 pages in headless Chrome, on the production build served by FastAPI and on the Vite dev server, with no JavaScript or React errors. That includes moving through every page inside the app without a reload, then pressing the keys pages listen for, to check nothing from a previous page keeps running.
- The backend, with 115 tests against fake Claude, Azure, Foundry and browser clients, so they need no network, key or credit: routing to the fallback endpoint, streaming, the spending cap, request validation, the protections against other websites and serving the frontend, plus the harness and skills runs, the deck builder, the site builder, the tutor, document automation, the MCP lab, case handling and MedAssist.
- Live features against a local mock of the Claude API. No real API calls were made while building this version.

## Sharing

`npm run build` produces static files in `frontend/dist/`. The labs that need no backend work from any static host that sends every path to `index.html`. The live features and the full GPT-2 explainer need the backend.

Prices and model facts on the pages reflect Anthropic's documentation as of October 2026. Check the pricing page before relying on them.
