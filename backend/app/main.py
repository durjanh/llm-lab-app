"""FastAPI app: the /api routes, plus the built React app and the local model files.

In development the Vite dev server serves the pages and forwards /api and /models here.
After `npm run build`, this app serves everything from one address.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .api import router
from .api.aftercare import CALL_EVENTS
from .api.medassist import LINE
from .container import Container
from .core.errors import ApiError, error_response
from .services.mcp_lab import PATH as MCP_LAB_PATH
from .services.sites import TEXT_TYPES, FileProblem
from .settings import Settings
from .shared import make_client

logging.basicConfig(level=logging.INFO, format="  %(message)s")
for _name in ("httpx", "httpx2"):  # the SDK's HTTP client: one line per Claude call is enough
    logging.getLogger(_name).setLevel(logging.WARNING)


class _QuietShutdown(logging.Filter):
    """On Ctrl+C, uvicorn cancels requests still streaming and logs each as an error with a long
    traceback. That is the intended way to stop, so those records are dropped; lifespan says what stopped."""

    def filter(self, record: logging.LogRecord) -> bool:
        cancelled = record.exc_info is not None and isinstance(record.exc_info[1], asyncio.CancelledError)
        return not cancelled and "timeout graceful shutdown exceeded" not in record.getMessage()


logging.getLogger("uvicorn.error").addFilter(_QuietShutdown())


def create_app(settings: Settings | None = None, client: Any = None, browser: Any = None,
               speech: Any = None, gpt: Any = None, search: Any = None, foundry: Any = None,
               language: Any = None, agents: Any = None, tools: Any = None, phone: Any = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # The MCP lab's server is a mounted app; mounted apps' startup does not run by itself.
        mcp_app = app.state.container.mcp_lab.app
        async with mcp_app.router.lifespan_context(mcp_app):
            yield
        # Ctrl+C: end deck and harness runs now, so their streams close and the server stops in seconds.
        if ended := app.state.container.runs.end_all():
            logging.info("Stopped %d run(s) still in progress.", ended)

    app = FastAPI(title="LLM Lab API", version="1.0.0", lifespan=lifespan,
                  description="Proxies Claude API calls for the lab pages, with a spending cap.")
    app.state.settings = settings
    app.state.container = Container.build(settings, client if client is not None else make_client(), browser, speech, gpt,
                                          search, foundry, language, agents, tools, phone)

    @app.exception_handler(ApiError)
    async def on_api_error(_: Request, exc: ApiError) -> JSONResponse:
        return error_response(exc.status, exc.kind, exc.message)

    @app.exception_handler(RequestValidationError)
    async def on_invalid(_: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ())[1:])
        text = str(first.get("msg", "Invalid request")).removeprefix("Value error, ")
        return error_response(400, "invalid_request", f"{where}: {text}" if where else text)

    app.include_router(router)
    app.mount(MCP_LAB_PATH, app.state.container.mcp_lab.app)  # the example MCP server, with its own token auth

    @app.middleware("http")
    async def tunnel_only_for_call_events(request: Request, call_next):
        """A dev tunnel publishes this server on the internet so a real phone call's events can reach it. A request
        that came through a tunnel or any proxy (it carries X-Forwarded-For) may reach only those events, which
        each need their call's token. Everything else answers only to this machine."""
        if request.headers.get("x-forwarded-for") and not request.url.path.startswith((CALL_EVENTS, LINE + "incoming",
                                                                                       LINE + "events/")):
            return JSONResponse({"error": {"type": "forbidden", "message": "Not available through a tunnel."}},
                                status_code=403)
        return await call_next(request)

    @app.middleware("http")
    async def cache_headers(request: Request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path.startswith("/assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"  # file names change with content
        elif not path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-cache")
        return response

    if settings.models_dir.is_dir():
        app.mount("/models", StaticFiles(directory=settings.models_dir), name="models")
    mount_sites(app)
    mount_frontend(app, settings.frontend_dist)
    return app


# Claude writes these pages, so they run sandboxed: in an opaque origin, they cannot call this
# server's API or read the lab's storage, even when opened outside the preview frame.
SITE_HEADERS = {
    "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-modals allow-popups",
    "Access-Control-Allow-Origin": "*",  # the sandboxed page fetching its own JSON and modules
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
}


def mount_sites(app: FastAPI) -> None:
    """Serve the site builder's sites at /sites/<id>/, for the preview and the screenshots."""

    @app.get("/sites/{site_id}/{path:path}", include_in_schema=False)
    def site_page(site_id: str, path: str, request: Request):
        c: Container = request.app.state.container
        site = c.sites.store.get(site_id)
        if request.headers.get("host") not in c.settings.allowed_hosts | {f"127.0.0.1:{c.settings.port}"} or site is None:
            return error_response(404, "not_found", "Not found")
        try:
            _, file = site.files.resolve(path or "index.html")
        except FileProblem:
            return error_response(404, "not_found", "Not found")
        if not file.is_file():
            return error_response(404, "not_found", "Not found")
        media = TEXT_TYPES[file.suffix.lower()]
        return FileResponse(file, media_type=f"{media}; charset=utf-8", headers=SITE_HEADERS)


def mount_frontend(app: FastAPI, dist: Path) -> None:
    """Serve the built React app. Every non-API path falls back to index.html for client-side routing."""
    dist = dist.resolve()
    index = dist / "index.html"

    # Any other /api address, whatever the method. A page newer than the running backend lands here,
    # so the message says how to fix it instead of a bare 404 or 405.
    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
    def unknown_api(path: str):
        return error_response(404, "not_found", f"The backend has no /api/{path}. If the lab was just updated, "
                                                "restart the backend: press Ctrl+C in its terminal, then python -m backend.")

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str):
        if path == "api" or path.startswith("api/"):
            return error_response(404, "not_found", "Not found")
        if not index.is_file():
            return JSONResponse({"detail": "The frontend is not built yet. Run `npm run build` in frontend/, "
                                           "or use the Vite dev server at http://localhost:5173."}, status_code=404)
        parts = Path(path).parts
        if any(p.startswith(".") for p in parts):
            return error_response(404, "not_found", "Not found")
        file = (dist / path).resolve()
        if path and file.is_file() and dist in file.parents:
            return FileResponse(file)
        # A missing file such as /assets/old.js or /models/x.onnx is a 404, not the app page.
        # Routes have no file extension; /agents.html is an old bookmark the app redirects.
        suffix = Path(path).suffix
        if (suffix and suffix != ".html") or (parts and parts[0] == "models"):
            return error_response(404, "not_found", "Not found")
        return FileResponse(index)


app = create_app()
