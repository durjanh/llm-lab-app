# LLM Lab

Hands-on pages that show how large language models and the systems around them work, each ending with the engineering decisions it should change. Every page runs real models or real arithmetic in your browser. A FastAPI backend adds live Claude calls.

It has a **FastAPI** backend and a **React + TypeScript** frontend, kept separate.

```
llm-lab-app/
├── backend/     FastAPI: the /api routes, the spending cap, and serving the built frontend
├── frontend/    React + TypeScript, built with Vite: one route per lab
├── python/      runnable lesson scripts (01 to 18), a sample skill, and the shared prices, settings and data
├── tools/       rebuilds the 134 MB GPT-2 model with its internals exposed
├── examples/    copyable Claude Code setup: CLAUDE.md, skills, hooks, a subagent, a plugin
├── docs/        the architecture diagram below
└── models/      the local GPT-2 model (not in git)
```

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture-dark.png">
  <img alt="The LLM Lab's architecture: lab pages, scripts and phones on the left; this machine in the middle, with the FastAPI backend (guards, services, spend tracker, local data, gateways, coding agent), the model client, the local model in Docker Model Runner, tokenizers, headless Chrome and the sandbox; Anthropic's Claude API and Microsoft Foundry (GPT deployments, prompt agents, Agent Framework, Foundry Tools) on the right; and the Azure platform along the bottom (AI Search, Speech, Communication Services, Event Grid, Functions and Storage, Container Apps, Entra ID), with an arrow for each call." src="docs/architecture.png">
</picture>

Every page and script reaches a model through one client, `python/local_model.py`, which sends each request to Claude, to a GPT deployment in Microsoft Foundry, or to an open model on this machine, by the model's name. Foundry agents, the Azure AI services and the phone line are reached through the backend's gateways, all signed in with Entra ID. The same diagram is interactive at `/architecture`: select a component to see where it runs and its files, or choose a path to follow its requests. `/medassist/architecture` does the same for MedAssist, and `/building-agents` and `/local-model` show the code behind it.

The images are screenshots of `/architecture` in the light and dark themes. After changing `frontend/src/pages/lab-architecture/diagram.ts`, take them again from the running page.

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

### After restarting the machine

Two things run in Docker beside the backend, each from its own script. The first time, set each one up as its section below says: [A local open model, at no cost per token](#a-local-open-model-at-no-cost-per-token) and [Skills and decks without Claude's container](#skills-and-decks-without-claudes-container). The lab's `/local-model` page walks through the same steps and shows whether your model is configured, running and pulled.

| What | Script | Where | After a restart |
|---|---|---|---|
| The local model (Qwen 3.5 9B), the default where the work allows | `./tools/local-model.sh` | Docker Model Runner, on the Mac itself, `localhost:12434` | Run the script again: it sets the 32k context the agent pages need, and checks the model answers |
| The sandbox, where the coding agent's commands and the local model's and GPT's skills and decks run | `./tools/sandbox.sh` | A container, `127.0.0.1:8099` | Starts by itself with Docker Desktop. Run the script only the first time, or with `--rebuild` after changing the image |

`sandbox.sh` does not start the model. The model cannot run in a container on a Mac, because a container cannot reach the GPU, so Model Runner runs it on the host.

In order:

```sh
# 1. open Docker Desktop and wait until it says it is running
./tools/local-model.sh                     # 2. "Model says: Ready."
source .venv/bin/activate
python -m backend --budget 1 --reload      # 3. then the frontend, as above
```

Only for real phone calls (Aftercare and MedAssist), also start the tunnel in its own terminal: `ngrok http 8000`. Without a fixed ngrok domain its address changes each time, so put the new one in `.env` as `AFTERCARE_CALLBACK_URL` and restart the backend (`examples/aftercare/README.md`, "A real call to your phone").

To check what is running:

```sh
docker ps --filter name=llm-lab-sandbox     # the sandbox container, "Up"
curl -s http://127.0.0.1:8099/health        # {"status": "ok", "delta": 2}
docker model status                         # Model Runner is running
grep '^LLM_LAB_SANDBOX' .env                # docker: the local sandbox; sessions: the one in Azure
```

With `LLM_LAB_SANDBOX=docker`, a run on your machine uses the local container, never the Azure one, even though `LLM_LAB_SESSIONS_ENDPOINT` stays in `.env` for `LLM_LAB_SANDBOX=sessions`. If either is not running, the pages that need it say so and name the script to run.

### After changing something: what to rebuild

| You changed | Do this |
|---|---|
| Python in `backend/` or `python/` | Nothing with `--reload`: the backend restarts itself. Without it, Ctrl+C and start it again. |
| `.env` | Restart the backend. `--reload` does not watch `.env`. |
| The frontend (`frontend/src/`) | Nothing on the dev server (:5173). For port 8000: `cd frontend && npm run build`. |
| A skill (`python/skills/`) | Nothing. Its scripts travel with each command, so no image needs rebuilding. |
| The sandbox image (`examples/coding-sandbox/`: `Dockerfile`, `server.py`, `extra-*.txt`) | On your machine: `./tools/sandbox.sh --rebuild`. In Azure: `TAG=<n> examples/coding-sandbox/publish-image.sh`, then `IMAGE=ghcr.io/<you>/coding-sandbox:<n> examples/coding-sandbox/setup-app.sh`. Use a new tag each time, so the app starts a new revision (`examples/coding-sandbox/README.md`). |
| The reminders Function (`examples/medassist/reminders/`) | `examples/medassist/setup-texts.sh` again: it redeploys the code and leaves the rest as it is. With azd, `azd deploy reminders`. |
| Azure resources (`infra/`) | `azd provision`, or push to main, where `.github/workflows/infra.yml` runs it. |
| The local model (`LLM_LAB_LOCAL_MODEL`) | `./tools/local-model.sh` (it pulls the new one), then restart the backend. |
| The full-internals GPT-2 (`models/gpt2-explainer/`) | See `tools/README.md`. |

Then run the tests: `pytest backend` and `cd frontend && npm run typecheck`.

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
| Revise | `/bible` | The Bible: every page's key terms, the questions people ask about them and short answers, opening with temperature and top-p, saving tokens and running AI in production; searchable, each section linked to its page. In the nav beside Home | None |
| | `/architecture` | The whole lab's architecture on one diagram: the pages and scripts, the backend (guards, services, spend tracker, gateways), the model client that sends each request to Claude, a GPT deployment in Microsoft Foundry or the local model, the Foundry agents and tools, and the Azure services, with the official Azure icons. Select a component to see where it runs and its files; choose a path to follow its requests. In the nav beside Bible | None |
| Foundations | `/transformer` | Animated transformer. Tiny model, GPT-2 probabilities, or GPT-2 with every internal value real | Optional: 128 MB, or the 134 MB local model |
| | `/roadmap` | A GenAI engineering roadmap in three levels (beginner, intermediate, advanced), each topic linked to the lab pages that explain or build it | Static |
| | `/building` | How LLMs are built: data cleaning, scaling laws, fine-tuning, preference tuning, training memory | GPT-2, 128 MB, for two demos |
| | `/training` | Train a tiny language model live; watch it learn, overfit and memorise | None |
| | `/tokens` | Tokenizer playground, formats by token count, context budget | 2 MB tokenizer |
| | `/token-counter` | Paste a prompt (and a system prompt) and pick a model, grouped by provider: Claude (current and earlier), GPT, Gemini, Llama, Mistral, Qwen, DeepSeek and the local model. Shows the tokens, the request total with framing, the cost per call, characters and words, the share of the context window, and the text coloured token by token where the tokenizer is published (run on the backend from Hugging Face, `generated/tokenizers/`, about 90 MB once). Claude's tokenizer is not published, so its view counts the prompt word by word with `count_tokens`. Each model is marked exact or estimate (Gemini: Gemma 2's tokenizer). "Every model, side by side" compares them all. Counting is free | None; Claude needs an API key, and the open tokenizers download on first use |
| | `/sampling` | Greedy against sampled decoding, confidence per token | GPT-2, 128 MB |
| | `/atoms-touch` | A short film drawn by the page (three.js, or a flat cross-section without WebGL): two fingertips close in while the gap halves 25 times, from 10 mm to 298 pm, through skin ridges, cells, molecules and atoms; a force-against-distance chart follows the film. Explains why the push is the Pauli exclusion principle rather than plain charge repulsion | None |
| | `/ml` | Seventeen machine learning algorithms, each running live, with when to use them and where they appear in AI | None |
| | `/course` | The LLM course: Stanford CME 295's eight lectures in order, with "What is GPT" as lecture 0, each linked to the labs that teach it | None |
| | `/what-is-gpt` | What is GPT: Microsoft's explainer made hands-on with live GPT-2, corrected where the source is wrong | GPT-2, 128 MB |
| | `/transformer-tricks` | RoPE, RMSNorm, MQA/GQA, sliding windows, FlashAttention, mixture of experts, speculative decoding, continuous batching and PagedAttention (both simulated), and a sourced table of ways to make a model faster: what each improves (memory, latency or throughput), a published figure, the catch and whether an API user can use it, with a fact-check of a popular infographic | None |
| | `/training-at-scale` | LoRA trained live, training memory, data/tensor/pipeline parallelism and ZeRO | None |
| | `/preference-tuning` | Reward models, PPO clipping, reward hacking and the KL penalty, DPO | None |
| | `/reasoning-models` | GRPO live, verifiable rewards, pass@k and majority voting, thinking budgets | None |
| | `/vision` | Images as tokens: a picture (or your own) cut into patches, flattened, projected into tokens, given positions and attention, and joined with text; measured image token costs for Claude and GPT | None |
| | `/hardware` | CPU, GPU, TPU, NPU, LPU and DPU: your CPU raced against your GPU (WebGPU), a systolic array multiplying, tokens per second from memory bandwidth for real chips, GPU kernels on a roofline (memory-bound or compute-bound), kernel fusion and tiled attention, quantisation, and DPU offload | None |
| | `/deep-learning` | All 68 notebooks of *Understanding Deep Learning* (Simon J. D. Prince) as interactive demos, chapters 1 to 21, plus an encoder/decoder extra (12.5) | None |
| | `/deep-learning-book` | *Understanding Deep Learning* chapter by chapter: what each offers, every worked example (linked to the notebook demos, with new demos where they add something), where each idea lives in an LLM; then research on making LLMs faster, cheaper and better: a what-if serving estimator and sourced evidence cards | None |
| Building | `/prompting` | Few-shot measured on a test set, constrained decoding, prompt injection | GPT-2, 128 MB |
| | `/embeddings` | Meaning map, RAG with embeddings, BM25 and hybrid search, plus a reranker | 23 MB, plus 24 MB reranker |
| | `/store-watch` | A loss-prevention desk on a live webcam (with a camera picker) or an uploaded video file. In the browser, MediaPipe finds each person's pose and the items near their hands (EfficientDet-Lite0), code tracks them with stable ids and draws boxes, skeletons, hands and zones; rules in code follow each visit past editable shelf, till and exit zones (picked up, put back, possible concealment at the body or into a bag, paid at the till, left by the exit without paying, long dwell) into a live event feed and per-person visit strips. The behaviour model on Azure OpenAI is asked only when a rule raises suspicion (plus a slow look at anyone carrying an item), with a burst of frames (faces blurred first unless switched off) and the tracker's events as leads to check, never as sightings; without it, the rules score alone. Each alert carries an 8 to 15 second clip with the overlays, recorded by two staggered MediaRecorders and kept as a file in `generated/storewatch/clips` (deleted with the alert's footage). A named person confirms with one click; a door camera on the same video compares faces with the live watchlist and shows both faces with the score. Live stats, an alert sound and a red flash, a watchlist gallery, retention and an audit log; it opens in demo mode, with governance optional. The scripted day (invented people) still runs without a camera | About 12 MB of pose and item models, 7 MB face model for faces; Azure OpenAI for the behaviour model (optional) |
| | `/workflows` | Every kind of agent workflow on Microsoft Agent Framework: sequential, concurrent, handoff, group chat, maker-checker, Magentic, orchestrator and workers, fan-out/fan-in and routing edges, plan-approve-run, checkpoint and resume, sub-workflows, declarative YAML. Diagrams read from the built workflow; replay real recorded runs free, or run live on Azure (`examples/agent-framework/workflows/`) | None; live runs need Azure OpenAI and `pip install -r examples/agent-framework/requirements.txt`; the YAML one needs its own Python 3.12 `.venv` and a .NET runtime |
| | `/agents` | Tool-use loop step by step: parallel calls, errors, approval | None |
| | `/planning-patterns` | ReAct and planning patterns: one task run four ways at once (a plain tool loop, ReAct with a written Thought before each action, plan and execute with a replanner after a failed step, and reflexion with a critic and one retry), each streamed live with its trace, calls, tokens, time and cost. The tools work on an invented shop (products, orders, policies, a fixed "today", and a warehouse system that fails the first stock check on one task), so code marks every answer against the known right one. Each pattern stops at a step cap (14 model calls, 24 for plan and execute) and the run at its budget | Needs the backend; paid |
| | `/building-agents` | Building agents as ordinary software, in the lab's own code: the Messages API request and response, a tool's JSON schema, the same loop written four ways (Claude API by hand, a harness, Agent Framework, Foundry's Responses API), MedAssist's rules as code, testing against the database, and the AI terms in developer words | None |
| | `/agent-types` | Thirteen types of agent (reflex, LLM, tool-using, planning, memory, multi-agent, hierarchical, self-improving, RAG, code, web browsing, computer use, autonomous): what each is for, when not to use it, and where each is built in the lab, with the command that runs it. Six are lesson scripts made for it, `python/20` to `25`; the browsing and computer use agents drive headless Chrome with Claude's browser and computer toolsets (`python/chrome_driver.py`) | None; the scripts need an API key, and 24 and 25 need Chrome and `websockets` |
| | `/context-engineering` | What to put in each request, ordering for caching, long conversations, tool output | None |
| | `/harness` | Autonomous agents: watch one work until done, and switch off harness features to see what breaks | None |
| | `/coding-agent` | Coding agent: a harness built the way Claude Code is, working on a small project with failing tests. File tools that refuse blind edits, a shell behind deny and allow rules, four permission modes, hooks, `CLAUDE.md`, a to-do list, checkpoints you can undo, a read-only sub-agent, context clearing, eyes (`read_file` returns images; `screenshot` renders a page in headless Chrome so the agent checks what it built), a sandboxed auto mode that asks nothing, and a Stop hook that sends the agent back until the tests pass. The hand-built harness also runs on a GPT deployment (`gpt-5.4-mini`), translated to Chat Completions with the same tools and sandbox; the Agent SDK version is Claude only. Your files is a second workspace: add a spreadsheet (or try the invented sample workbook) and ask for a summary with charts, or a PowerPoint; the agent installs what it needs, looks at its own charts and slides, and you download the results. Each edit's diff waits for your approval. The same task also runs on the Claude Agent SDK, to compare | Needs the backend; the SDK version needs `examples/claude-agent-sdk` installed |
| | `/mcp` | MCP servers: a real server in the backend; raw requests with and without tokens, Claude using its tools with writes gated by the harness | Needs the backend |
| | `/casework` | Case handling on Azure: multi-agent complaint handling with Azure OpenAI and Azure AI Search, groundedness and rule checks, caseworker approval, a hash-chained audit trail and an evaluation gate | Needs the backend, Azure OpenAI and Azure AI Search |
| | `/medassist` | MedAssist on Foundry: a patient portal chat with a Microsoft Foundry prompt agent that reads the signed-in patient's record, shows free slots, books the one they choose and texts them, beside the practice's systems (record, appointments, texts, audit log) | Needs the backend and a Foundry project with the agent created (`examples/medassist`) |
| | `/medassist/architecture` | MedAssist solution architecture: a diagram of how the components call each other, and every component by lane (channels, our APIs, the two engines and the clinic rules, the practice data, Microsoft Foundry and the Azure services, with the official Azure icons). Select a component to see what it does, where it runs and its files; choose a use case to see which components it passes through; a matrix of components against use cases | None |
| | `/reviews` | Review analysis: a dashboard of 30 product reviews in eight languages. Azure Language in Foundry Tools detects each language, then runs sentiment analysis with opinion mining, key phrase extraction and entity recognition (products, brands, places) with that language set; Claude can read the same review beside it, with English key phrases and a translation | Needs the backend and an AI Services or Language resource (`AZURE_LANGUAGE_ENDPOINT`) |
| | `/aftercare` | Aftercare follow-up agent: post-discharge calls by text or phone, in English or Spanish, to eight invented patients ranked by LACE risk. It checks medicines, asks about warning signs, books a follow-up and writes every answer back to a dummy record, raising tasks for a nurse, pharmacist or care navigator. It runs on Claude with our own tool loop or on Microsoft Agent Framework, under the same rules in code. A simulated patient can answer, phone calls are spoken through Azure Speech, and an evaluation checks eight scripted patients against the record | Needs the backend; Agent Framework needs a Foundry project (`FOUNDRY_PROJECT_ENDPOINT`, `FOUNDRY_MODEL`); voice needs Azure Speech |
| | `/hotel` | Hotel booking agent: a guest books, changes and cancels a room at an invented Whitby hotel by chatting with an agent on Claude, a GPT deployment or the local model. Prices, availability, two-turn confirmation, the 48-hour refund policy, who may see a booking and the deposit are enforced in the tools (`examples/hotel/hotel.py`); one database row per room per night means a room is never sold twice (a front-desk button shows it); card numbers typed into the chat are removed before the model sees them; a pretend payment page takes the deposit; confirmations are written by the code and kept in the guest's outbox as an email and a text, sent for real with `HOTEL_SMS_TO` / `HOTEL_EMAIL_TO` | Needs the backend; real texts need the Communication Services resource |
| | `/deal-close` | Closed-deal agents: mark a deal closed-won in an invented SQLite CRM (`generated/deals/crm.db`) and a chain of eight steps runs, shown as a graph that lights up as it streams. A model reads the win notes, rates each look-alike account and drafts one email each (Claude, GPT or the local model); code finds the look-alikes and scores their similarity, looks up each one's current supplier, turns the scores into a priority with fixed thresholds, and picks a contact. Code also enforces the rules: only contacts who agreed to email, never the won customer's name, at most three emails a day, and nothing sent without a person's approval, with every rule checked again at that moment. Sending is simulated | Needs the backend |
| | `/diet` | A diet planner agent: it asks a few questions, code works out the calorie and protein targets and refuses unsafe cases, the model designs a week of meals, code checks it against allergies, diet, targets and cooking time, and it downloads as a PDF, a shopping list and a spreadsheet. It remembers the person next time, keeping health details only with their agreement. Claude, GPT or the local model (`examples/diet/`) | Needs the backend |
| | `/whiteboard` | An AI whiteboard in four modes, with drawing tools (pen with stylus pressure and smoothing, highlighter, eraser, line, box, ellipse and arrow, eight colours, three widths, grid, undo and redo with Ctrl or Cmd+Z, save as PNG) and a history of boards on the left that reopen in their mode. **Maths**: sketch an equation, graph or shape; a model reads it as data, code checks it (expressions against a whitelist, one retry), and the page plots the function with sliders or turns and cuts a 3D solid; strokes are tidied into exact lines, circles and polygons as you draw. **Guess my drawing**: a word to draw in 40 seconds while a vision model (Haiku by default, at most 12 looks a round, only when the board changed) guesses; code, not the model, decides a match (plain words and a synonym list), and keeps the score and streaks in the browser. **Bring it to life**: a model reads the sketch into balls, boxes and lines, given the page's exact shapes as hints; code checks sizes and positions, and matter-js runs gravity, collisions, bounce and throwing. **Sketch to picture**: gpt-image-2 paints the sketch in a chosen style, with the sketch as its reference image (hidden when no image deployment is set) | Needs the backend |
| | `/songbird` | How a songbird sings two notes at once: an original cutaway bird whose syrinx has two sides, each its own voice (left low, right high), animated from what each side is singing, with the air sacs, windpipe, throat chamber and beak. Seven stylised songs (wood thrush duet, cardinal sweeps handed between sides, waterslager canary left-side rolls, zebra finch buzz, nightingale, lyrebird mimicry) are synthesised live in Web Audio along the bird's own signal path, with a scrolling spectrogram, and SynthBird is playable from the keyboard with breath, glide, grit, windpipe length and throat controls. A model can compose a song as a score; code checks each side's range, that no side sings two notes at once and the length, and sends problems back once | The synth runs in the browser; composing needs the backend and is paid |
| | `/vector-db` | A vector database you run yourself: PostgreSQL with pgvector in Docker (`./tools/vector-db.sh`, on `127.0.0.1:5433`, data kept in a volume). Documents are cut into chunks under their headings, embedded by the local embedding model, and stored with a full-text index; a question is answered three ways, by meaning (cosine distance on an HNSW index), by words (Postgres full-text search) and both fused (reciprocal rank fusion, in SQL), each with the SQL it ran and the plan Postgres chose. A model can then answer from the fused chunks, citing them; code checks every citation. Each document has an access group (everyone, hr, managers) and tags: a search or answer runs as a chosen reader, switching to an unprivileged `vector_reader` role with the reader's groups, and a PostgreSQL row-level security policy hides every other chunk from every query (superusers skip such policies, so searches never run as one); an invented restricted set (salary bands, a board plan) shows it. Rows record the embedding model, because vectors from two models cannot be compared. `LLM_LAB_PGVECTOR_URL` points it elsewhere, such as Azure Database for PostgreSQL | Needs the backend, Docker, and `LLM_LAB_LOCAL_EMBED_MODEL`; the answer is paid |
| | `/graphrag` | GraphRAG on the vector database's collections (or an invented company's memos, loaded with one button): a model reads each chunk and lists its entities and relationships (structured output, at most 40 chunks a build, cost shown before it starts); code merges mentions by normalised name, finds communities with the Louvain method, and a model summarises each. All of it is stored in PostgreSQL beside the chunks (`graph_entities_<dims>`, `graph_relations_<dims>`, `graph_communities_<dims>`). One question is then answered three ways side by side: plain vector RAG, local search (nearest entities, a walk of up to two relationships as one recursive SQL query, and their chunks) and global search (map over community summaries, reduce to one answer), each citing what it was given, checked by code, and lit up on a drawing of the graph | Needs the backend, Docker, the local embedding model; building and answering are paid |
| | `/semantic-cache` | A semantic cache in front of a model, on the same pgvector database: an HR help desk for the invented handbook stores each answer with the question's vector, and a close enough question gets the stored answer with no model call. Seven preset pairs, scored free by the local embedding model, show the catch: questions differing in one number or verb ("carry over 5 days" and "10 days", "book" and "cancel") score higher than true paraphrases, so no threshold is safe. A candidate must therefore also pass a code check (the numbers match) and a yes-or-no check by a small model before it is served. Entries are scoped by answering model, prompt version and user, and expire. Compares KV caching, prompt caching and semantic caching | Needs the backend, Docker, and `LLM_LAB_LOCAL_EMBED_MODEL`; misses and checks are paid |
| | `/tabular` | Tabular foundation models: TabPFN (pre-trained on millions of invented tables; predicts a new table by in-context learning, with no training on it) against gradient boosting on the same split of a CSV, uploaded or one of three invented samples. A model suggests the target from the column summary only (code checks it is a real, usable column) and explains the result; code computes every metric and checks the explanation uses no number that is not in the results. TabPFN v2 runs on the CPU in its own environment, `examples/tabular/.venv` (about 1.3 GB: `cd examples/tabular && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt`) | Needs the backend and that environment |
| | `/lora` | Fine-tuning with LoRA on this machine: SmolLM2 135M or 360M Instruct (Apache 2.0) learns to turn invented customer emails into one JSON object in a fixed shape. Code writes 400 emails and their answers (340 to train, 60 held out) and scores the model on 40 held-out emails before and after: valid JSON, exactly the right keys, each field, every field. Rank, alpha, layers, learning rate and steps are chosen on the page, which shows the numbers trained against the model's size, the loss as it falls, time and GPU memory, side-by-side answers, the adapter's file size, and a check that merging the adapter into the weights changes no answer. Saved adapters can be tried on your own email beside the base model. A table works out memory for full fine-tuning, LoRA and QLoRA from each model's shape; QLoRA's 4-bit loading needs CUDA, so on a Mac the page trains LoRA. Runs in `examples/lora/.venv` (about 1 GB: `cd examples/lora && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt`); free | Needs the backend and that environment |
| | `/code-graph` | A code knowledge graph: this lab's own code, an uploaded ZIP or a public GitHub repository, read by code in four passes (files; Python parsed with `ast` and JavaScript/TypeScript with oxc through rolldown's parser, in a Node subprocess; imports joined to files; calls joined to functions by name, so the call graph is approximate and each edge says how it was matched). Archives are unpacked with path, link, size and count checks, and nothing is run. An interactive force-laid graph with filters, focus depth, search and a side panel of each node's code and links; questions are answered by a model (Claude, GPT or the local model) through seven tools over the graph, and the nodes it used light up. Cached in `generated/code-graph/` | Needs the backend |
| | `/brain-check` | A brain health check: five short thinking tasks in order (remember five words, the day and date, draw a clock, name animals for a minute, recall the words), then 14 questions on the risk factors in the 2024 Lancet Commission on dementia. A model reads the clock drawing and picks the animals out of what was said; code scores every task, compares with the person's earlier checks (kept only if they agree, in `generated/brain-check/`), chooses one of four fixed outcomes and makes a PDF to take to a GP. A screening demonstration, not a medical test: the thresholds are illustrative | Needs the backend |
| | `/scan-explainer` | A scan explainer: upload a picture of an X-ray, a CT or MRI slice or an ultrasound, and a model (Opus by default) fills in a fixed form: what it can see, where, how sure, what the picture cannot tell, what it could be consistent with, and questions to ask the doctor. Code checks the file, rejects wording that states a diagnosis or suggests treatment (one retry, then nothing is shown), and writes the notices and the urgent message. Nothing uploaded is stored. It does not diagnose | Needs the backend |
| | `/gaze-pointer` | A hands-free pointer: the webcam follows the eyes and head (MediaPipe FaceLandmarker in the browser, from jsDelivr and Google's model store) to move a pointer over a practice area, and a face movement the person chooses clicks: opening the jaw, pressing the lips (a clench), a long blink, or keeping still. Code does the rest: a nine-point least-squares calibration, a One Euro filter, a click threshold set from the person's own resting and clicking, an accuracy check and a practice task. The camera never leaves the browser. A page cannot move the system cursor, and AirPods' motion sensors are not open to the web, so both are done on the page; a mouse demo runs the same steps without a camera | 4 MB, from CDNs; no backend |
| | `/data-agent` | Data agent: a workbook on an invented engineering warehouse (pull requests, reviews, issues) for three companies, with row-level security: you sign in as someone, and every query sees only their company's rows. Claude writes the query, runs it on the database, and sets the chart and dashboard tiles from the rows that come back, with every step shown. It works through the semantic model first (field names, compiled to parameterised SQL), adds a field when the model lacks one, and writes its own SQL when the model cannot express the question. All SQL runs read-only, with an authorizer, one statement, 5,000 rows and 5 seconds at most. The field list and an editable SQL tab run the same checks at no cost | Needs the backend |
| | `/ai-103` | AI-103 exam map: every skill in Microsoft's AI-103 study guide (skills measured as of 16 April 2026), each linked to the labs where it runs or is explained | None |
| | `/content-understanding` | Content Understanding and vision: an invoice, a claim form, three gpt-image-2 photos, a narrated video and audio, as Markdown and fields with confidence and source boxes; custom analyzers (extract, classify, generate); standard against agentic mode; captions, alt text, answers with visual evidence, regions and visual policy checks from gpt-5.4-mini | Needs the backend and an AI Services resource in a Content Understanding region, with gpt-4.1-mini and text-embedding-3-large deployed |
| | `/image-generation` | Image generation: gpt-image-2 from prompts and reference images, inpainting with a mask painted on the page, Content Credentials (C2PA), a visible watermark and brand checks; video generation (Sora 2) explained with code | Needs the backend and a gpt-image-2 deployment (`AZURE_MEDIA_ENDPOINT`) |
| | `/search-pipeline` | Search pipeline: every modality through Content Understanding, chunked, enriched with key phrases, embedded and indexed in Azure AI Search; keyword, vector, hybrid and semantic search scored on 12 labelled questions; index health; search as an agent's tool; the equivalent skillset | Needs the backend, an AI Services resource and Azure AI Search |
| | `/translation-speech` | Translation, text analysis and speech: Azure Translator with a glossary against gpt-5.4-mini, transliteration and the dictionary, a complaint in any language as a schema-checked log entry, speech to text with phrase lists, speech translation, and questions over audio | Needs the backend, an AI Services resource and Azure Speech |
| | `/video-translate` | Video translation: upload a video (up to 200 MB and 5 minutes). ffmpeg takes the sound out, Azure Speech fast transcription writes down each phrase with its time and identifies the language among the 18 the lab has voices for, and Azure Translator translates each phrase into the language chosen in the dropdown. Watch it with subtitles under the video, hear it spoken by that language's neural voice in step with the video (a phrase too long for its slot is spoken up to 1.5× faster), or both; download the subtitles as WebVTT. The transcript is kept per upload and each translation per language, so changing the language does not transcribe again. Files stay in `generated/video-translate/`; the sound goes to Azure. Keyless, through the AI Services account | Needs the backend, `AZURE_LANGUAGE_ENDPOINT` and ffmpeg |
| | `/claude-code` | Claude Code setup: CLAUDE.md, skills, hooks, subagents and plugins, with best practices | None |
| | `/claude-code-inside` | Claude Code behind the scenes: an animated, step-by-step tour for presenting, from `/init` to rewind. Press P for presenter mode | None |
| Quality and safety | `/evals` | Test sets, three kinds of grader, confidence intervals, run-to-run variance | GPT-2, 128 MB |
| | `/confidence` | Calibration, reliability diagrams, routing doubtful answers to a person | GPT-2, 128 MB |
| | `/benchmarks` | What benchmarks test, pass@k, significance, contamination, Elo and Bradley–Terry arenas | None |
| | `/injection` | Attack a toy agent and see which defences hold | None |
| | `/red-team` | Adversarial testing, automated: an attacker model writes attacks in seven strategies (direct override, role-play, payload splitting, encoding, indirect injection through an order note, multi-turn escalation, social engineering), alongside a fixed seed set, and each is played against an invented shop's support agent with a random canary code in its instructions and two recorded tools. Four defences can be toggled (stricter instructions, an input classifier, an output filter, tool checks in code). Code scores what it can see (the canary as written, spaced, reversed, ROT13, base64 or hex; a refund over £50 or on another customer's order; another customer's details), and a judge model reads only the rest against a rubric shown on the page. Results by strategy and by defence; a run's attacks can be saved as a regression suite (`generated/red-team/suites/`) and replayed word for word to see what was fixed and what regressed. Runs in the background, with an estimate first and a cost cap | Needs the backend; paid |
| | `/guardrails` | Guardrails: Azure AI Content Safety (harm categories with thresholds, a custom blocklist, image moderation, protected material), Prompt Shields for jailbreaks and injected instructions in documents and pictures, groundedness detection, PII redaction, a guarded pipeline that sends, holds or blocks, a labelled test set, and the deployment's own content filter | Needs the backend and an AI Services resource; groundedness runs on `AZURE_MEDIA_ENDPOINT` |
| Cost and operations | `/context` | Prefill and decode, KV cache memory, conversation cost with caching | None |
| | `/routing` | Large, small, cascade or router, compared on cost per correct answer | None |
| | `/local-model` | Running an open model on this machine: provisioning with `tools/local-model.sh`, `.env`, the daily commands, how the model client routes to Docker Model Runner, what it refuses, one local model at a time, troubleshooting; a live line says whether your model is configured, running and pulled | None |
| | `/observability` | Monitoring and traces: every model call the backend makes (time, the lab area and route that asked, the model that answered, tokens, cost, latency, errors and fallbacks), as metrics with p50/p95 latency, spend by area and by model, a log of recent calls, and traces that put one request's calls on a timeline. Counts and timings only, no prompt or reply text; kept in `generated/observability/calls.jsonl` (capped). How it maps to OpenTelemetry and Foundry tracing | Needs the backend |
| | `/resilience` | Rate limits: ten minutes of traffic against rate-limited deployments, with backoff, failover, a smaller model, a circuit breaker and a region outage | None |
| | `/foundry-operations` | Foundry operations, read live: deployment types and this lab's deployments with lifecycle dates, quotas, rate-limit headers, Azure Monitor metrics, security posture and role assignments, an evaluation with a release gate, an OpenTelemetry trace, and CI/CD with Bicep | Needs the backend and `AZURE_AI_RESOURCE_ID` |
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

- **With your Azure login (no key).** Add the region and the resource ID of an Azure AI Services or Speech resource to `.env`, and sign in with `az login`. Your account needs the **Cognitive Services Speech User** role on that resource; being its Owner is not enough. Training custom speech models (`examples/custom-speech/`) also needs **Cognitive Services Speech Contributor**. The resource must have a custom domain.

  ```sh
  AZURE_SPEECH_REGION=uksouth
  AZURE_SPEECH_RESOURCE_ID=/subscriptions/…/resourceGroups/rg-llm-lab/providers/Microsoft.CognitiveServices/accounts/ai-llm-lab-…
  ```

  Optionally, add `AZURE_SPEECH_FALLBACK_RESOURCE_ID` for a second resource. The tutor uses the first one and switches to the fallback for the rest of the session only when Azure refuses a request, for example when a free tier's monthly allowance or its requests per minute run out.

  The lab's own resources are in the resource group `rg-llm-lab` (UK South) in the FootballHackathon subscription, tagged `project=llm-lab`: `speech-llm-lab-knx5wa`, a free-tier (F0) Speech resource used first, and `ai-llm-lab-0eevth`, a paid AI Services resource as the fallback. Keys are switched off on both. A £5 monthly budget, `llm-lab-monthly`, emails the resource group's owners at 80% and 100% of actual spend, and when spending is forecast to pass £5.

- **With a key.** Set `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` instead, for a resource that allows keys.

Azure bills the voice by the character spoken and the listening by the hour of audio, on the resource's own subscription; pronunciation scores cost the same as listening. In UK South, pay-as-you-go, that is £11.32 per million characters and £0.75 per hour, or about £0.25 for a half-hour lesson. The free tier covers 5 hours of listening and 500,000 characters a month. Listening is charged for as long as the microphone is open, so press Done when you have finished speaking.

### The tutor's people: your face, your voice

**Your people…** on the tutor page adds tutors of your own: you, colleagues, anyone. Each has a name, a face and a voice, kept in `generated/tutor-people/` (gitignored).

- **A face.** One of the three built-in avatars, or a `.glb` you upload (up to 60 MB). It needs a humanoid rig and the ARKit and Oculus mouth shapes TalkingHead animates; Avaturn makes one from a selfie (export a T-pose GLB with ARKit blendshapes). Check the licence of the tool you use.
- **A voice.** One of 18 Azure neural voices, which lip-sync straight away, or the person's **own voice** through Azure personal voice. The person records two clips in the browser (recorded as 24 kHz WAV): Microsoft's consent statement with their name and the company, then a 5 to 90 second sample. Azure checks the consent speaker is the sample speaker, so nobody's voice can be copied without them. Azure returns a speaker profile id, and the tutor speaks with it through `PhoenixLatestNeural`, the base model that also sends word timings and mouth shapes (the Dragon models don't, so the avatar's lips could not move).

Personal voice is **limited access**: Microsoft must approve the use case first ([aka.ms/customneural](https://aka.ms/customneural)). It runs only in some regions (eastasia, eastus, eastus2, southeastasia, swedencentral, westeurope, westus2; not uksouth, where the lab's Speech resources are), and not on the free tier. Point it at a resource in one of those regions, signed in with your Azure login like the rest of the tutor (your account needs the Cognitive Services Speech Contributor role on it):

```sh
AZURE_PERSONAL_VOICE_RESOURCE_ID=/subscriptions/…/resourceGroups/rg-llm-lab/providers/Microsoft.CognitiveServices/accounts/ai-llm-lab-media-…
AZURE_PERSONAL_VOICE_REGION=swedencentral
```

Until the resource is approved, the panel says why it cannot clone (Azure refuses to list the base models), and everything else on it works. Deleting a person, or their own voice, deletes the voice and its consent at Azure too.

### Case handling on Azure

The case-handling lab (`/casework`) runs on Azure only: the GPT deployment above for every agent, `text-embedding-3-small` in the same Foundry resource for embeddings, and Azure AI Search for the council's policies. The search service, `srch-llm-lab-kvpjs7`, is on the free tier in `rg-llm-lab`, with keys switched off and the semantic ranker on its free plan. Your account needs **Search Service Contributor** and **Search Index Data Contributor** on it. The lab creates its index, `casework-policies`, on first use.

```sh
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-small
AZURE_SEARCH_ENDPOINT=https://srch-llm-lab-kvpjs7.search.windows.net
```

A case costs about 2 to 4 cents and takes about 30 seconds; the release-gate evaluation runs all five cases, about 13 cents. The audit log is written to `casework/audit.jsonl`, which git ignores.

The MedAssist lab (`/medassist`) talks to the `MedAssist` prompt agent in the Foundry project named by `FOUNDRY_PROJECT_ENDPOINT` (`FOUNDRY_MODEL` is its model, for pricing). Create the agent first with `python examples/medassist/medassist.py create`. Your account needs the **Foundry User** role on the Foundry resource. The agent's function tools run in the backend against the example's SQLite database, `examples/medassist/data/medassist.db` (ignored by git), so the page and the example's command line see the same bookings. A booking conversation costs well under a cent in model tokens; File Search and the Code Interpreter are charged separately by Azure.

The review analysis lab (`/reviews`) calls Azure Language on the resource named by `AZURE_LANGUAGE_ENDPOINT`, such as `https://ai-llm-lab-0eevth.cognitiveservices.azure.com` (the same AI Services resource), signed in with `az login`; keys can stay off. Azure bills one text record per feature for every started 1,000 characters of a review, at $1 per 1,000 records, so analysing all 30 reviews with four features costs about $0.12. The backend keeps each analysis for the session and charges it to `--budget`. Sentiment analysis, opinion mining and key phrase extraction retire from Azure Language on 31 March 2029.

The Aftercare lab (`/aftercare`) runs the follow-up agent in `examples/aftercare/ward.py` against its own SQLite record, `examples/aftercare/data/aftercare.db` (ignored by git), so the page and the example's command lines see the same tasks and bookings. With Claude, the backend runs the tool loop itself. With Agent Framework, an `Agent` on `FoundryChatClient` uses the Foundry project's `FOUNDRY_MODEL` and needs the **Foundry User** role and `az login`. The simulated patient is always Claude Haiku. Running all eight scripted patients costs about $0.03 on Haiku and $0.10 on gpt-5.4-mini. Spoken calls use the tutor's Azure Speech token, with British English and Castilian Spanish voices.

The coding agent (`/coding-agent`) runs `python/19_coding_agent.py` itself (loaded in `shared.py`), one session per copy of `python/coding_project` in `generated/coding-agent/<id>/project`. Each copy is its own git repository, so git commands never reach this one. The page answers the agent's permission prompts through `/api/coding/approve`, reads the files and the diff, and undoes the last change. The Agent SDK run starts `examples/claude-agent-sdk/coding_agent_sdk.py` in that folder's own environment and relays its JSON events; its permission prompts come to the page the same way, over the script's stdin. The agent's `screenshot` tool runs Chrome's own `--screenshot` (Chrome is found as for the site builder, or set `LLM_LAB_CHROME`) and returns the PNG as an image block in the tool result, with the page's console messages; the page shows what Claude saw. A fix-the-tests run costs about $0.002 by hand and $0.005 on the SDK, on Haiku; building and checking a chart page about $0.003. In auto mode every command runs in an OS sandbox (`sandbox-exec` on macOS, bubblewrap on Linux, chosen by `LLM_LAB_SANDBOX`): it writes only in the project and its temp folder, cannot read the home folder or `.env`, and gets a clean environment without the API key, in a `.venv` of the project's own. So `pip`, `curl` and `rm` are allowed; `git push`, `ssh` and `sudo` are not. Where no sandbox works, as in an Azure Container Apps container, auto mode keeps the full deny rules. In the cloud the boundary is a container per session: `LLM_LAB_SANDBOX=sessions` with `LLM_LAB_SESSIONS_ENDPOINT` sends each command, and each screenshot, to an Azure Container Apps dynamic session (a Hyper-V isolated container, called with the managed identity), carrying the project there and back. `examples/coding-sandbox/` has its container, server and two keyless setup scripts: `setup-app.sh` for one shared container app on the Consumption plan (option B, cheapest), and `setup.sh` for a session pool with a Hyper-V container per session (option A). Switching between them changes `LLM_LAB_SESSIONS_ENDPOINT` and `LLM_LAB_SESSIONS_SCOPE`. Whatever the agent needs it installs at runtime: Python packages with pip (the download cache in `generated/agent-tools/` is shared by every session), and programs either inside a cloud session with `apt-get`, or on your own machine through `bash` with `outside_sandbox`, which always asks you. Nothing in a cloud session asks anyone.

The data agent (`/data-agent`) keeps its semantic model, SQL compiler and guarded SQL runner in `backend/app/services/data_model.py` and its tool loop in `services/dataagent.py`. Fields the agent creates live in the session and travel with each query (`custom_fields`), so a dashboard tile can run again on its own. The warehouse is a seeded SQLite file, `generated/data-agent/warehouse.db`, made on first use, with every row tagged by `company_id`. Beside it sits one copy per company (`warehouse-company-<id>.db`), and every query runs on the signed-in company's copy, so the agent's own SQL has no other company's rows to reach; the compiler also adds `company_id = ?` to semantic queries. The page names who is signed in in an `x-lab-user` header, which `api/deps.py` (`data_viewer`) looks up in a fixed directory; in a product that is where the verified sign-in token is read. The cache, workbooks and dashboards (`dashboards.json`) are kept per company. Each tile keeps its query, not its rows, so a dashboard runs its queries again when opened. A question costs about $0.002 on Haiku.

The AI-103 labs (`/guardrails`, `/content-understanding`, `/image-generation`, `/search-pipeline`, `/translation-speech`, `/foundry-operations`, mapped on `/ai-103`) call Foundry Tools and models over REST through one gateway, `backend/app/gateways/foundry_tools.py`, signed in with `az login` and no keys. They use two AI Services resources: the lab's own in UK South (`AZURE_LANGUAGE_ENDPOINT`: Content Safety, Language, Translator, Content Understanding, gpt-5.4-mini, gpt-4.1-mini and text-embedding-3-large) and one in Sweden Central (`AZURE_MEDIA_ENDPOINT`: gpt-image-2, and groundedness detection, which in UK South answers "grounded" to everything without an error). `AZURE_AI_RESOURCE_ID` and `AZURE_MEDIA_RESOURCE_ID` let the operations lab read deployments, quotas, metrics and security settings (read only). Content Understanding needs its model defaults set once (`PATCH /contentunderstanding/defaults`). Generated photos, the sample video and cached extractions go in `generated/` (ignored by git). Prices for these services are in `python/common.py` (`TOOL_PRICES`; gpt-image-2 uses gpt-image-1's rates until it is in the retail price list). Video generation is explained, not run: Sora 2 was closed to new deployments on 2 November 2026.

### GPT in the document automation lab

Document automation (Lab 22) can use a GPT model in Microsoft Foundry for each of its AI steps instead of Claude, with the same prompts and schemas, to compare the two. Pick it under **GPT (Microsoft Foundry)** in the page's model list. Other pages use Claude, or the local model described below.

```sh
AZURE_OPENAI_ENDPOINT=https://ai-llm-lab-0eevth.openai.azure.com
AZURE_OPENAI_DEPLOYMENTS=gpt-5.4-mini
```

The deployment `gpt-5.4-mini` (Global Standard) is in the same Foundry resource as the speech fallback, `ai-llm-lab-0eevth`, in its project `llm-lab`. Keys are off, so the backend signs in with `az login`; your account needs the **Cognitive Services OpenAI User** role on the resource. It is billed per token on the subscription, at $0.75 per million input tokens and $4.50 per million output tokens, and counts against the backend's `--budget` like Claude.

### A local open model, at no cost per token

An open model can run on this machine in Docker and be the default wherever the work allows. Docker Model Runner, which comes with Docker Desktop, runs it with llama.cpp on the host, so on a Mac it uses the GPU through Metal (an ordinary container cannot). The lab's `/local-model` page covers the same ground with the code, and says whether your model is running. Open Docker Desktop first, then set it up once:

```sh
./tools/local-model.sh             # enables Model Runner on port 12434, pulls the model (6.9 GB), sets a 32k context
echo 'LLM_LAB_LOCAL_MODEL=ai/qwen3.5:9b-q4_K_XL' >> .env   # then restart the backend
```

After restarting the machine or Docker Desktop, open Docker Desktop, run `./tools/local-model.sh` again, then start the backend and frontend as usual. Model Runner stays enabled and the model stays downloaded, so the script only sets the context again and checks the model answers ("Model says: Ready."). It is safe to run any time. To have Docker start by itself, turn on "Start Docker Desktop when you sign in" in its general settings. The model unloads after 30 minutes idle and reloads on the next request, which then takes a few seconds longer. If the server is not running, pages using the local model say so and name the script; a Claude model still works.

The model is Qwen 3.5 9B (Apache 2.0): it calls tools, reads images and fits in 24 GB of memory with room to spare. On an M5 Pro it writes about 20 tokens a second, so a short answer takes a second or two and an agent run a minute or more. Claude is much faster and much better at long agent work; the local model is for practising without spending.

The lab uses one local model at a time. `LLM_LAB_LOCAL_MODEL` holds one name, and the client treats a request as local only when its model matches that name exactly, so the model lists show one local model even when Docker has several downloaded. `docker model ls` lists what is downloaded; `docker model ps` lists what is loaded now, which is only what requests have used in the last 30 minutes. To use another model, such as gpt-oss (which cannot read images), change the name and run the script again:

```sh
# in .env: LLM_LAB_LOCAL_MODEL=ai/gpt-oss:20b
./tools/local-model.sh             # pulls it if needed, sets its context, checks it answers; then restart the backend
```

With `LLM_LAB_LOCAL_MODEL` set, the model lists start with it and pages select it, and every call is charged at $0. The scripts in `python/` default to it too. `python/local_model.py` does the routing, in the client every page already uses: Model Runner serves the Anthropic Messages API at `http://localhost:12434/anthropic`, so requests keep their shape. It switches the model's thinking off unless a request asks for it, and sends a reply that must match a JSON schema to the server's OpenAI-compatible endpoint, where a grammar holds it to the schema.

What only Anthropic runs is refused with a message saying to choose a Claude model, rather than quietly left out: web search (the harness's web scenario), PDFs, the Files API, Anthropic's code execution container, and MCP connectors. The skills page and the deck builder still default to Claude, but run on the local model or GPT in the lab's own sandbox (below). The coding agent's Agent SDK mode and `python/14_batch_api.py` stay Claude only. Azure labs keep their Azure models. Ollama works the same way: set `LLM_LAB_LOCAL_URL=http://localhost:11434` and `LLM_LAB_LOCAL_OPENAI_URL=http://localhost:11434/v1`. `./tools/local-model.sh --stop` unloads the model; `--remove` deletes it.

#### A local embedding model

Model Runner also serves open embedding models, on the same port (`/engines/v1/embeddings`, the OpenAI shape). `./tools/local-model.sh --embed` pulls one and checks it answers; it does not touch the chat model:

```sh
./tools/local-model.sh --embed     # pulls ai/nomic-embed-text-v1.5 (about 270 MB): "Numbers per text: 768"
echo 'LLM_LAB_LOCAL_EMBED_MODEL=ai/nomic-embed-text-v1.5' >> .env   # then restart the backend
```

With `LLM_LAB_LOCAL_EMBED_MODEL` set, `/embeddings` offers a choice of embedding model: MiniLM in the browser (384 numbers) or the local one, through `POST /api/embeddings/local` (free, so it has no budget guard; at most 128 texts a call). The sentence map and the retrieval demo then run on either. Scores from different models are on different scales, so the page starts the minimum similarity at 0.55 for the local model, not 0.3. `backend/app/gateways/local_embeddings.py` adds the short instruction some models expect in front of a text (`search_document: ` and `search_query: ` for nomic). Other embedding models in Docker Hub's `ai/` namespace: `ai/mxbai-embed-large` (670 MB), `ai/embeddinggemma` (330 MB) and `ai/qwen3-embedding` (4.7 GB and up); set the variable to one of them and run the script again. Both a chat model and an embedding model can be loaded at once.

### GPT in Azure OpenAI, beside Claude

With `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_DEPLOYMENTS` set (`azd up` writes both), each GPT chat deployment, such as `gpt-5.4-mini`, is offered in every model menu that offers the local model, and the scripts take it as `--model gpt-5.4-mini`. It is a choice, never the default. `python/gpt_model.py` does the work in the same client as the local model. It translates each request to Chat Completions and each reply back to Claude's shapes, streamed replies included, so the site builder's code view still fills in as GPT writes a file. It signs in with your Azure login, with no keys, and each call is charged at GPT's list price. A request's effort sets GPT's reasoning effort (low unless more is asked for). What only Anthropic runs is refused with the same message as for the local model, and counting tokens before sending is refused too, because Azure OpenAI has no endpoint for it. The coding agent and the documents page keep their own GPT paths.

### Skills and decks without Claude's container

Claude runs skills in Anthropic's code-execution container, which only Claude can use. For GPT and the local model, `python/sandbox_skills.py` does the same job with the coding agent's sandbox, the image in `examples/coding-sandbox` (python-pptx, openpyxl, python-docx, reportlab, LibreOffice and poppler). On your machine, run it in Docker with `./tools/sandbox.sh` (it builds the image if needed and listens on `127.0.0.1:8099` only) and set `LLM_LAB_SANDBOX=docker`. `LLM_LAB_SANDBOX=sessions` uses the one in Azure instead, at `LLM_LAB_SESSIONS_ENDPOINT`, which `azd up` writes; `azd up` no longer sets `LLM_LAB_SANDBOX`, so your choice stays. Both run the same image and protocol, so what works locally works in Azure. `./tools/sandbox.sh --rebuild` after changing the Dockerfile or `server.py`; `--stop` stops it. A page using the local container while it is stopped says so and names the script. The model sees each skill's name and description, reads its `SKILL.md` with `read_skill` only when the task needs it, and runs code with `bash`. Each conversation has a workspace in `generated/skill-runs/<id>/` with `inputs/` (your files), `work/` (kept between messages), `outputs/` (what you download) and `skills/` (a copy of the skills, sent to the container with every command, so changing a skill needs no new image). Our loop sends each step as its own request, where Claude's container runs the whole loop inside one.

The skills are our own, in `python/skills/`: `pptx`, `xlsx`, `docx` and `pdf`. The pptx skill follows the shape of Anthropic's, with a short `SKILL.md`, reference files read when needed (`reference/charts.md`, `editing.md`, `design.md`) and scripts: `slide_text.py` (every slide as text, flagging overlaps, shapes off the slide, empty placeholders, default chart titles and axes that do not start at zero; `--layouts` for a template), `theme.py` (a template's colours and fonts), `edit_text.py` (text changes that keep formatting), `slides.py` (delete, move, duplicate, reorder), `ooxml.py` (raw XML, and validation) and `render.sh` (slide images for the visual check). The deck builder's checks are the same for every model: after each version it shows the model the rendered slides, and any screenshot you attached as the look to match, up to two rounds. Pictures you attach are shown to the model on both paths, so it can copy a slide's look. A template you attach is always the starting point. A chart type that does not suit the data is not built: the model says why, suggests two or three that do, and asks.

A deck stays with the kind of model it was started with, because each keeps its files in a different place. GPT's and the local model's own visual checks are weaker than Claude's: on a slide matched to a screenshot, `gpt-5.4-mini` reported small overlaps and spacing faults as clean that Claude finds.

### When a model is rate limited

A request that still answers 429 (rate limited) or 529 (overloaded) after the SDK's own retries is sent once more to another model before the error reaches the page: Claude falls back to the first GPT deployment (or the local model when there is no GPT), and GPT to `LLM_LAB_MODEL`. `LLM_LAB_RATE_LIMIT_FALLBACK` sets it: `auto` (the default), `none`, or a model id. A stream falls back only before it starts, and a request that needs Claude (web search, files) reports the rate limit rather than the fallback's refusal. The spend is charged at the price of the model that answered. `python/13_rate_limits.py` shows the same ideas, with a circuit breaker, against fake servers.

Live features otherwise use Claude Haiku 5.5 by default, where each action costs a small fraction of a cent. The Live page lets you pick Claude Sonnet 5.5 or Claude Opus 5.5 instead, which cost more. The backend logs the estimated cost of every call, and the Live page shows the running total. Your Anthropic console shows the exact amount billed.

## Other folders

- `python/`: runnable scripts for each lab. See `python/README.md`.
- `tools/`: rebuilds the GPT-2 model with its internals exposed. See `tools/README.md`.
- `examples/mcp/`: an MCP server in Python (tools, a resource, a prompt; stdio and authenticated Streamable HTTP), used from Claude Code, from your own harness with approvals, and through the Claude API's MCP connector. Its README covers the design decisions.
- `examples/sdks/`: the same five tasks (structured output, tools, MCP, an agent with human approval, multi-agent) in nine SDKs: OpenAI, OpenAI Agents, Claude, Microsoft Agent Framework, Semantic Kernel, AutoGen, LangChain, LangGraph and CrewAI, each in its own environment, with a comparison cheatsheet.
- `examples/agent-framework/`: the case-handling flow from Lab 25 rebuilt in Microsoft Agent Framework (Python), run in DevUI: typed agents, `@tool` systems of record, a workflow graph with a revision loop, and a human approval pause.
- `examples/medassist/`: MedAssist, a patient portal agent built as a Microsoft Foundry prompt agent: File Search over practice documents, the Code Interpreter, and function tools that read a signed-in patient's record and book or cancel appointments in a dummy SQLite database, with the safety rules enforced in code and nine checked test cases. With Azure set up, it also sends real texts through Azure Communication Services and a reminder 24 hours before each appointment, from an Azure Function (see its README).
- `dotnet/`: MedAssist in C# on .NET 10, in layers: an ASP.NET Core API the lab's page can call (`LLM_LAB_MEDASSIST_API=http://127.0.0.1:5080 npm run dev`), a command line, the service layer, the domain (the rules and tools), the SQLite data layer, and Foundry with two engines (the prompt agent with our own loop, and Microsoft Agent Framework). It shares the Python version's database, documents and Foundry agent. `dotnet test` runs 66 tests offline. See `dotnet/README.md`.
- `examples/aftercare/`: Aftercare, a post-discharge follow-up agent. Its hospital record, LACE risk, routing, tools and rules are in `ward.py`. `aftercare.py` runs it on Claude with our own tool loop, and `aftercare_af.py` runs the same tools on Microsoft Agent Framework. Both are tested against eight simulated patients, checked on what each call left in the record.
- `examples/hotel/`: the Harbour Light, a hotel booking agent. `hotel.py` holds the hotel, its rules, its tools and the tool loop, shared with the `/hotel` page through `backend/app/shared.py`; `hotel_agent.py` is the command line on the same database (`generated/hotel/hotel.db`).
- `examples/diet/`: the diet planner agent. `diet.py` holds the targets, the plan's checks, the tools, the tool loop and the files, shared with the `/diet` page through `backend/app/shared.py`; `diet_agent.py` is the command line on the same memory folder (`generated/diet-memory/`).
- `examples/support-agent/`: a Foundry Agent Service agent with the Azure AI Search tool (grounded answers from an index), the OpenAPI tool (an order-status API in Container Apps) and a conversation for multi-turn context.
- `examples/custom-speech/`: a custom speech model for product names the base model mishears: training text, test calls, an evaluation against the base model, an endpoint for live calls, and a phrase list for comparison.
- `examples/foundry-sdk/`: a tour of the Foundry project client: connections, deployments, datasets, indexes, a cloud evaluation with built-in evaluators, and tracing.
- `examples/foundry-cicd/`: the evaluation gate the pipeline runs, and model deployments as Bicep for an account that already exists.
- `examples/agents/`: three more Foundry prompt agents, one per common use case: SalesDesk (leads, scoring, follow-ups, calls), ResearchDesk (monitoring, cited reports) and DayPlanner (calendar, inbox, to-do list), each with a dummy database, its rules enforced in its tools, and six checked test cases. Five more build the intended uses in the Agent Service's Transparency Note (healthcare staff orientation, retail gift guidance, council request triage, lesson research, factory stock and rotas), each with a review queue that only a person can clear (`run.py <agent> review`).
- `azure.yaml` and `infra/`: every Azure resource the lab uses, for `azd up` (it writes `.env`) and `azd down --purge`. See `infra/README.md`.
- `.github/workflows/infra.yml`: on main, `azd provision` and then the evaluation gate, signed in with OpenID Connect. `infra/pipeline.sh` sets up its identity, its roles and its repository variables.
- `examples/coding-sandbox/`: the coding agent's shell for the cloud. A small server and Dockerfile (with Chromium, for screenshots) for an Azure Container Apps custom container session pool, and `setup.sh`, which builds the image and creates the pool keylessly. The same image runs under Docker on `127.0.0.1` to try it.
- `examples/claude-agent-sdk/`: the coding agent from Lab 46 on the Claude Agent SDK (Claude Code's own harness): built-in tools, permission modes, allow and deny rules, a `can_use_tool` callback, hooks, a sub-agent, `CLAUDE.md` and a `screenshot` tool of its own (`create_sdk_mcp_server`), in its own environment.
- `examples/claude-code/`: copyable CLAUDE.md, skills, hooks, a subagent and a plugin for the Claude Code labs. They are stored under names Claude Code does not load; the folder's README says where each one goes.

## What has been tested

- All 20 pages in headless Chrome, on the production build served by FastAPI and on the Vite dev server, with no JavaScript or React errors. That includes moving through every page inside the app without a reload, then pressing the keys pages listen for, to check nothing from a previous page keeps running.
- The backend, with 181 tests against fake Claude, Azure, Foundry and browser clients, so they need no network, key or credit: routing to the fallback endpoint, streaming, the spending cap, request validation, the protections against other websites and serving the frontend, plus the harness and skills runs, the deck builder, the site builder, the tutor, document automation, the MCP lab, case handling, MedAssist, review analysis, Aftercare, the six AI-103 labs, the data agent and the coding agent.
- Live features against a local mock of the Claude API. No real API calls were made while building this version.

## Sharing

`npm run build` produces static files in `frontend/dist/`. The labs that need no backend work from any static host that sends every path to `index.html`. The live features and the full GPT-2 explainer need the backend.

Prices and model facts on the pages reflect Anthropic's documentation as of October 2026. Check the pricing page before relying on them.
