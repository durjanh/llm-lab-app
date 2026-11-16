# backend/

Layered, with one composition root (`backend/app/`). The guards on paid routes are in the root `CLAUDE.md`.

- `api/<area>.py`: thin routers (parse, call a service, shape the response), collected in `api/__init__.py` under `/api`. Routes get services only through `api/deps.py`, never by building them.
- `container.py`: `Container.build` constructs every service once. `main.create_app` takes optional fakes for every external service; that is how tests replace them.
- `gateways/`: the only code that touches external SDKs. Services depend on their small protocols.
- `services/`: the work. Every reply is charged to `SpendTracker`. The coding agent (`19_coding_agent.py`) runs on Claude or on a GPT deployment: it keeps the conversation in Claude's format and `to_chat`/`from_chat` translate each GPT call. Long-running work (harness, skills, decks, sites, tutor) runs in a background thread as a `Run` (`services/runs.py`): the worker publishes events, `RunStreamer` sends them to the page as NDJSON, and approval requests wait on the run until the page answers.
- `settings.py`: limits and config, read from the environment. `__main__.py` turns its CLI flags into `LLM_LAB_PORT`/`LLM_LAB_BUDGET` env vars so `--reload` workers see them.
