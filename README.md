# LLM Lab

Hands-on pages that show how large language models and the systems around them work, each ending with the engineering decisions it should change. Every page runs real models or real arithmetic in your browser. A FastAPI backend adds live Claude calls.

**Try it: [green-island-01783800f.8.azurestaticapps.net](https://green-island-01783800f.8.azurestaticapps.net)**

**Only the frontend is hosted there; the backend is not.** Pages that run in your browser work as they do here. Anything that calls a model, a database or Azure (marked "Needs the backend" in [the labs table](#the-labs)) only works when you run the lab on your own machine, as [Start](#start) describes.

**Read about it and watch a demo video: [the LinkedIn post introducing LLM Lab](https://www.linkedin.com/feed/update/urn:li:activity:7529146303759450112/)**

It has a **FastAPI** backend and a **React + TypeScript** frontend, kept separate.

```
llm-lab-app/
├── backend/     FastAPI: the /api routes, the spending cap, and serving the built frontend
├── frontend/    React + TypeScript, built with Vite: one route per lab
├── python/      runnable lesson scripts (01 to 18), a sample skill, and the shared prices, settings and data
├── tools/       sets up Docker services and databases, loads data, rebuilds the GPT-2 model
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

All commands run from the `llm-lab-app` folder. On a Mac, use `python3` until the virtual environment is active.

### On a new machine, in order

**You need:** Python 3.10 or newer, Node.js 20 or newer, and [Docker Desktop](https://www.docker.com/products/docker-desktop/) with Docker Model Runner turned on (Settings > AI > Enable Docker Model Runner, with host-side TCP support). An Anthropic API key for Claude; without one, the pages that allow it run on the local model. For the Azure labs only: the Azure CLI and azd.

```sh
# 1. Python and the frontend (once)
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
(cd frontend && npm install)

# 2. Settings: copy the defaults, then put your Anthropic key in .env
umask 077 && cp .env.example .env

# 3. Everything that runs in Docker, with its data (open Docker Desktop first)
./tools/setup-local.sh          # database, embedding model, chat model, sandbox, shop data, sample documents

# 4. Run it: two terminals
python -m backend --budget 1 --reload
cd frontend && npm run dev      # then open http://localhost:5173
```

`./tools/setup-local.sh` runs the other scripts in `tools/` in the right order and is safe to run again at any time: each step only does what is missing, and at the end it lists any line `.env` still needs. `--no-chat-model` skips the 6.9 GB local chat model; `--no-data` sets up the services without the shop's products and the sample documents. What each step does:

| Step | Script it runs | Gives you | Size |
|---|---|---|---|
| PostgreSQL with pgvector, `127.0.0.1:5433` | `./tools/vector-db.sh` | `/vector-db`, `/semantic-cache`, `/graphrag`, `/shop-assistant` | about 650 MB image |
| Local embedding model | `./tools/local-model.sh --embed` | Search by meaning on those pages | about 270 MB |
| The small "cognitive core" model (Qwen 3.5 0.8B) | `./tools/local-model.sh --core` | `/cognitive-core` | about 600 MB |
| Local chat model (Qwen 3.5 9B) | `./tools/local-model.sh` | Free model calls, the default where the work allows | about 6.9 GB |
| Sandbox, `127.0.0.1:8099` | `./tools/sandbox.sh` | The coding agent's commands, `/assistant`, skills and decks off Claude | builds an image, about 3 GB |
| The shop's tables and 20,000 products | `./tools/shop-data.sh` | `/shop-assistant` | about 1.5 minutes of embedding |
| Sample documents | `./tools/vector-samples.sh` | Ready-made collections on `/vector-db` and `/graphrag` | small |

Then, only for the labs that need them:

| For | Run | Section |
|---|---|---|
| The tutor's 3D people | the `curl` loop below | [One-time setup](#one-time-setup) |
| `/coding-agent` (Agent SDK), `/tabular`, `/lora`, `/image-to-3d`, `/voice-agent` | `./tools/setup-envs.sh all` | [Labs with their own environment](#labs-with-their-own-environment) |
| GPT, speech, translation, search, Foundry agents, images, MedAssist's texts | `azd up` | [Azure resources (optional)](#azure-resources-optional) |
| The full-internals GPT-2 on the explainer | `python tools/export_gpt2_explainer.py` | `tools/README.md` |

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

### Data and databases

Data the labs load lives outside git, so each database has a script in `tools/` that sets it up on a new machine and can be run again after a change. Each is safe to run again.

| What | Script | Where |
|---|---|---|
| PostgreSQL with pgvector, for `/vector-db`, `/semantic-cache`, `/graphrag` and `/shop-assistant` | `./tools/vector-db.sh` | A container, `127.0.0.1:5433`, data in the `llm-lab-pgvector-data` volume |
| The shop's schema and data (`/shop-assistant`) | `./tools/shop-data.sh`, then `./tools/shop-data.sh generate 20000` | The `shop` schema in that database |
| The sample documents for `/vector-db` and `/graphrag` | `./tools/vector-samples.sh` | Tables in that database, one per vector length (`chunks_768`) |

`tools/README.md` says which command to run after which change.

### Labs with their own environment

Five labs run a script in a Python 3.12 environment of its own, because they need packages the main `.venv` must not get (PyTorch above all). Each page says what to run when its environment is missing; `tools/setup-envs.sh` sets them up:

```sh
tools/setup-envs.sh                   # list them, and whether each is set up
tools/setup-envs.sh lora image-to-3d  # set up those (run again to reinstall the pinned packages)
tools/setup-envs.sh all               # set up every one
tools/setup-envs.sh check-hf          # check the Hugging Face sign-in and the gated models Idol needs
```

| Environment | Page | Size | Also needs |
| --- | --- | --- | --- |
| `claude-agent-sdk` | `/coding-agent` (the Agent SDK engine) | about 350 MB | nothing more |
| `tabular` | `/tabular` | about 1.3 GB | nothing more |
| `lora` | `/lora` | about 1 GB | to publish adapters, a Hugging Face token with write access: [examples/lora/README.md](examples/lora/README.md) |
| `image-to-3d` | `/image-to-3d` | about 1 GB, plus about 5 GB of weights on first use | access to two gated models and `hf auth login`: [examples/image-to-3d/README.md](examples/image-to-3d/README.md) |
| `voice-agent` | `/voice-agent` (the local voice) | about 170 MB, plus 340 MB of model files (the script downloads them) | nothing more |

The Hugging Face token is kept in `~/.cache/huggingface/token`, shared by every environment. The lab never reads it, and it never goes in `.env` or in the repo.

### Azure resources (optional)

The labs that use Azure (GPT, embeddings, speech, translation, search, the Foundry agents, image generation, the coding agent's cloud sandbox, MedAssist's texts) need resources in your own subscription. `azd up` creates them all in one resource group and writes their settings into `.env`; `azd down --purge` removes them. Everything is keyless: you sign in with `az login`.

```sh
brew install azure-cli azd                # macOS; see infra/README.md for Windows and Linux
az login
azd config set auth.useAzCliAuth true     # once: azd uses your az login
azd up                                    # asks for an environment name and the subscription; about ten minutes
# ...then restart the backend
azd down --purge                          # when you are finished: deletes everything it made
```

You need Owner on the subscription (or Contributor with Role Based Access Control Administrator), and permission to create app registrations. [infra/README.md](infra/README.md) lists every resource and role, the settings to change before `azd up`, running it from GitHub Actions, and what to do when something fails.

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

Four things run in Docker beside the backend. `./tools/setup-local.sh` checks and starts all of them, so after a restart it is the one command to run; each also has its own script. The lab's `/local-model` page walks through the model's steps and shows whether your model is configured, running and pulled.

| What | Script | Where | After a restart |
|---|---|---|---|
| The local model (Qwen 3.5 9B), the default where the work allows | `./tools/local-model.sh` | Docker Model Runner, on the Mac itself, `localhost:12434` | Run the script again: it sets the context the agent pages need (`LLM_LAB_LOCAL_CONTEXT`, 100k by default), and checks the model answers |
| The local embedding model | `./tools/local-model.sh --embed` | Docker Model Runner, the same port | Loads again on the first request; nothing to run |
| PostgreSQL with pgvector, with its data in a volume | `./tools/vector-db.sh` | A container, `127.0.0.1:5433` | Starts by itself with Docker Desktop |
| The sandbox, where the coding agent's commands and the local model's and GPT's skills and decks run | `./tools/sandbox.sh` | A container, `127.0.0.1:8099` | Starts by itself with Docker Desktop. Run the script only the first time, or with `--rebuild` after changing the image |

`sandbox.sh` does not start the model. The model cannot run in a container on a Mac, because a container cannot reach the GPU, so Model Runner runs it on the host.

In order:

```sh
# 1. open Docker Desktop and wait until it says it is running
./tools/setup-local.sh                     # 2. "Every step worked." (or just ./tools/local-model.sh)
source .venv/bin/activate
python -m backend --budget 1 --reload      # 3. then the frontend, as above
```

Only for real phone calls (Aftercare and MedAssist), also start the tunnel in its own terminal: `ngrok http 8000`. Without a fixed ngrok domain its address changes each time, so put the new one in `.env` as `AFTERCARE_CALLBACK_URL` and restart the backend (`examples/aftercare/README.md`, "A real call to your phone").

To check what is running:

```sh
docker ps --filter name=llm-lab           # the sandbox and the database containers, "Up"
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
| The frontend (`frontend/src/`) | Nothing on the dev server (:5173). For port 8000: `cd frontend && npm run build`. For the public site: `./tools/deploy-frontend.sh`. |
| A skill (`python/skills/`) | Nothing. Its scripts travel with each command, so no image needs rebuilding. |
| The sandbox image (`examples/coding-sandbox/`: `Dockerfile`, `server.py`, `extra-*.txt`) | On your machine: `./tools/sandbox.sh --rebuild`. In Azure: `TAG=<n> examples/coding-sandbox/publish-image.sh`, then `IMAGE=ghcr.io/<you>/coding-sandbox:<n> examples/coding-sandbox/setup-app.sh`. Use a new tag each time, so the app starts a new revision (`examples/coding-sandbox/README.md`). |
| The reminders Function (`examples/medassist/reminders/`) | `examples/medassist/setup-texts.sh` again: it redeploys the code and leaves the rest as it is. With azd, `azd deploy reminders`. |
| Azure resources (`infra/`) | `azd provision`, or push to main, where `.github/workflows/infra.yml` runs it. |
| The local model (`LLM_LAB_LOCAL_MODEL`) | `./tools/local-model.sh` (it pulls the new one), then restart the backend. |
| The full-internals GPT-2 (`models/gpt2-explainer/`) | See `tools/README.md`. |
| The sample documents (`vectordb.py`'s sets, `graphrag_sample.py`, `examples/medassist/knowledge/`) | `./tools/vector-samples.sh`. Then Build on `/graphrag` for its graph. |
| The shop's schema (`shop_schema.py`), its generator (`shop_data.py`), or its products while the backend was stopped | `./tools/shop-data.sh`, `./tools/shop-data.sh refresh`, or `./tools/shop-data.sh embed`. Your own files: `./tools/shop-data.sh import <kind> <file>` (`tools/README.md`). |

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
| | `/what-it-takes` | A question turned into token numbers, passed through a model's layers and answered one token at a time, with the operations, GPUs and energy each model size needs, batching, and training against answering | 2 MB tokenizer |
| | `/tokens` | Tokenizer playground, formats by token count, context budget | 2 MB tokenizer |
| | `/token-counter` | Paste a prompt (and a system prompt) and pick a model, grouped by provider: Claude (current and earlier), GPT, Gemini, Llama, Mistral, Qwen, DeepSeek and the local model. Shows the tokens, the request total with framing, the cost per call, characters and words, the share of the context window, and the text coloured token by token where the tokenizer is published (run on the backend from Hugging Face, `generated/tokenizers/`, about 90 MB once). Claude's tokenizer is not published, so its view counts the prompt word by word with `count_tokens`. Each model is marked exact or estimate (Gemini: Gemma 2's tokenizer). "Every model, side by side" compares them all. Counting is free | None; Claude needs an API key, and the open tokenizers download on first use |
| | `/sampling` | Greedy against sampled decoding, confidence per token | GPT-2, 128 MB |
| | `/atoms-touch` | A short film drawn by the page (three.js, or a flat cross-section without WebGL): two fingertips close in while the gap halves 25 times, from 10 mm to 298 pm, through skin ridges, cells, molecules and atoms; a force-against-distance chart follows the film. Explains why the push is the Pauli exclusion principle rather than plain charge repulsion | None |
| | `/ml` | Seventeen machine learning algorithms, each running live, with when to use them and where they appear in AI | None |
| | `/ml-course` | Machine learning and AI in 25 weeks: the lab's own course, from an orientation week through maths, probability and statistics, evaluation, the classical models, Bayesian optimisation, neural networks and CNNs, tuning, language models, interpretability and fairness, clustering and PCA and reinforcement learning to a capstone. Each week has goals, the lab pages to work through, one task, a Python exercise with tests in `examples/ml-course/`, and a short quiz that explains every answer (three quarters right passes). Progress and best scores stay in this browser | None |
| | `/ml-maths` | Maths for machine learning (course weeks 1 and 2), all in the browser: two vectors to drag (length, dot product, cosine similarity); a 2×2 matrix on sliders moving a grid and a shape, with the determinant as area; a dense layer as W·x + b with a ReLU; a secant turning into the tangent; the gradient on four loss surfaces; the chain rule on a small graph, forward and backward; gradient descent, momentum and Adam from a start you click, with a learning rate that shows divergence, a slow ravine, a saddle and two valleys | None |
| | `/probability-stats` | Probability and statistics for ML (course weeks 3, 4, 5, 10 and 12), on invented data: Bayes' rule as 1,000 people taking a screening test; five distributions; Monte Carlo with error falling like 1/√n; mean against median and the IQR and z rules on an outlier you control; maximum likelihood for a coin and a normal; least squares with residuals; a bootstrap interval for a median; missing data under MCAR, MAR and MNAR against three fixes; entropy, Gini and the best first split of a small table; naive Bayes with smoothing | None |
| | `/model-evaluation` | Evaluating models honestly (course weeks 6 to 8), on invented data: how choosing among many models inflates the validation score; learning and complexity curves; a 2,000-person screening test with a threshold slider driving a live confusion matrix, sensitivity, specificity, precision, F1, ROC, precision–recall and gains charts; a cost per kind of mistake that picks the threshold; plain against stratified k-fold as a fold grid, repeated and nested cross-validation; undersampling, oversampling, SMOTE-style synthesis and class weights, each run right and leaky; time-ordered splits | None |
| | `/tuning` | Hyperparameter tuning and Bayesian optimisation (course weeks 14 and 18): grid against random search where one hyperparameter matters; successive halving against full training on the same budget; a one-input Gaussian process you click to measure, with length-scale and noise, posterior samples and expected improvement, UCB and probability of improvement beneath; Bayesian optimisation against random search in two dimensions over eight runs, including how often it misses a narrow peak; scikit-learn and Optuna code. The Gaussian process is written out with no library | None |
| | `/capstone` | Capstone (course week 25): optimise five invented black boxes (two to six inputs, some noisy, some with a decoy peak) on a budget released over ten rounds, with optional Gaussian-process helpers, a note per round, regret and the optimum revealed only at the end, and a Markdown export for a portfolio README. Progress stays in this browser; `examples/ml-course/capstone/` has the same functions in Python, checked against the page's values | None |
| | `/interpretability` | Interpretability, fairness and documentation (course week 21), on an invented 600-applicant loan model small enough for exact explanations: weights as odds ratios, permutation importance, partial dependence with ICE curves, exact Shapley values over all 16 coalitions with a waterfall, counterfactuals; a proxy that carries an attribute the model never sees; group fairness metrics with a threshold per group and a search showing they cannot all hold at once; a fillable model card and datasheet rendered as Markdown | None |
| | `/reinforcement-learning` | Reinforcement learning (course week 24), seeded so runs repeat: discounting; ε-greedy, UCB1 and Thompson sampling racing with regret curves; an editable slippery grid world solved by value iteration sweep by sweep; Q-learning on the same world; Q-learning against SARSA on a cliff walk; links to RLHF and GRPO in the preference-tuning and reasoning pages | None |
| | `/course` | The LLM course: Stanford CME 295's eight lectures in order, with "What is GPT" as lecture 0, each linked to the labs that teach it | None |
| | `/what-is-gpt` | What is GPT: Microsoft's explainer made hands-on with live GPT-2, corrected where the source is wrong | GPT-2, 128 MB |
| | `/transformer-tricks` | RoPE, RMSNorm, MQA/GQA, sliding windows, FlashAttention, mixture of experts, speculative decoding, continuous batching and PagedAttention (both simulated), and a sourced table of ways to make a model faster: what each improves (memory, latency or throughput), a published figure, the catch and whether an API user can use it, with a fact-check of a popular infographic | None |
| | `/training-at-scale` | LoRA trained live, training memory, data/tensor/pipeline parallelism and ZeRO | None |
| | `/preference-tuning` | Reward models, PPO clipping, reward hacking and the KL penalty, DPO | None |
| | `/reasoning-models` | GRPO live, verifiable rewards, pass@k and majority voting, thinking budgets | None |
| | `/vision` | Images as tokens: a picture (or your own) cut into patches, flattened, projected into tokens, given positions and attention, and joined with text; measured image token costs for Claude and GPT | None |
| | `/hardware` | CPU, GPU, TPU, NPU, LPU and DPU: all six animated side by side on one clock (how each moves data, with play, pause and step), your CPU raced against your GPU (WebGPU), a systolic array multiplying, tokens per second from memory bandwidth for real chips, GPU kernels on a roofline (memory-bound or compute-bound), kernel fusion and tiled attention, quantisation, and DPU offload | None |
| | `/deep-learning` | All 68 notebooks of *Understanding Deep Learning* (Simon J. D. Prince) as interactive demos, chapters 1 to 21, plus an encoder/decoder extra (12.5) | None |
| | `/deep-learning-book` | *Understanding Deep Learning* chapter by chapter: what each offers, every worked example (linked to the notebook demos, with new demos where they add something), where each idea lives in an LLM; then research on making LLMs faster, cheaper and better: a what-if serving estimator and sourced evidence cards | None |
| Building | `/prompting` | Few-shot measured on a test set, constrained decoding, prompt injection | GPT-2, 128 MB |
| | `/embeddings` | Meaning map, RAG with embeddings, BM25 and hybrid search, plus a reranker; then RAG, CAG and reading every section animated side by side on `python/10_rag_vs_cag_vs_kag.py`'s three questions: what each sends, whether every section the answer needs is in it, cache writes and reads (5-minute lifetime, 512-token minimum), and estimated tokens and cost at the lab's prices, with the knowledge base up to 1,000 times bigger | 23 MB, plus 24 MB reranker; the comparison needs the backend for the full handbook and prices |
| | `/store-watch` | A loss-prevention desk on a live webcam (with a camera picker) or an uploaded video file. In the browser, MediaPipe finds each person's pose and the items near their hands (EfficientDet-Lite0), code tracks them with stable ids and draws boxes, skeletons, hands and zones; rules in code follow each visit past editable shelf, till and exit zones (picked up, put back, possible concealment at the body or into a bag, paid at the till, left by the exit without paying, long dwell) into a live event feed and per-person visit strips. The behaviour model on Azure OpenAI is asked only when a rule raises suspicion (plus a slow look at anyone carrying an item), with a burst of frames (faces blurred first unless switched off) and the tracker's events as leads to check, never as sightings; without it, the rules score alone. Each alert carries an 8 to 15 second clip with the overlays, recorded by two staggered MediaRecorders and kept as a file in `generated/storewatch/clips` (deleted with the alert's footage). A named person confirms with one click; a door camera on the same video compares faces with the live watchlist and shows both faces with the score. Live stats, an alert sound and a red flash, a watchlist gallery, retention and an audit log; it opens in demo mode, with governance optional. The scripted day (invented people) still runs without a camera | About 12 MB of pose and item models, 7 MB face model for faces; Azure OpenAI for the behaviour model (optional) |
| | `/workflows` | Every kind of agent workflow on Microsoft Agent Framework: sequential, concurrent, handoff, group chat, maker-checker, Magentic, orchestrator and workers, fan-out/fan-in and routing edges, plan-approve-run, checkpoint and resume, sub-workflows, declarative YAML. Diagrams read from the built workflow; replay real recorded runs free, or run live on Azure (`examples/agent-framework/workflows/`) | None; live runs need Azure OpenAI and `pip install -r examples/agent-framework/requirements.txt`; the YAML one needs its own Python 3.12 `.venv` and a .NET runtime |
| | `/agents` | Tool-use loop step by step: parallel calls, errors, approval | None |
| | `/planning-patterns` | ReAct and planning patterns: one task run four ways at once (a plain tool loop, ReAct with a written Thought before each action, plan and execute with a replanner after a failed step, and reflexion with a critic and one retry), each streamed live with its trace, calls, tokens, time and cost. The tools work on an invented shop (products, orders, policies, a fixed "today", and a warehouse system that fails the first stock check on one task), so code marks every answer against the known right one. Each pattern stops at a step cap (14 model calls, 24 for plan and execute) and the run at its budget | Needs the backend; paid |
| | `/cognitive-core` | The cognitive core: Andrej Karpathy's idea that a model of about a billion parameters, which reasons and uses tools while its knowledge lives outside it, could stand in for a big one. Tested, not repeated: a small model (`LLM_LAB_CORE_MODEL`, Qwen 3.5 0.8B) and a big one each answer ten questions three ways, closed book, with retrieval done for it, and with their own search and calculator, over a reference library about an invented island, and code marks every answer. Measured here: the 0.8B got 7 of 10 with retrieval done for it, as many as the 9B from memory managed only 4, but 1 of 10 with its own tools, because it never chose to search; the 9B with tools got 10. Then distillation in the browser: a small student learns more from a teacher's soft probabilities than from bare labels, most of all from few points | Needs the backend and `./tools/local-model.sh --core`; the big model is free when it is the local one |
| | `/building-agents` | Building agents as ordinary software, in the lab's own code: the Messages API request and response, a tool's JSON schema, the same loop written four ways (Claude API by hand, a harness, Agent Framework, Foundry's Responses API), MedAssist's rules as code, testing against the database, and the AI terms in developer words | None |
| | `/agent-types` | Thirteen types of agent (reflex, LLM, tool-using, planning, memory, multi-agent, hierarchical, self-improving, RAG, code, web browsing, computer use, autonomous): what each is for, when not to use it, and where each is built in the lab, with the command that runs it. Six are lesson scripts made for it, `python/20` to `25`; the browsing and computer use agents drive headless Chrome with Claude's browser and computer toolsets (`python/chrome_driver.py`) | None; the scripts need an API key, and 24 and 25 need Chrome and `websockets` |
| | `/context-engineering` | What to put in each request, ordering for caching, long conversations, tool output | None |
| | `/context-window` | The context window filling turn by turn for a chat, a coding agent and a research agent, and four ways to keep it in check: clearing tool results, compaction, sub-agents and notes | None |
| | `/agent-memory` | An assistant on the lab's default model (the local one when set up), Claude or GPT that remembers people across separate sessions, with the fifteen building blocks of agent memory shown as they happen: working, episodic, semantic, procedural and long-term memory; summarisation, retrieval (an always-loaded profile plus matching one-off memories), consolidation, compression, links between memories; decay by half-life, forgetting, conflict resolution by value, provenance (the quote, checked against what the person said) and isolation (one file per person). Claude chooses what to keep with `remember` and `forget` tools; code applies the rules and `python/22_memory_agent.py`'s privacy guard. A scenario plays three sessions for Sam with time jumps, then Priya, on real calls (free on the local model, under a cent on Haiku, about 2 cents on GPT); memory is kept in `generated/agent-memory-lab/` | Needs the backend and an API key |
| | `/memory-stores` | Memory stores, as in Claude Managed Agents but kept on this machine: folders of small text files a coding agent reads and writes across sessions. Tick stores under Memory on `/coding-agent` and each is mounted as `.memory/<store>/` (read-write or read-only), named in the agent's instructions with its description and an index of its files; a Stop hook sends a run back until it has written to a read-write store (at least a session note), and when each run ends its changes come back as versions signed by the session. Changes to a read-only store, and anything holding a key or token, are refused and put back. The page lists stores and files, shows a memory rendered or raw with who changed it, edits and deletes, and shows each memory's versions, with restore and redact. Kept in `generated/memory-stores/`; works on the local model, Claude and GPT | Needs the backend |
| | `/harness` | Autonomous agents: watch one work until done, and switch off harness features to see what breaks | None |
| | `/coding-agent` | Coding agent: a harness built the way Claude Code is, working on a small project with failing tests. File tools that refuse blind edits, a shell behind deny and allow rules, four permission modes, hooks, `CLAUDE.md`, a to-do list, checkpoints you can undo, a read-only sub-agent, context clearing, eyes (`read_file` returns images; `screenshot` renders a page in headless Chrome so the agent checks what it built), a sandboxed auto mode that asks nothing, and a Stop hook that sends the agent back until the tests pass. The hand-built harness also runs on a GPT deployment (`gpt-5.4-mini`), translated to Chat Completions with the same tools and sandbox; the Agent SDK version is Claude only. Your files is a second workspace: add a spreadsheet (or try the invented sample workbook) and ask for a summary with charts, or a PowerPoint; the agent installs what it needs, looks at its own charts and slides, and you download the results. Each edit's diff waits for your approval. The same task also runs on the Claude Agent SDK, to compare | Needs the backend; the SDK version needs `examples/claude-agent-sdk` installed |
| | `/software-factory` | A software factory on a copy of the practice project: agents take invented backlog tickets (or your own) from plan to merge, and people step in by risk tier. A tested policy sets each change's tier from its kind and area, and evidence found during the work (sensitive paths or calls, new dependencies, big diffs, edited tests, uncovered code) can only raise it. Low-risk changes run dark: a read-only planner plans, an implementer builds in the sandbox, gates check it (no new failing tests against main's baseline, no tests deleted or skipped, no secrets, nothing outside the project, diff size, an independent reviewer agent's verdict, a money and time budget) and it merges with no person. Medium waits for a person to approve the diff; high waits at the plan and the diff, and a person can edit the plan, ask for changes, reject or take over. Agents never see a .git folder: the factory copies their files into its own clone, where git runs with hooks and outside config switched off. Each merge is a git commit; a revert records an escaped defect. Areas earn autonomy after 3 clean changes and lose a level at once on an escape; autonomy never lowers a tier the work itself raised, and high never runs dark. A flow board, the full audit trail per change, the track record by area and metrics (merged, share that ran dark, human steps, escapes, lead time, cost per change) | Needs the backend and the Docker sandbox; paid |
| | `/site-builder` | Site builder: describe an app and Claude writes it (HTML, CSS, JavaScript and JSON, through file tools confined to the site's folder) while it runs live beside the conversation, sandboxed. Each message changes the same app; every turn that changes files is a version (the last 20 kept) you can view as it was or restore, and a restore is itself a new version that Claude is told about. Per turn: what changed (added, changed, deleted files) and the steps, with the screenshots Claude was shown at 1280 and 390 pixels. The preview has desktop, tablet and phone frames, reload, a new tab, full screen and a zip download; errors from the running app (uncaught errors, rejected promises, console.error) are listed under it with "Ask to fix". Apps are listed with screenshot thumbnails, renamed and deleted; everything is kept on disk under `sites/<id>/`. Attach pictures (pasted screenshots included), data files or a PDF: pictures are shown to the model to match their look with original code, data files are copied into the site's `assets/`, PDFs go to Claude only. The message box is the Assistant's: model and effort in a pill, attachments behind + | Needs the backend; paid; Chrome for the screenshot checks |
| | `/shop-assistant` | Shopping assistant: a shop website for an invented retailer (Larkfield & Co.) with an agent, Wren, in a chat widget that asks clarifying questions, finds and compares products, manages the basket, prepares checkouts and returns (placed only when the person presses Confirm), shows orders and suggests things from the shopper's own browsing, orders and wish list. Data lives in the lab's pgvector PostgreSQL (schema `shop`): a seeded generator (20k, 100k or 1M products) or your own JSON Lines/CSV files, checked row by row and never half applied. Each shopper's rows are kept apart by forced row-level security, with the agent's queries running as a separate no-login role; no tool takes a customer. Hybrid search (HNSW vectors plus keywords, fused by rank) in a fixed order, and an answer cache for read-only turns. A trigger and a background worker re-embed changed products (with an outbox or change data capture as the production route). Guests browse with consent-only local history; signing in merges it once. Demo sign-in is a stand-in for real authentication | Needs the backend and `./tools/shop-data.sh` (PostgreSQL, the embedding model for search by meaning, and the data); chat is paid |
| | `/assistant` | A general chat assistant: the model plans (a checklist it updates, with an optional "approve plans first"), then works in the lab's Docker sandbox (bash with internet, file tools, the PDF, PPTX, XLSX and DOCX skills) until it decides it is done, and can start up to four sub-agents that work in parallel in folders of their own. Upload files; get PDFs, decks, spreadsheets and charts back with page previews. Chats are kept and listed; change model (Claude, GPT or the local model) and effort per message with the history carried over, and long chats are summarised automatically or with Compact now. A live log shows every model call, plan, command (network commands flagged), output, file, compaction and model switch, with a lane per sub-agent. Stops at the run's budget (shared by all its agents), its time limit, or Stop | Needs the backend and the Docker sandbox (`./tools/sandbox.sh`, `LLM_LAB_SANDBOX=docker`); paid |
| | `/assistant` (Auto) | Auto routing in the assistant: a switch at the top of the model menu lets the lab pick the model and effort for each message. Clear cases are settled by signals that can be explained in a line (attachments and their kinds, pictures, work for the sandbox, length, work big enough for sub-agents, the last turn, MCP servers); unclear ones by one tiny classifier call to the cheapest Claude model. quick → the local model (if running) or Haiku low, standard → Sonnet medium, deep → Opus high; pictures never go to the local model and PDFs go to Claude only. A refusal, an empty reply, a cut-off or two failed tool rounds move the turn up one tier, once, never past a ceiling the person sets. Each routed turn records its cost against the same tokens on Sonnet, shown on `/control-layer` | Paid |
| | `/mcp` | MCP servers: a real server in the backend; raw requests with and without tokens, Claude using its tools with writes gated by the harness | Needs the backend |
| | `/casework` | Case handling on Azure: multi-agent complaint handling with Azure OpenAI and Azure AI Search, groundedness and rule checks, caseworker approval, a hash-chained audit trail and an evaluation gate | Needs the backend, Azure OpenAI and Azure AI Search |
| | `/medassist` | MedAssist on Foundry: a patient portal chat with a Microsoft Foundry prompt agent that reads the signed-in patient's record, shows free slots, books the one they choose and texts them, beside the practice's systems (record, appointments, texts, audit log) | Needs the backend and a Foundry project with the agent created (`examples/medassist`) |
| | `/medassist/architecture` | MedAssist solution architecture: a diagram of how the components call each other, and every component by lane (channels, our APIs, the two engines and the clinic rules, the practice data, Microsoft Foundry and the Azure services, with the official Azure icons). Select a component to see what it does, where it runs and its files; choose a use case to see which components it passes through; a matrix of components against use cases | None |
| | `/reviews` | Review analysis: a dashboard of 30 product reviews in eight languages. Azure Language in Foundry Tools detects each language, then runs sentiment analysis with opinion mining, key phrase extraction and entity recognition (products, brands, places) with that language set; Claude can read the same review beside it, with English key phrases and a translation | Needs the backend and an AI Services or Language resource (`AZURE_LANGUAGE_ENDPOINT`) |
| | `/aftercare` | Aftercare follow-up agent: post-discharge calls by text or phone, in English or Spanish, to eight invented patients ranked by LACE risk. It checks medicines, asks about warning signs, books a follow-up and writes every answer back to a dummy record, raising tasks for a nurse, pharmacist or care navigator. It runs on Claude with our own tool loop or on Microsoft Agent Framework, under the same rules in code. A simulated patient can answer, phone calls are spoken through Azure Speech, and an evaluation checks eight scripted patients against the record | Needs the backend; Agent Framework needs a Foundry project (`FOUNDRY_PROJECT_ENDPOINT`, `FOUNDRY_MODEL`); voice needs Azure Speech |
| | `/hotel` | Hotel booking agent: a guest books, changes and cancels a room at an invented Whitby hotel by chatting with an agent on Claude, a GPT deployment or the local model. Prices, availability, two-turn confirmation, the 48-hour refund policy, who may see a booking and the deposit are enforced in the tools (`examples/hotel/hotel.py`); one database row per room per night means a room is never sold twice (a front-desk button shows it); card numbers typed into the chat are removed before the model sees them; a pretend payment page takes the deposit; confirmations are written by the code and kept in the guest's outbox as an email and a text, sent for real with `HOTEL_SMS_TO` / `HOTEL_EMAIL_TO` | Needs the backend; real texts need the Communication Services resource |
| | `/deal-close` | Closed-deal agents: mark a deal closed-won in an invented SQLite CRM (`generated/deals/crm.db`) and a chain of eight steps runs, shown as a graph that lights up as it streams. A model reads the win notes, rates each look-alike account and drafts one email each (Claude, GPT or the local model); code finds the look-alikes and scores their similarity, looks up each one's current supplier, turns the scores into a priority with fixed thresholds, and picks a contact. Code also enforces the rules: only contacts who agreed to email, never the won customer's name, at most three emails a day, and nothing sent without a person's approval, with every rule checked again at that moment. Sending is simulated | Needs the backend |
| | `/digital-teammate` | Digital teammate: an AI agent with its own identity in an invented team channel, after the agents Microsoft described for Teams in November 2026, simulated without Teams or its SDK. @mention it and it answers in a thread through six tools, showing its plan and steps; a follow-up carries that thread only. Code checks access at every tool call, applies the supplier rules, does every sum (also behind a capacity widget in the reply), and sends a reply back when a number or citation is not from a record it read or a shortlist breaks a rule. The admin centre turns it off, grants or withdraws record types, allows posts of its own (at most two a day) and shows every tool call under its name. Data in `generated/digital-teammate/` | Needs the backend |
| | `/diet` | A diet planner agent: it asks a few questions, code works out the calorie and protein targets and refuses unsafe cases, the model designs a week of meals, code checks it against allergies, diet, targets and cooking time, and it downloads as a PDF, a shopping list and a spreadsheet. It remembers the person next time, keeping health details only with their agreement. Claude, GPT or the local model (`examples/diet/`) | Needs the backend |
| | `/whiteboard` | An AI whiteboard in four modes, with drawing tools (pen with stylus pressure and smoothing, highlighter, eraser, line, box, ellipse and arrow, eight colours, three widths, grid, undo and redo with Ctrl or Cmd+Z, save as PNG) and a history of boards on the left that reopen in their mode. **Maths**: sketch an equation, graph or shape; a model reads it as data, code checks it (expressions against a whitelist, one retry), and the page plots the function with sliders or turns and cuts a 3D solid; strokes are tidied into exact lines, circles and polygons as you draw. **Guess my drawing**: a word to draw in 40 seconds while a vision model (Haiku by default, at most 12 looks a round, only when the board changed) guesses; code, not the model, decides a match (plain words and a synonym list), and keeps the score and streaks in the browser. **Bring it to life**: a model reads the sketch into balls, boxes and lines, given the page's exact shapes as hints; code checks sizes and positions, and matter-js runs gravity, collisions, bounce and throwing. **Sketch to picture**: gpt-image-2 paints the sketch in a chosen style, with the sketch as its reference image (hidden when no image deployment is set) | Needs the backend |
| | `/songbird` | How a songbird sings two notes at once: an original cutaway bird whose syrinx has two sides, each its own voice (left low, right high), animated from what each side is singing, with the air sacs, windpipe, throat chamber and beak. Seven stylised songs (wood thrush duet, cardinal sweeps handed between sides, waterslager canary left-side rolls, zebra finch buzz, nightingale, lyrebird mimicry) are synthesised live in Web Audio along the bird's own signal path, with a scrolling spectrogram, and SynthBird is playable from the keyboard with breath, glide, grit, windpipe length and throat controls. A model can compose a song as a score; code checks each side's range, that no side sings two notes at once and the length, and sends problems back once | The synth runs in the browser; composing needs the backend and is paid |
| | `/fitness-coach` | A fitness coach that watches your form: MediaPipe's pose landmarker finds 33 points on the body in the browser, code measures the joint angles and checks them against rules for a plank, a wall sit and a lunge stretch (hips sagging or too high, knees over ankles, depth), times the hold and speaks fixed cues when a fault lasts. Asking "How's my form?" (button, space bar or out loud, through Azure Speech or the browser's speech) sends a model the measurements as text, a photo, or both, and the page shows exactly what it got. "Your own pose" learns a pose by being shown it and scores how close you are, normalised for where you stand. A drawn figure with a slider stands in for the camera | The pose model and checks run in the browser; the coach's answer needs the backend and is paid |
| | `/voice-agent` | Voice agent: a conversation-native voice agent built from readable parts. Azure Speech in the browser streams partial and final text, and our own turn detector (voice activity, silence timing and a check of whether the sentence sounds finished) raises StartOfTurn, EagerEndOfTurn, TurnResumed and EndOfTurn. On an eager end the reply starts speculatively with its audio held; TurnResumed throws it away unspoken. Replies stream and are spoken clause by clause (an Azure neural voice, or Kokoro-82M running locally with no cloud), with a per-turn latency timeline and a running median and p95. Barge-in stops playback at once, cancels the model and the voice, and keeps what was heard and not heard in the history. A prosody planner turns the conversation into SSML style, rate and pauses, scaled by an expressiveness slider, and a tested normaliser reads card numbers, UK phone numbers, dates, money, postcodes and references properly. The local voice is set up in `examples/voice-agent/` | Needs the backend; paid (the local voice is free) |
| | `/extraction` | Structured extraction, the Claude Certified Architect exam's Scenario 6, on 24 invented, labelled invoices, receipts and purchase orders in varied layouts: extraction as a tool with a JSON schema (required against nullable fields, `other` with detail, `unclear`), `tool_choice` auto, any and forced, semantic validation with a retry that carries the specific errors and stops when the fact is not in the document, few-shot examples for varied layouts, the Message Batches API (custom ids, polling, resubmitting only failures), confidence calibration with review routing and stratified spot checks, accuracy by document type and field, and an A/B comparison of two models on accuracy, latency and cost | Needs the backend and Claude; a batch and full runs cost a few cents on Haiku |
| | `/support-desk` | Support desk agent, the Claude Certified Architect exam's Scenario 1: an invented shop's support agent with four MCP-shaped tools (`get_customer`, `lookup_order`, `process_refund`, `escalate_to_human`) and an agent loop in our code driven by `stop_reason`. Each mechanism runs and has a switch: a gate in code (no refund or order look-up until a customer is verified), a pre-tool hook (refunds over $500 blocked and sent to escalation), a post-tool hook (Unix, ISO and `03/11/2026` dates and numeric statuses normalised, shown raw and normalised), structured errors (`errorCategory`, `isRetryable`; a transient outage retried, a closed refund window explained, "no orders" kept as a success), vague against clear tool descriptions with a six-request selection test, an unneeded `delete_account` tool to show capability bloat, `tool_choice` auto, any and forced, escalation rules with few-shot examples and a structured handoff, case facts kept outside the history, and order records trimmed from about 40 fields to 6. "Run all" streams eight scripted customers, scores the outcomes from what the tools did and reports first-contact resolution; there is also a free-text chat. `examples/claude-agent-sdk/support_agent_sdk.py` is the same agent on the Agent SDK | Needs the backend; paid |
| | `/model-failover` | Model failover: an agent that keeps working when its model is rate limited (429) or overloaded (529, 5xx). Its model list and router also serve every other page (`LLM_LAB_FAILOVER`, on by default): a call to a listed model that fails moves to the next one, the breakers are shared, and the page lists the latest switches anywhere in the lab. It switches model mid-conversation, between model calls, with the whole history in the lab's own store (Azure Blob for each step and Table Storage for the index, Azurite locally, or files in `generated/model-failover/`; SQL Server later behind the same interface). A router with a circuit breaker per model, models and their order read from `config/model-failover.json` or Table Storage (switchable live, editable on the page), fault injection to try it, memory compaction with settings, and the same design in Microsoft Agent Framework and LangGraph (`examples/model-failover/`) | Needs Claude; a GPT deployment adds a model |
| | `/research-team` | Research team, the Claude Certified Architect exam's Scenario 3: a coordinator splits a question into sub-questions, chooses which of four subagents to call (search, analysis, synthesis, report), runs independent delegations in parallel, checks coverage after synthesis and re-delegates targeted searches (two rounds at most). Subagents start with an empty context and get earlier findings in full in their prompt, shown on the page; each has only its own tools. Transient failures retry inside the subagent, access failures go up as structured errors, and empty searches stay valid. Findings carry claim, evidence, source and date, checked by code; conflicting and older figures are kept apart. Each run writes a manifest to `generated/research-team/<run>/` and can be resumed. Uses an invented 14-source corpus about heat pumps | Needs the backend; paid |
| | `/review-passes` | Code review run several ways on one invented refunds change set (5 files, 6 seeded problems, one visible only across files, plus style noise and acceptable local patterns), each scored against an answer key for found, missed, false positives, precision, tokens and cost: vague against explicit criteria, one pass against per-file passes plus an integration pass, self-review against an independent reviewer, findings routed by confidence with dismissed ones grouped by `detected_pattern`, and a CI re-run reporting only new or still-open findings in the `examples/claude-code/ci/review-schema.json` schema. Also explains Agent SDK `resume`, `fork_session` and `continue_conversation` (`examples/claude-agent-sdk/sessions_sdk.py`) | Each mode needs the backend and is paid (the passes mode makes 7 calls) |
| | `/claude-at-work` | Claude at work, the practical lab for the Claude Certified Associate exam (people who use Claude in the apps, no code): which feature fits which job (chat, Projects, Artifacts, Research, connectors, memory, Skills, file creation), matching Haiku, Sonnet and Opus to a task, context and memory, output formats, how the same instruction is read in claude.ai, Claude Code and the API, responsible use and explaining Claude to stakeholders, with sources and a check date. Live tools: a prompt template per task type (one goal under two types side by side, or decomposed into steps), one answer rewritten for two or three audiences, checking an answer against its source (claims supported, contradicted or unverifiable, details to check, signs of bias, a review verdict that code can raise but never lower), and whether a task is a good use (verdict, data issues, a redacted description, when to escalate) | The static sections work offline; the five tools need the backend and are paid |
| | `/delivery` | Delivery and governance: discovery, choosing the pattern, value pillars, integration choices (MCP, API or CLI, agent-to-agent; capability bloat; progressive discovery; authentication gaps), observability at scale, compliance (GDPR, HIPAA, FedRAMP, with only verified facts about Anthropic and cloud providers), risks and ethics, and the life cycle with an ADR, using MedAssist as the worked example. Paste a business brief and get a structured design (requirements, pattern, components, value measures, risks and compliance flags, evaluation plan, SLAs, open questions, ADR draft), checked by code and retried once | The design tool needs the backend and is paid; the rest is static |
| | `/multicloud` | One AI architecture on three clouds: five use cases (RAG assistant, agentic workflow with approvals, document extraction, classic ML scoring, real-time voice) drawn as the same 13 building blocks, with a switch that names every block on Azure, Google Cloud, AWS or Databricks and says what differs. Claude on Microsoft Foundry, Vertex AI and Bedrock with keyless client code for each, and where the agent frameworks fit. A worksheet turns eight drivers (residency, existing estate, latency, load shape, sensitivity, open models, team skills, budget model) into architecture decisions with a reason each, as ADR lines. The six differences that change a design (keyless identity, capacity models, where the model runs, private networking, content safety, cost attribution), and a check on whether a second cloud is worth its cost | None |
| | `/vector-db` | A vector database you run yourself: PostgreSQL with pgvector in Docker (`./tools/vector-db.sh`, on `127.0.0.1:5433`, data kept in a volume). Documents are cut into chunks under their headings, embedded by the local embedding model, and stored with a full-text index; a question is answered three ways, by meaning (cosine distance on an HNSW index), by words (Postgres full-text search) and both fused (reciprocal rank fusion, in SQL), each with the SQL it ran and the plan Postgres chose. A model can then answer from the fused chunks, citing them; code checks every citation. Each document has an access group (everyone, hr, managers) and tags: a search or answer runs as a chosen reader, switching to an unprivileged `vector_reader` role with the reader's groups, and a PostgreSQL row-level security policy hides every other chunk from every query (superusers skip such policies, so searches never run as one); an invented restricted set (salary bands, a board plan) shows it. Rows record the embedding model, because vectors from two models cannot be compared. `LLM_LAB_PGVECTOR_URL` points it elsewhere, such as Azure Database for PostgreSQL | Needs the backend, Docker, and `LLM_LAB_LOCAL_EMBED_MODEL`; the answer is paid |
| | `/ai-stack` | AI tech stack map: all 89 entries of a widely shared AI tools chart (models, agent frameworks, RAG, embeddings, MCP servers, AI security, observability, memory, agent SDKs, automation and vector databases), each marked as on a lab page, running as an example, waiting for an account, or explained, with the result of its run. The examples are in `examples/stack/` and `examples/sdks/` | Static page |
| | `/graphrag` | GraphRAG on the vector database's collections (or an invented company's memos, loaded with one button): a model reads each chunk and lists its entities and relationships (structured output, at most 40 chunks a build, cost shown before it starts); code merges mentions by normalised name, finds communities with the Louvain method, and a model summarises each. All of it is stored in PostgreSQL beside the chunks (`graph_entities_<dims>`, `graph_relations_<dims>`, `graph_communities_<dims>`). One question is then answered three ways side by side: plain vector RAG, local search (nearest entities, a walk of up to two relationships as one recursive SQL query, and their chunks) and global search (map over community summaries, reduce to one answer), each citing what it was given, checked by code, and lit up on a drawing of the graph | Needs the backend, Docker, the local embedding model; building and answering are paid |
| | `/semantic-cache` | A semantic cache in front of a model, on the same pgvector database: an HR help desk for the invented handbook stores each answer with the question's vector, and a close enough question gets the stored answer with no model call. Seven preset pairs, scored free by the local embedding model, show the catch: questions differing in one number or verb ("carry over 5 days" and "10 days", "book" and "cancel") score higher than true paraphrases, so no threshold is safe. A candidate must therefore also pass a code check (the numbers match) and a yes-or-no check by a small model before it is served. Entries are scoped by answering model, prompt version and user, and expire. Compares KV caching, prompt caching and semantic caching | Needs the backend, Docker, and `LLM_LAB_LOCAL_EMBED_MODEL`; misses and checks are paid |
| | `/tabular` | Tabular foundation models: TabPFN (pre-trained on millions of invented tables; predicts a new table by in-context learning, with no training on it) against gradient boosting on the same split of a CSV, uploaded or one of three invented samples. A model suggests the target from the column summary only (code checks it is a real, usable column) and explains the result; code computes every metric and checks the explanation uses no number that is not in the results. TabPFN v2 runs on the CPU in its own environment, `examples/tabular/.venv` (about 1.3 GB: `cd examples/tabular && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt`) | Needs the backend and that environment |
| | `/lora` | Fine-tuning with LoRA on this machine: SmolLM2 135M or 360M Instruct (Apache 2.0) learns to turn invented customer emails into one JSON object in a fixed shape. Code writes 400 emails and their answers (340 to train, 60 held out) and scores the model on 40 held-out emails before and after: valid JSON, exactly the right keys, each field, every field. Rank, alpha, layers, learning rate and steps are chosen on the page, which shows the numbers trained against the model's size, the loss as it falls, time and GPU memory, side-by-side answers, the adapter's file size, and a check that merging the adapter into the weights changes no answer. Saved adapters can be tried on your own email beside the base model. A saved adapter can be published to Hugging Face from the page: it writes a model card from the adapter's own scores (editable), uploads only the weights, the config (naming the base model by its Hub id, not a local folder) and the card, private by default and only after you confirm, using the account `examples/lora/.venv/bin/hf auth login` signed in (the lab never sees the token); `examples/lora/publish_adapter.py` does the upload. A table works out memory for full fine-tuning, LoRA and QLoRA from each model's shape; QLoRA's 4-bit loading needs CUDA, so on a Mac the page trains LoRA. Runs in `examples/lora/.venv` (about 1 GB: `cd examples/lora && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt`); free | Needs the backend and that environment |
| | `/image-to-3d` | One photo to a 3D object with Idol (Speridlabs, Apache 2.0), on this machine: it removes the background, samples a shape with a diffusion transformer and decodes it into 32,768 to 1,048,576 Gaussian splats, saved as a standard 3DGS `.ply` and shown in the browser with Spark (three.js), turnable and zoomable. Steps, Gaussians, seed and photo or rendered image are chosen on the page, which shows each stage with its time, Speridlabs' published timings, and the image Idol saw. Objects are kept in `generated/image-to-3d/`. Runs in `examples/image-to-3d/.venv` (`cd examples/image-to-3d && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt`), after accepting the terms of two gated encoders on Hugging Face (DINOv3, FLUX.2-dev) and `hf auth login`; about 5 GB of weights on first use. On a Mac it runs through MPS: about 80 seconds to generate at 10 steps and 65,536 Gaussians, after the weights load; free | Needs the backend and that environment |
| | `/mlops` | MLOps, the classic machine learning life cycle on an invented churn model: a clickable loop of the eight stages (data, features, train, evaluate, register, deploy, monitor, retrain) with what each produces, who owns it and what breaks without it; five tracked runs to promote, with warnings for choosing by test score, old data versions and overfitting; a model registry with champion and challenger aliases, lineage and a promotion gate (quality, beats the champion, recall gap across segments, latency, sign-off) with one-change rollback; a feature store's point-in-time join against a latest-value join (99.7% offline, 70.8% in production); shadow, canary, blue-green and A/B releases simulated with automatic rollback; data drift with PSI and KS on a slider and a retraining decision (drift alone means investigate); maturity levels 0 to 2; one table of tracking, registry, feature store, pipelines, serving and monitoring across MLflow, Azure Machine Learning, Vertex AI, SageMaker, Databricks, Kubeflow and Airflow. `examples/mlops/` runs the same steps with MLflow in its own environment | None |
| | `/data-integration` | Data platforms and integration for AI, all in the browser on invented data: twelve support tickets from two loads (replays, four date formats and an impossible one, an empty ticket, a renamed column, three spellings of one product, phone numbers and emails) flow through bronze, silver and gold into a feature table and a vector index, with five quality rules to switch on and the damage each missing rule does downstream; open table formats (Delta Lake, Iceberg) and time travel for reproducible training, and where Databricks, Fabric, BigQuery, Snowflake and S3 with Glue fit; a store chooser by access pattern (relational, document, key-value, wide-column, vector, graph, search, warehouse) with when to pair them; an AI gateway simulation of three apps sharing capacity (per-app token limits, a semantic cache, provisioned capacity with pay-as-you-go spillover, a circuit breaker in an outage, chargeback per app) with the matching API Management policies; event streaming into a vector index (partitions and keys, consumer groups, checkpoints, a crash and redelivery, an idempotent consumer, a dead-letter queue, replay); queues, streams, webhooks and batch, async request-reply for long agent jobs, and the integration patterns (outbox, saga, CDC) | None |
| | `/code-graph` | A code knowledge graph: this lab's own code, an uploaded ZIP or a public GitHub repository, read by code in four passes (files; Python parsed with `ast` and JavaScript/TypeScript with oxc through rolldown's parser, in a Node subprocess; imports joined to files; calls joined to functions by name, so the call graph is approximate and each edge says how it was matched). Archives are unpacked with path, link, size and count checks, and nothing is run. An interactive force-laid graph with filters, focus depth, search and a side panel of each node's code and links; questions are answered by a model (Claude, GPT or the local model) through seven tools over the graph, and the nodes it used light up. Cached in `generated/code-graph/` | Needs the backend |
| | `/brain-check` | A brain health check: five short thinking tasks in order (remember five words, the day and date, draw a clock, name animals for a minute, recall the words), then 14 questions on the risk factors in the 2024 Lancet Commission on dementia. A model reads the clock drawing and picks the animals out of what was said; code scores every task, compares with the person's earlier checks (kept only if they agree, in `generated/brain-check/`), chooses one of four fixed outcomes and makes a PDF to take to a GP. A screening demonstration, not a medical test: the thresholds are illustrative | Needs the backend |
| | `/scan-explainer` | A scan explainer: upload a picture of an X-ray, a CT or MRI slice or an ultrasound, and a model (Opus by default) fills in a fixed form: what it can see, where, how sure, what the picture cannot tell, what it could be consistent with, and questions to ask the doctor. Code checks the file, rejects wording that states a diagnosis or suggests treatment (one retry, then nothing is shown), and writes the notices and the urgent message. Nothing uploaded is stored. It does not diagnose | Needs the backend |
| | `/gaze-pointer` | A hands-free pointer: the webcam follows the eyes and head (MediaPipe FaceLandmarker in the browser, from jsDelivr and Google's model store) to move a pointer over a practice area, and a face movement the person chooses clicks: opening the jaw, pressing the lips (a clench), a long blink, or keeping still. Code does the rest: a nine-point least-squares calibration, a One Euro filter, a click threshold set from the person's own resting and clicking, an accuracy check and a practice task. The camera never leaves the browser. A page cannot move the system cursor, and AirPods' motion sensors are not open to the web, so both are done on the page; a mouse demo runs the same steps without a camera | 4 MB, from CDNs; no backend |
| | `/data-agent` | Data agent: a workbook on an invented engineering warehouse (pull requests, reviews, issues) for three companies, with row-level security: you sign in as someone, and every query sees only their company's rows. Claude writes the query, runs it on the database, and sets the chart and dashboard tiles from the rows that come back, with every step shown. It works through the semantic model first (field names, compiled to parameterised SQL), adds a field when the model lacks one, and writes its own SQL when the model cannot express the question. All SQL runs read-only, with an authorizer, one statement, 5,000 rows and 5 seconds at most. The field list and an editable SQL tab run the same checks at no cost | Needs the backend |
| | `/content-understanding` | Content Understanding and vision: an invoice, a claim form, three gpt-image-2 photos, a narrated video and audio, as Markdown and fields with confidence and source boxes; custom analyzers (extract, classify, generate); standard against agentic mode; captions, alt text, answers with visual evidence, regions and visual policy checks from gpt-5.4-mini | Needs the backend and an AI Services resource in a Content Understanding region, with gpt-4.1-mini and text-embedding-3-large deployed |
| | `/image-generation` | Image generation: gpt-image-2 from prompts and reference images, inpainting with a mask painted on the page, Content Credentials (C2PA), a visible watermark and brand checks; video generation (Sora 2) explained with code | Needs the backend and a gpt-image-2 deployment (`AZURE_MEDIA_ENDPOINT`) |
| | `/search-pipeline` | Search pipeline: every modality through Content Understanding, chunked, enriched with key phrases, embedded and indexed in Azure AI Search; keyword, vector, hybrid and semantic search scored on 12 labelled questions; index health; search as an agent's tool; the equivalent skillset | Needs the backend, an AI Services resource and Azure AI Search |
| | `/translation-speech` | Translation, text analysis and speech: Azure Translator with a glossary against gpt-5.4-mini, transliteration and the dictionary, a complaint in any language as a schema-checked log entry, speech to text with phrase lists, speech translation, and questions over audio | Needs the backend, an AI Services resource and Azure Speech |
| | `/video-translate` | Video translation: upload a video (up to 200 MB and 5 minutes). ffmpeg takes the sound out, Azure Speech fast transcription writes down each phrase with its time and identifies the language among the 18 the lab has voices for, and Azure Translator translates each phrase into the language chosen in the dropdown. Watch it with subtitles under the video, hear it spoken by that language's neural voice in step with the video (a phrase too long for its slot is spoken up to 1.5× faster), or both; download the subtitles as WebVTT. The transcript is kept per upload and each translation per language, so changing the language does not transcribe again. Files stay in `generated/video-translate/`; the sound goes to Azure. Keyless, through the AI Services account | Needs the backend, `AZURE_LANGUAGE_ENDPOINT` and ffmpeg |
| | `/claude-code` | Claude Code setup: CLAUDE.md and path-scoped rules, skills and commands (team or personal, `context: fork`), hooks (with a clickable chart of the whole lifecycle: all 33 events, what each one's matcher, exit code 2 and JSON output do), subagents, plugins, MCP servers and their scopes (with one tool call stepped through end to end: `initialize`, `tools/list`, the Messages API request, `tool_use`, the permission check, `tools/call`, the server's own API call and `tool_result`, each with its message on the wire), plan mode or direct execution, iterative refinement, `claude -p` in CI with `--json-schema`, and the VS Code and JetBrains integrations, with best practices. Ends with a map of where each task statement of domain 3 of the Claude Certified Architect exam is covered. Copyable files in `examples/claude-code/`, including a pull request review workflow in `ci/` | None |
| | `/claude-code-inside` | Claude Code behind the scenes: an animated, step-by-step tour for presenting, fifteen chapters from `/init` to rewind, including an advanced hooks chapter that plays out the other 28 hook events with the lifecycle chart lit at each step, named and forked sessions, and running headless in CI. Press P for presenter mode | None |
| Quality and safety | `/evals` | Test sets, three kinds of grader, confidence intervals, run-to-run variance | GPT-2, 128 MB |
| | `/confidence` | Calibration, reliability diagrams, routing doubtful answers to a person | GPT-2, 128 MB |
| | `/benchmarks` | What benchmarks test, pass@k, significance, contamination, Elo and Bradley–Terry arenas | None |
| | `/injection` | Attack a toy agent and see which defences hold | None |
| | `/red-team` | Adversarial testing, automated: an attacker model writes attacks in seven strategies (direct override, role-play, payload splitting, encoding, indirect injection through an order note, multi-turn escalation, social engineering), alongside a fixed seed set, and each is played against an invented shop's support agent with a random canary code in its instructions and two recorded tools. Four defences can be toggled (stricter instructions, an input classifier, an output filter, tool checks in code). Code scores what it can see (the canary as written, spaced, reversed, ROT13, base64 or hex; a refund over £50 or on another customer's order; another customer's details), and a judge model reads only the rest against a rubric shown on the page. Results by strategy and by defence; a run's attacks can be saved as a regression suite (`generated/red-team/suites/`) and replayed word for word to see what was fixed and what regressed. Runs in the background, with an estimate first and a cost cap | Needs the backend; paid |
| | `/guardrails` | Guardrails: Azure AI Content Safety (harm categories with thresholds, a custom blocklist, image moderation, protected material), Prompt Shields for jailbreaks and injected instructions in documents and pictures, groundedness detection, PII redaction, a guarded pipeline that sends, holds or blocks, a labelled test set, and the deployment's own content filter | Needs the backend and an AI Services resource; groundedness runs on `AZURE_MEDIA_ENDPOINT` |
| Cost and operations | `/context` | Prefill and decode, KV cache memory, conversation cost with caching | None |
| | `/prompt-caching` | Prompt caching request by request: the whole conversation sent every time, the matching start reused, the new part worked through, the usage fields and the bill with and without it, and how Azure OpenAI's caching differs | None |
| | `/routing` | Large, small, cascade or router, compared on cost per correct answer | None |
| | `/control-layer` | AI control layer: one checkpoint under the model gateway sees every model call (the pages, and the coding agent, harness, skills and decks that use the client directly; Claude, GPT and the local model). A part of the lab, or a virtual key for an outside coding agent, can have a policy: allowed models and highest effort (403), daily and monthly budgets and requests per minute (429), routing to one model or to a cheaper one after a share of the budget, refusing requests that contain API keys or private keys, and masking email addresses and phone numbers. Budgets are held before each call and settled after, so two calls at once cannot both take the last of one. The page shows spending by consumer, model and day, projections, routing savings, refused calls, virtual keys (shown once, kept as hashes, revocable) and the audit log. `/control/v1/messages` is an Anthropic-compatible proxy for tools such as Claude Code (`ANTHROPIC_BASE_URL=http://127.0.0.1:8000/control`, `ANTHROPIC_AUTH_TOKEN=<key>`), local only and under the key's policy. Kept in `generated/control-layer/` | Needs the backend; the proxy's calls are paid |
| | `/pareto` | Quality, cost and time as one choice: the Pareto frontier of a field of invented models (each effort setting its own point) in a 3D chart you turn by dragging, with the frontier among open-weight models and the best corner marked; the two flat frontiers (quality against cost, against time) and the models each one hides; tables of the frontier; the best model under a budget and a deadline per task; how to read such charts honestly; and real data pasted in as CSV, with every bad row reported. Nothing leaves the browser | None |
| | `/effort-and-cost` | Why a bigger model or more effort costs more: tokens drawn as they flow, the bill for each model and effort, the agent staircase, and cost per finished task | None |
| | `/local-model` | Running an open model on this machine: provisioning with `tools/local-model.sh`, `.env`, the daily commands, how the model client routes to Docker Model Runner, what it refuses, one local model at a time, troubleshooting; a live line says whether your model is configured, running and pulled | None |
| | `/observability` | Monitoring and traces: every model call the backend makes (time, the lab area and route that asked, the model that answered, tokens, cost, latency, errors and fallbacks), as metrics with p50/p95 latency, spend by area and by model, a log of recent calls, and traces that put one request's calls on a timeline. Counts and timings only, no prompt or reply text; kept in `generated/observability/calls.jsonl` (capped). How it maps to OpenTelemetry and Foundry tracing | Needs the backend |
| | `/resilience` | Rate limits: ten minutes of traffic against rate-limited deployments, with backoff, failover, a smaller model, a circuit breaker and a region outage | None |
| | `/llmops` | LLMOps: shipping AI changes safely. What changes in an AI system and how each is versioned (code, prompt, model version, retrieval index, tools, guardrail config, eval set). The release pipeline as nine clickable stages (pull request, fake-model tests, offline eval gate with quality, cost and latency budgets, container build, image scan and SBOM, staging, smoke and online evals, canary, promote or roll back): make any stage fail and see what stops. The same pipeline in GitHub Actions and Azure DevOps YAML with workload identity federation, environment approvals and `examples/foundry-cicd/eval_gate.py` as the gate. A multi-stage non-root Dockerfile, a Kubernetes manifest (probes, requests, HPA, workload identity) and an autoscaling day: CPU against requests in progress, slow start-up, provisioning for the peak, and the model's own 429 limit that no number of pods lifts. Where to run it (Container Apps, App Service, AKS, Cloud Run, GKE, ECS on Fargate, EKS). A/B testing: a sample-size calculator, a two-proportion z-test with guardrails (cost, p95, refusals) that can veto a winner, and a seeded A/A simulation that shows why peeking finds false winners | None |
| | `/foundry-operations` | Foundry operations, read live: deployment types and this lab's deployments with lifecycle dates, quotas, rate-limit headers, Azure Monitor metrics, security posture and role assignments, an evaluation with a release gate, an OpenTelemetry trace, and CI/CD with Bicep | Needs the backend and `AZURE_AI_RESOURCE_ID` |
| | `/live` | Real Claude calls: latency, tokens, effort, caching and cost | Needs the backend and an API key |
| Certification | `/claude-associate` | The Claude Certified Associate – Foundations exam map (CCAO-F, 60 questions, for business users of claude.ai): the seven domain weights and all 30 objectives, each linked to the labs that show it. Objectives that are practised in claude.ai itself (Projects, Artifacts, Research, connectors) are marked as such | Static page |
| | `/claude-developer` | The Claude Certified Developer – Foundations exam map (CCDV-F, 53 questions, 120 minutes, 720 to pass): the eight domain weights and all 25 weighted skills from Anthropic's exam guide (version 1.0, July 2026), each linked to the labs that practise it and marked runs here, partly, or explained. A third of this exam is Applications and Integration; Claude Code is 3% | Static page |
| | `/claude-architect` | The Claude Certified Architect – Foundations exam map (the three Claude exam maps share one component, `pages/claude-architect/examMap.tsx`, and link to each other): the format at a glance (60 questions, 120 minutes, 4 of 6 scenarios, 720 to pass), the five domain weights, the six scenarios with the closest lab for each, and all 30 task statements from Anthropic's exam guide (version 1.0, July 2026), each linked to the labs that practise it and marked runs here, partly (naming what is missing), explained or not yet. Also the guide's four preparation exercises and the out-of-scope topics the lab covers anyway | Static page |
| | `/claude-professional` | The Claude Certified Architect – Professional exam map (CCAR-P, 63 questions, $175): the seven domain weights and all 38 objectives, from solution design and integration to governance, compliance, stakeholders and the life cycle, each linked to the labs that practise it | Static page |
| | `/ai-103` | AI-103 exam map: every skill in Microsoft's AI-103 study guide (skills measured as of 16 April 2026), each linked to the labs where it runs or is explained | None |
| | `/ab-100` | AB-100 exam map (Agentic AI Business Solutions Architect): all 74 skills in Microsoft's study guide (skills measured as of 16 November 2026), each linked to the labs where it runs or is explained, or marked as practised in Copilot Studio, Microsoft 365 Copilot, Dynamics 365 or Power Platform | None |

Models load from Hugging Face through transformers.js 4.3.0 on jsDelivr the first time a page needs them, and the browser caches them.

## Live Claude features

Live calls use your Anthropic API key. You create it in Anthropic's developer console. The key stays in the backend and is never sent to the browser.

Put it in a file named `.env` in this folder. Git ignores this file, so the key is never committed:

```sh
umask 077 && echo 'ANTHROPIC_API_KEY=your-key-here' > .env
```

For every other setting, start from `.env.example`, which is committed: `umask 077 && cp .env.example .env`, then put your key in it. Its uncommented lines are the local defaults, so the lab runs with them as they are. The Azure resources, keys and your own phone or email are commented-out placeholders: uncomment one only once you have a real value. `azd up` writes the Azure values for you. `python/settings.py` says what each one does.

A key exported in your shell with `export ANTHROPIC_API_KEY=...` takes priority over the file. Never paste a key into chats, documents or code. If one has been shared, create a new key in the console, delete the old one, and update `.env`.

### The tutor's voice

The tutor (Lab 21) speaks and listens with Azure Speech. Without it, the tutor writes instead of speaking. The backend signs in to Azure in one of two ways; the browser only ever gets a 10-minute token.

- **With your Azure login (no key).** Add the region and the resource ID of an Azure AI Services or Speech resource to `.env`, and sign in with `az login`. Your account needs the **Cognitive Services Speech User** role on that resource; being its Owner is not enough. Training custom speech models (`examples/custom-speech/`) also needs **Cognitive Services Speech Contributor**. The resource must have a custom domain.

  ```sh
  AZURE_SPEECH_REGION=uksouth
  AZURE_SPEECH_RESOURCE_ID=/subscriptions/…/resourceGroups/rg-llm-lab/providers/Microsoft.CognitiveServices/accounts/ai-llm-lab-…
  ```

  Optionally, add `AZURE_SPEECH_FALLBACK_RESOURCE_ID` for a second resource. The tutor uses the first one and switches to the fallback for the rest of the session only when Azure refuses a request, for example when a free tier's monthly allowance or its requests per minute run out.

  The lab's own resources are in the resource group `rg-llm-lab` (UK South) in its subscription, tagged `project=llm-lab`: `speech-llm-lab-knx5wa`, a free-tier (F0) Speech resource used first, and `ai-llm-lab-xxxxxx`, a paid AI Services resource as the fallback. Keys are switched off on both. A £5 monthly budget, `llm-lab-monthly`, emails the resource group's owners at 80% and 100% of actual spend, and when spending is forecast to pass £5.

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

The case-handling lab (`/casework`) runs on Azure only: the GPT deployment above for every agent, `text-embedding-3-small` in the same Foundry resource for embeddings, and Azure AI Search for the council's policies. The search service, `srch-llm-lab-xxxxxx`, is on the free tier in `rg-llm-lab`, with keys switched off and the semantic ranker on its free plan. Your account needs **Search Service Contributor** and **Search Index Data Contributor** on it. The lab creates its index, `casework-policies`, on first use.

```sh
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-small
AZURE_SEARCH_ENDPOINT=https://srch-llm-lab-xxxxxx.search.windows.net
```

A case costs about 2 to 4 cents and takes about 30 seconds; the release-gate evaluation runs all five cases, about 13 cents. The audit log is written to `casework/audit.jsonl`, which git ignores.

The MedAssist lab (`/medassist`) talks to the `MedAssist` prompt agent in the Foundry project named by `FOUNDRY_PROJECT_ENDPOINT` (`FOUNDRY_MODEL` is its model, for pricing). Create the agent first with `python examples/medassist/medassist.py create`. Your account needs the **Foundry User** role on the Foundry resource. The agent's function tools run in the backend against the example's SQLite database, `examples/medassist/data/medassist.db` (ignored by git), so the page and the example's command line see the same bookings. A booking conversation costs well under a cent in model tokens; File Search and the Code Interpreter are charged separately by Azure.

The review analysis lab (`/reviews`) calls Azure Language on the resource named by `AZURE_LANGUAGE_ENDPOINT`, such as `https://ai-llm-lab-xxxxxx.cognitiveservices.azure.com` (the same AI Services resource), signed in with `az login`; keys can stay off. Azure bills one text record per feature for every started 1,000 characters of a review, at $1 per 1,000 records, so analysing all 30 reviews with four features costs about $0.12. The backend keeps each analysis for the session and charges it to `--budget`. Sentiment analysis, opinion mining and key phrase extraction retire from Azure Language on 31 March 2029.

The Aftercare lab (`/aftercare`) runs the follow-up agent in `examples/aftercare/ward.py` against its own SQLite record, `examples/aftercare/data/aftercare.db` (ignored by git), so the page and the example's command lines see the same tasks and bookings. With Claude, the backend runs the tool loop itself. With Agent Framework, an `Agent` on `FoundryChatClient` uses the Foundry project's `FOUNDRY_MODEL` and needs the **Foundry User** role and `az login`. The simulated patient is always Claude Haiku. Running all eight scripted patients costs about $0.03 on Haiku and $0.10 on gpt-5.4-mini. Spoken calls use the tutor's Azure Speech token, with British English and Castilian Spanish voices.

The coding agent (`/coding-agent`) runs `python/19_coding_agent.py` itself (loaded in `shared.py`), one session per copy of `python/coding_project` in `generated/coding-agent/<id>/project`. Each copy is its own git repository, so git commands never reach this one. The page answers the agent's permission prompts through `/api/coding/approve`, reads the files and the diff, and undoes the last change. The Agent SDK run starts `examples/claude-agent-sdk/coding_agent_sdk.py` in that folder's own environment and relays its JSON events; its permission prompts come to the page the same way, over the script's stdin. The agent's `screenshot` tool runs Chrome's own `--screenshot` (Chrome is found as for the site builder, or set `LLM_LAB_CHROME`) and returns the PNG as an image block in the tool result, with the page's console messages; the page shows what Claude saw. A fix-the-tests run costs about $0.002 by hand and $0.005 on the SDK, on Haiku; building and checking a chart page about $0.003. In auto mode every command runs in an OS sandbox (`sandbox-exec` on macOS, bubblewrap on Linux, chosen by `LLM_LAB_SANDBOX`): it writes only in the project and its temp folder, cannot read the home folder or `.env`, and gets a clean environment without the API key, in a `.venv` of the project's own. So `pip`, `curl` and `rm` are allowed; `git push`, `ssh` and `sudo` are not. Where no sandbox works, as in an Azure Container Apps container, auto mode keeps the full deny rules. In the cloud the boundary is a container per session: `LLM_LAB_SANDBOX=sessions` with `LLM_LAB_SESSIONS_ENDPOINT` sends each command, and each screenshot, to an Azure Container Apps dynamic session (a Hyper-V isolated container, called with the managed identity), carrying the project there and back. `examples/coding-sandbox/` has its container, server and two keyless setup scripts: `setup-app.sh` for one shared container app on the Consumption plan (option B, cheapest), and `setup.sh` for a session pool with a Hyper-V container per session (option A). Switching between them changes `LLM_LAB_SESSIONS_ENDPOINT` and `LLM_LAB_SESSIONS_SCOPE`. Whatever the agent needs it installs at runtime: Python packages with pip (the download cache in `generated/agent-tools/` is shared by every session), and programs either inside a cloud session with `apt-get`, or on your own machine through `bash` with `outside_sandbox`, which always asks you. Nothing in a cloud session asks anyone.

The data agent (`/data-agent`) keeps its semantic model, SQL compiler and guarded SQL runner in `backend/app/services/data_model.py` and its tool loop in `services/dataagent.py`. Fields the agent creates live in the session and travel with each query (`custom_fields`), so a dashboard tile can run again on its own. The warehouse is a seeded SQLite file, `generated/data-agent/warehouse.db`, made on first use, with every row tagged by `company_id`. Beside it sits one copy per company (`warehouse-company-<id>.db`), and every query runs on the signed-in company's copy, so the agent's own SQL has no other company's rows to reach; the compiler also adds `company_id = ?` to semantic queries. The page names who is signed in in an `x-lab-user` header, which `api/deps.py` (`data_viewer`) looks up in a fixed directory; in a product that is where the verified sign-in token is read. The cache, workbooks and dashboards (`dashboards.json`) are kept per company. Each tile keeps its query, not its rows, so a dashboard runs its queries again when opened. A question costs about $0.002 on Haiku.

The AI-103 labs (`/guardrails`, `/content-understanding`, `/image-generation`, `/search-pipeline`, `/translation-speech`, `/foundry-operations`, mapped on `/ai-103`) call Foundry Tools and models over REST through one gateway, `backend/app/gateways/foundry_tools.py`, signed in with `az login` and no keys. They use two AI Services resources: the lab's own in UK South (`AZURE_LANGUAGE_ENDPOINT`: Content Safety, Language, Translator, Content Understanding, gpt-5.4-mini, gpt-4.1-mini and text-embedding-3-large) and one in Sweden Central (`AZURE_MEDIA_ENDPOINT`: gpt-image-2, and groundedness detection, which in UK South answers "grounded" to everything without an error). `AZURE_AI_RESOURCE_ID` and `AZURE_MEDIA_RESOURCE_ID` let the operations lab read deployments, quotas, metrics and security settings (read only). Content Understanding needs its model defaults set once (`PATCH /contentunderstanding/defaults`). Generated photos, the sample video and cached extractions go in `generated/` (ignored by git). Prices for these services are in `python/common.py` (`TOOL_PRICES`; gpt-image-2 uses gpt-image-1's rates until it is in the retail price list). Video generation is explained, not run: Sora 2 was closed to new deployments on 2 November 2026.

### GPT in the document automation lab

Document automation (Lab 22) can use a GPT model in Microsoft Foundry for each of its AI steps instead of Claude, with the same prompts and schemas, to compare the two. Pick it under **GPT (Microsoft Foundry)** in the page's model list. Other pages use Claude, or the local model described below.

```sh
AZURE_OPENAI_ENDPOINT=https://ai-llm-lab-xxxxxx.openai.azure.com
AZURE_OPENAI_DEPLOYMENTS=gpt-5.4-mini
```

The deployment `gpt-5.4-mini` (Global Standard) is in the same Foundry resource as the speech fallback, `ai-llm-lab-xxxxxx`, in its project `llm-lab`. Keys are off, so the backend signs in with `az login`; your account needs the **Cognitive Services OpenAI User** role on the resource. It is billed per token on the subscription, at $0.75 per million input tokens and $4.50 per million output tokens, and counts against the backend's `--budget` like Claude.

### A local open model, at no cost per token

An open model can run on this machine in Docker and be the default wherever the work allows. Docker Model Runner, which comes with Docker Desktop, runs it with llama.cpp on the host, so on a Mac it uses the GPU through Metal (an ordinary container cannot). The lab's `/local-model` page covers the same ground with the code, and says whether your model is running. Open Docker Desktop first, then set it up once:

```sh
./tools/local-model.sh             # enables Model Runner on port 12434, pulls the model (6.9 GB), sets a 100k context (LLM_LAB_LOCAL_CONTEXT)
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

`/model-failover` is the production version of the same idea: the lab owns the conversation, so any model can carry on from the last saved step. Its settings:

| Variable | Default | Meaning |
|---|---|---|
| `MODEL_FAILOVER_STORAGE_ACCOUNT` | empty | Azure Storage account for the history, keyless (`DefaultAzureCredential`) |
| `MODEL_FAILOVER_BLOB_ENDPOINT`, `MODEL_FAILOVER_TABLE_ENDPOINT` | empty | The two addresses, instead of the account name |
| `MODEL_FAILOVER_STORAGE_CONNECTION_STRING` | empty | Accepted only for Azurite's development string, never a real key |
| `MODEL_FAILOVER_COMPACT_AT` | 0.7 | Compact when the history reaches this share of the current model's context window |
| `MODEL_FAILOVER_COMPACT_MAX_TOKENS` | 60000 | A ceiling: whichever of this and the share is reached first |
| `MODEL_FAILOVER_KEEP_RECENT` | 4 | Recent turns kept word for word after compaction |
| `MODEL_FAILOVER_COMPACT_MODEL` | empty | Optional override of the model that writes the summary. Empty: the catalog's `compact_model` |
| `MODEL_FAILOVER_MAX_TOKENS` | 1024 | The longest reply a model may write in one call (256 to 8192) |
| `MODEL_FAILOVER_SUMMARY_MAX_TOKENS` | 700 | The longest summary compaction may write (200 to 4000) |

The assistant (`/assistant`) keeps each chat in `generated/assistant/<chat id>/` (the 100 most recent; older idle ones are deleted with their files) and runs every model's commands, Claude's included, in the lab's sandbox, never next to the backend's credentials. The sandbox reaches the internet, so every command that looks like it does is flagged in the page's log.

| Variable | Default | Meaning |
|---|---|---|
| `ASSISTANT_RUN_BUDGET_USD` | 1.0 | What one turn may spend, sub-agents included (0.05 to 20; the page can change it per message) |
| `ASSISTANT_MAX_PARALLEL_AGENTS` | 4 | How many sub-agents may run at once (1 to 8) |
| `ASSISTANT_RUN_TIME_LIMIT_S` | 1800 | The longest one turn may take, in seconds (60 to 7200) |
| `ASSISTANT_COMPACT_AT_TOKENS` | 80000 | Summarise the chat past this size, or 70% of the model's context window if smaller (at least 4000) |

Decks the assistant makes use a professional house style (`python/skills/pptx/scripts/house.py`) unless the chat chooses a brand kit. A brand kit is a folder in `generated/brands/<name>/` (gitignored, so company templates stay on this machine) holding a `.potx` or `.pptx` template, and optionally a logo, `guidelines.md` and a `brand.json` with a display name, colours and fonts. Each kit appears under Deck style in the assistant's + menu; the chosen kit is copied into the chat's `inputs/brand/` before each turn and the agent builds from it.

To point Claude Code (or any client of the Messages API) at the lab, make a virtual key on `/control-layer`, then start it with `ANTHROPIC_BASE_URL=http://127.0.0.1:8000/control ANTHROPIC_AUTH_TOKEN=<key> claude`. Its calls then follow that key's policy and show on the page; the lab's own credentials never leave the backend.

The software factory (`/software-factory`) works on its own git copy of the practice project in `generated/software-factory/` (gitignored; Reset clears it).

| Variable | Default | Meaning |
|---|---|---|
| `SOFTWARE_FACTORY_CHANGE_BUDGET_USD` | 0.5 | What one change may spend across planner, implementer and reviewer (0.05 to 10) |
| `SOFTWARE_FACTORY_TIME_LIMIT_S` | 900 | The longest one change may take, in seconds (60 to 7200) |
| `SOFTWARE_FACTORY_DECISION_TIMEOUT_S` | 900 | How long it waits for a person; no answer counts as a no (30 to 86400) |
| `MODEL_FAILOVER_MAX_ITERATIONS` | 6 | Model calls in one turn before it stops, a safety stop (1 to 20) |
| `MODEL_FAILOVER_COOLDOWN_S` | 30 | How long a failed model is left alone at least before one test call is let through (1 to 600) |
| `MODEL_FAILOVER_MAX_COOLDOWN_S` | 300 | The longest a model is left alone, however long its server asks for (up to 3600) |
| `MODEL_FAILOVER_SHORT_RETRY_S` | 2 | A 429 that asks to wait this long or less is retried on the same model instead of switching (0 to 30; 0 always switches) |
| `MODEL_FAILOVER_CATALOG` | `file` | Where the model list lives: `file` (`config/model-failover.json`) or `table` (Azure Table Storage, in the history's account, keyless) |
| `MODEL_FAILOVER_CATALOG_PATH` | `config/model-failover.json` | The JSON file for `file` mode |
| `MODEL_FAILOVER_CATALOG_TTL_S` | 30 | How long a Table Storage read is cached, so a change made by another instance applies within that time (the file is checked every second) |

The models, their order (the fallback order), context windows and the compaction model are not in the code. `config/model-failover.json` holds them: each entry has a `model` id, a `provider` (`anthropic`, `azure-openai`, `local`), a `context_window` and, for a GPT deployment or local model `python/common.py` does not price, its own `input_per_m` and `output_per_m`. An `anthropic` entry must be one of the lab's three Claude models and is always charged at its list price. A model of `$GPT_DEPLOYMENTS` stands for every deployment in `AZURE_OPENAI_DEPLOYMENTS`. Edit the file (or use the Models panel on the page, which saves through `PUT /api/model-failover/catalog`) and the next model call uses it, with no restart. An edit that breaks a rule is ignored: the last good list stays and the page shows the error. To keep the list in Table Storage instead, set `MODEL_FAILOVER_CATALOG=table` and seed it once with `python -m backend.app.services.model_catalog seed`. Both go through `ModelCatalogRepository`, so a change of store touches nothing else.

With no storage set, history goes to `generated/model-failover/`. The page can override the compaction settings for one conversation.

Live features otherwise use Claude Haiku 5.5 by default, where each action costs a small fraction of a cent. The Live page lets you pick Claude Sonnet 5.5 or Claude Opus 5.5 instead, which cost more. The backend logs the estimated cost of every call, and the Live page shows the running total. Your Anthropic console shows the exact amount billed.

## Other folders

- `python/`: runnable scripts for each lab. See `python/README.md`.
- `tools/`: `setup-local.sh` sets up everything that runs in Docker, in order, by running the scripts below; `setup-envs.sh` sets up the labs' own environments (see [Labs with their own environment](#labs-with-their-own-environment)); `local-model.sh` runs the local model with Docker Model Runner, and `sandbox.sh` and `vector-db.sh` run the coding agent's sandbox and PostgreSQL with pgvector in Docker; `shop-data.sh` sets up and fills the shop's database, and `vector-samples.sh` loads the sample documents; `deploy-frontend.sh` deploys the pages to the public site; `export_gpt2_explainer.py` rebuilds the GPT-2 model with its internals exposed. See `tools/README.md`.
- `examples/tabular/`, `examples/lora/` and `examples/image-to-3d/`: the scripts the `/tabular`, `/lora` and `/image-to-3d` pages run, each in its own environment. Each README says how to set it up and run it without the lab.
- `examples/mcp/`: an MCP server in Python (tools, a resource, a prompt; stdio and authenticated Streamable HTTP), used from Claude Code, from your own harness with approvals, and through the Claude API's MCP connector. Its README covers the design decisions.
- `examples/sdks/`: the same five tasks (structured output, tools, MCP, an agent with human approval, multi-agent) in sixteen SDKs: OpenAI, OpenAI Agents, Claude, Microsoft Agent Framework, Semantic Kernel, AutoGen, LangChain, LangGraph, CrewAI, Strands Agents, PydanticAI, Agno, CAMEL, LlamaIndex (with Workflows), Google ADK and AWS Bedrock Agents, each in its own environment, with a comparison cheatsheet. Bedrock Agents prints SKIP without an AWS account.
- `examples/stack/`: one runnable example for each tool in the AI tech stack that the rest of the lab does not cover, in nine areas (models and embeddings, RAG, MCP servers, security, observability and evals, memory, vector databases, automation). Every tool in an area does the same task on the same data (the Northwind handbook and 12 gold questions), each in its own Python 3.12 environment; `python3 examples/stack/run_all.py [area]` runs them and writes `RESULTS.md`. Tools that need an account print SKIP with what to set. `CONVENTIONS.md` is the contract every example follows; `/ai-stack` maps it all.
- `examples/model-failover/`: the `/model-failover` design in Microsoft Agent Framework (a fallback chat client and a history provider over Blob and Table) and LangGraph (`with_fallbacks`, a retry policy and a checkpointer over Blob and Table), each with its own environment and tests.
- `examples/voice-agent/`: the local Kokoro-82M voice server the `/voice-agent` page can use instead of Azure, in its own environment (no PyTorch).
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
- `examples/mlops/`: the `/mlops` page's steps with MLflow and scikit-learn, in its own environment: invented churn data, a point-in-time feature join against a leaky one, three tracked runs, the best by validation AUC registered with a `champion` alias, a batch scored through `models:/churn-model@champion`, and a PSI drift check. Everything is kept in `generated/mlops/`; no keys needed.
- `examples/ml-course/`: the Python exercises for the 25-week course (`/ml-course`), in their own environment: one folder per week with a brief and stubs to fill in (`exercise.py`), a worked solution that explains its choices, and tests (`ML_COURSE_SOLUTIONS=1` runs them on the solutions). Each idea is built in NumPy first, then checked against scikit-learn or SciPy; weeks 15 to 17 and 20 also use PyTorch if `requirements-torch.txt` is installed. `capstone/` is the `/capstone` page's five black boxes ported exactly (checked against values from the page's own code), with a query budget, a CSV log in `generated/ml-course/capstone/`, a Gaussian-process starter and a guide to writing it up. No downloads or keys.
- `examples/agents/`: three more Foundry prompt agents, one per common use case: SalesDesk (leads, scoring, follow-ups, calls), ResearchDesk (monitoring, cited reports) and DayPlanner (calendar, inbox, to-do list), each with a dummy database, its rules enforced in its tools, and six checked test cases. Five more build the intended uses in the Agent Service's Transparency Note (healthcare staff orientation, retail gift guidance, council request triage, lesson research, factory stock and rotas), each with a review queue that only a person can clear (`run.py <agent> review`).
- `azure.yaml` and `infra/`: every Azure resource the lab uses, for `azd up` (it writes `.env`) and `azd down --purge`. See `infra/README.md`.
- `.github/workflows/infra.yml`: on main, `azd provision` and then the evaluation gate, signed in with OpenID Connect. `infra/pipeline.sh` sets up its identity, its roles and its repository variables.
- `examples/coding-sandbox/`: the coding agent's shell for the cloud. A small server and Dockerfile (with Chromium, for screenshots) for an Azure Container Apps custom container session pool, and `setup.sh`, which builds the image and creates the pool keylessly. The same image runs under Docker on `127.0.0.1` to try it.
- `examples/claude-agent-sdk/`: the coding agent from Lab 46 on the Claude Agent SDK (Claude Code's own harness): built-in tools, permission modes, allow and deny rules, a `can_use_tool` callback, hooks, a sub-agent, `CLAUDE.md` and a `screenshot` tool of its own (`create_sdk_mcp_server`), in its own environment. `sessions_sdk.py` shows session ids, `resume`, `fork_session` and `continue_conversation`; `support_agent_sdk.py` is the support desk agent with SDK hooks and an in-process MCP server.
- `examples/claude-platforms/`: Claude through Amazon Bedrock, Google Vertex AI and Microsoft Foundry (Entra ID) with the Anthropic SDK's platform clients: sign-in, model ids and the features that differ. Compile-checked only; each needs an account on that cloud.
- `examples/managed-agents/`: a Claude Managed Agent, where Anthropic runs the agent loop and a sandbox per session: environment, agent, session and event stream, with a comparison of self-hosted loops, the Agent SDK, Anthropic-hosted agents and Foundry hosted agents. A paid beta; compile-checked only.
- `examples/claude-code/`: copyable CLAUDE.md, skills, hooks, a subagent and a plugin for the Claude Code labs. `hook-lifecycle/` has a working hook for each advanced scenario, a logger on every event with `trace.py` to show the order they fired in, and tests that feed each script its event's JSON (`pytest examples/claude-code/hook-lifecycle`). They are stored under names Claude Code does not load; the folder's README says where each one goes.

## What has been tested

- The original 20 pages in headless Chrome, on the production build served by FastAPI and on the Vite dev server, with no JavaScript or React errors. That includes moving through every page inside the app without a reload, then pressing the keys pages listen for, to check nothing from a previous page keeps running.
- The backend, now with 649 tests (181 when this section was first written) against fake Claude, Azure, Foundry and browser clients, so they need no network, key or credit: routing to the fallback endpoint, streaming, the spending cap, request validation, the protections against other websites and serving the frontend, plus the harness and skills runs, the deck builder, the site builder, the tutor, document automation, the MCP lab, case handling, MedAssist, review analysis, Aftercare, the six AI-103 labs, the data agent and the coding agent.
- Live features against a local mock of the Claude API. No real API calls were made while building that version.
- On 13 November 2026, the labs added for the Claude certification exams (`/support-desk`, `/research-team`, `/extraction`, `/review-passes`, `/claude-at-work`, `/delivery`) were each run live on `claude-haiku-5-5`, including a real Message Batch with a resubmission, and every page and exam-map link was checked in headless Chrome at desktop and phone width. The live runs found three bugs the fake-model tests could not (a structured-output schema too large to compile, batch custom ids the API refuses, and a resume that redid finished work), and a code review found ten more around concurrent requests, refusals and errors part-way through a turn; all are fixed, each with a test.

## Sharing

`npm run build` produces static files in `frontend/dist/`. The labs that need no backend work from any static host that sends every path to `index.html`. The live features and the full GPT-2 explainer need the backend.

Prices and model facts on the pages reflect Anthropic's documentation as of October 2026. Check the pricing page before relying on them.

## Licence and credits

The lab's own code and writing are under the MIT licence (`LICENSE`). Some parts build on others' work:

- The deep learning pages (`/deep-learning`, `/deep-learning-book`) follow *Understanding Deep Learning* by Simon J. D. Prince (MIT Press, 2023) and its notebooks, with the lab's own explanations and demos. The book and its notebooks keep their own licence; see the book's website.
- The architecture diagrams use Microsoft's Azure architecture icons (`frontend/src/components/architecture/icons/`), under Microsoft's terms for those icons.
- The tutor's avatars come from the TalkingHead project, under the licences listed in [Start](#start); two of them are for non-commercial use only.
- Model names, prices and product names belong to their owners. Every company, person, patient and record in the demos is invented.

