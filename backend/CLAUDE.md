# backend/

Layered, with one composition root (`backend/app/`). The guards on paid routes are in the root `CLAUDE.md`.

- `api/<area>.py`: thin routers (parse, call a service, shape the response), collected in `api/__init__.py` under `/api`. Routes get services only through `api/deps.py`, never by building them.
- `container.py`: `Container.build` constructs every service once. `main.create_app` takes optional fakes for every external service; that is how tests replace them.
- `gateways/`: the only code that touches external SDKs. Services depend on their small protocols.
- `services/`: the work. Every reply is charged to `SpendTracker`. The coding agent (`19_coding_agent.py`) runs on Claude or on a GPT deployment: it keeps the conversation in Claude's format and `to_chat`/`from_chat` translate each GPT call. Long-running work (harness, skills, decks, sites, tutor) runs in a background thread as a `Run` (`services/runs.py`): the worker publishes events, `RunStreamer` sends them to the page as NDJSON, and approval requests wait on the run until the page answers.
- `settings.py`: limits and config, read from the environment. `__main__.py` turns its CLI flags into `LLM_LAB_PORT`/`LLM_LAB_BUDGET` env vars so `--reload` workers see them.
- Request bodies: every request is held to `MAX_BODY_BYTES` by the middleware. A route that takes less declares it in its route decorator, `openapi_extra=limit(n)`, or for a whole router `default_limit(router, n)`, on a router made with `route_class=LimitedRoute`, which checks it before the body is read (`core/body_limit.py`; a test fails if a limit sits on a router that would not enforce it). There is no list of paths to update.
- Background work that starts and stops with the server (a worker thread, a child process) goes in `Container.lifecycle()` as a `Hook` (`core/lifecycle.py`); the lifespan starts them and stops them side by side within `SHUTDOWN_WAIT_S`.
- A stopped database (`VectorDbUnavailable`) raised in a route becomes a 503 with what to start, through one handler in `main.py`; routes need no wrapper. Work inside a streamed run reports it in its stream.
- Files other processes read (state, conversations, settings): write them with `core/files.write_atomic`, never a fixed `.tmp` name. The backend and a `tools/` script can write the same file.
- PostgreSQL: connect through `gateways/pgvector.connect` (one set of "start the database" messages). Work two processes must not do at once (imports, index rebuilds, creating a table) takes an advisory lock from `gateways/pg_locks.py`, whose keys are namespaced there; never build `hashtext` keys by hand. `CREATE ... IF NOT EXISTS` is not safe from two connections at once, so creating a table takes a lock too.
- A Python script in `tools/` that uses backend code gets its embedder and its error handling from `app/cli.py` (`local_embedder`, `run`), so a person sees one line, not a traceback.

