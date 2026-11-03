# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

LLM Lab: interactive pages that show how LLMs and the systems around them work. A FastAPI backend (`backend/`) proxies live Claude and Azure calls behind a spending cap; a React + TypeScript frontend (`frontend/`, Vite) has one route per lab. `README.md` is the full reference; keep it in step when routes, labs or setup change.

## Commands

Run everything from the repo root, with the virtual environment active (`source .venv/bin/activate`; use `python3` before that on macOS).

```sh
python -m backend --budget 1 --reload   # backend on 127.0.0.1:8000, restarts on changes in backend/ and python/
cd frontend && npm run dev              # Vite on :5173, proxies /api, /models and /sites/ to :8000

pytest backend                                          # all backend tests (fake Claude client: no key, no cost)
pytest backend/tests/test_api.py::test_status_reports_models_and_spend   # one test
cd frontend && npm run typecheck        # TypeScript only
cd frontend && npm run build            # typecheck + production build into frontend/dist (served by the backend on :8000)
cd frontend && npm run format           # Prettier: 120 columns, single quotes
```

`pytest` must run from the repo root, because tests import `backend.app...`. There is no Python linter configured.

Other environments: `python/` lesson scripts use the root `.venv` (`pip install -r python/requirements.txt`). Each folder in `examples/sdks/` has its own Python 3.12 `.venv`, because the SDKs pin conflicting packages; `python examples/sdks/run_all.py [names]` runs them and rewrites `RESULTS.md`.

## Backend architecture (`backend/app/`)

Layered, with one composition root:

- `api/<area>.py`: thin routers (parse, call a service, shape the response), collected in `api/__init__.py` under `/api`. Routes get services only through `api/deps.py`, never by building them.
- `api/deps.py` also holds the two guards paid routes depend on: `require_lab_page` (localhost `Host`/`Origin` plus the `X-LLM-Lab: 1` header, which forces a CORS preflight the server never approves) and `require_budget`. New paid routes need both.
- `container.py`: `Container.build` constructs every service once. `main.create_app(settings, client, browser, speech, gpt, search, foundry, language)` takes optional fakes, which is how tests replace Claude, Chrome, Azure Speech, Azure OpenAI, Azure Search, the Foundry agent and Azure Language.
- `gateways/`: the only code that touches external SDKs (`claude.py` for Anthropic, `azure_*.py` and `foundry_agent.py` with Entra/`az login` sign-in, `browser.py` driving Chrome over DevTools). Services depend on their small protocols.
- `services/`: the work. Every reply is charged to `SpendTracker`. Long-running work (harness, skills, decks, sites, tutor) runs in a background thread as a `Run` (`services/runs.py`): the worker publishes events, `RunStreamer` sends them to the page as NDJSON, and approval requests wait on the run until the page answers.
- `settings.py`: limits and config, read from the environment. `__main__.py` turns its CLI flags into `LLM_LAB_PORT`/`LLM_LAB_BUDGET` env vars so `--reload` workers see them.
- `core/errors.py`: `ApiError` and the mapping from SDK failures to `{error: {type, message}}` responses.

**Shared with the lesson scripts:** `backend/app/shared.py` puts `python/` on `sys.path` and imports `common` (model list, prices, refusal-fallback routing), `settings` and `data` (sample handbook). The harness and skills services run `python/11_harness_loop.py` and `12_agent_skills.py` themselves, through `importlib`. Change prices or models in `python/common.py` only (Claude's and GPT's); there is no second copy. `shared.py` also loads `examples/medassist/clinic.py` (MedAssist's practice database, rules and tool loop), so the MedAssist page and that example's command line share one implementation.

**Environment variables are read only in `python/settings.py`** (`EnvSettings`, which also loads `.env`). Scripts use `settings.ENV`; the backend's `Settings.from_env()` copies from a fresh `EnvSettings`, and services get values from `Settings`, never `os.environ`. A new variable goes in `EnvSettings` first. `backend/__main__.py` writes `LLM_LAB_PORT`/`LLM_LAB_BUDGET` so `--reload` workers see the CLI flags. The standalone `examples/` projects keep their own config.

The site builder writes into `sites/<id>/site/` through file tools confined to that folder, and `main.py` serves the sites sandboxed (CSP `sandbox`) at `/sites/<id>/`. `sites/`, `casework/` (audit logs), `models/` and `skill_outputs/` are gitignored runtime data.

## Frontend architecture (`frontend/src/`)

- `pages/registry.ts` is the single list of pages (id, route, title, nav label, group, body class, lazy component). Nav and routes are generated from it. To add a page: create `pages/<id>/<Name>Page.tsx` with a `<main className="page-<id>">` root, then add it to `PAGES`.
- Many pages keep their interactive parts (simulations, SVG charts, in-browser models) in a plain-JS `engine.js` exporting `mount(root, life)`, started by `useEngine(rootRef, mount)` (`lib/useEngine.ts`, `lib/lifecycle.ts`). These page components never re-render, so React does not redraw over what the script drew. Any listener on `document`/`window` or timer must go through `life.on`, `life.setTimeout` or `life.requestAnimationFrame` so it stops on navigation. New interactive code is TypeScript.
- Each page's CSS is scoped under `.page-<id>` so pages cannot restyle each other; the transformer page uses `body.tx` instead.
- All backend calls go through `services/apiClient.ts` (`ApiClient`): it adds the `x-llm-lab` header, turns failures into `ApiError` with the server's message, and reads NDJSON streams. Add a `services/<area>Service.ts` rather than calling axios from a page.
- Browser models (GPT-2, embedder, reranker in `lib/`) load transformers.js from jsDelivr; the full-internals GPT-2 is served from `models/gpt2-explainer/` (rebuilt by `tools/`).

## Conventions

- Writing on pages, in docs and in code comments is plain British English: short sentences, says what something does and why, no marketing tone. Match the existing docstring style (a one-line summary that explains intent).
- Claude model ids are `claude-haiku-5-5` (default), `claude-sonnet-5-5` and `claude-opus-5-5`; the backend rejects any other model.
- Azure resources are keyless (Entra sign-in through `az login`); don't add key-based paths except where one already exists (Azure Speech).
- `examples/claude-code/` holds Claude Code config under names Claude Code does not load (`CLAUDE.example.md`, `dot-claude/`). They are lesson material, not settings for this repo.
