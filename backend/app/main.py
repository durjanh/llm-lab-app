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
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .api import router
from .api.aftercare import CALL_EVENTS
from .api.medassist import LINE
from .container import Container
from .core.body_limit import FORM_OVERHEAD, MB, BodyLimit
from .core.errors import ApiError, error_response
from .core.telemetry import RequestContext
from .api.control_layer import proxy as control_proxy
from .services.mcp_lab import PATH as MCP_LAB_PATH
from .services.sites import TEXT_TYPES, FileProblem, with_reporter
from .services.site_uploads import MAX_FILES as SITE_UPLOAD_MAX_FILES, MAX_PDF_BYTES as SITE_UPLOAD_MAX_PDF_BYTES
from .services.site_uploads import MAX_IMAGE_BYTES as SITE_UPLOAD_MAX_IMAGE_BYTES
from .services.image_to_3d import MAX_IMAGE_BYTES as MAX_3D_IMAGE_BYTES
from .services.voice_agent import MAX_AUDIO_BYTES
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


MAX_BODY_BYTES = 256 * MB
ASSISTANT_UPLOAD_BYTES = 10 * 20 * MB  # ten files of 20 MB, the assistant's upload limit
SHUTDOWN_WAIT_S = 10


def create_app(settings: Settings | None = None, client: Any = None, browser: Any = None,
               speech: Any = None, gpt: Any = None, search: Any = None, foundry: Any = None,
               language: Any = None, agents: Any = None, tools: Any = None, phone: Any = None,
               workflows: Any = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # The MCP lab's server is a mounted app; mounted apps' startup does not run by itself.
        mcp_app = app.state.container.mcp_lab.app
        shop = app.state.container.shop
        if shop is not None:  # the shop's embedding worker runs with the app, and stops with it
            await asyncio.to_thread(shop.start)
        try:
            async with mcp_app.router.lifespan_context(mcp_app):
                yield
        finally:
            # Ctrl+C: end deck and harness runs first, so their streams close and the server stops in seconds.
            if ended := app.state.container.runs.end_all():
                logging.info("Stopped %d run(s) still in progress.", ended)
            if shop is not None:  # the import stops after its batch (it carries on next time) and the worker with it
                try:
                    results = await asyncio.wait_for(asyncio.gather(*(asyncio.to_thread(f) for f in shop.stoppers()),
                                                                    return_exceptions=True), SHUTDOWN_WAIT_S)
                    for r in results:
                        if isinstance(r, BaseException):  # logged, so the voice shutdown below still runs
                            logging.warning("The shop did not stop cleanly: %s: %s", type(r).__name__, r)
                except asyncio.TimeoutError:
                    logging.warning("The shop's import was still finishing a batch after %d s; it carries on from "
                                    "there next time.", SHUTDOWN_WAIT_S)
            # Voice replies run in their own threads, and the local voice is a child process: end both, waiting a bounded
            # time for a reply that is part way through a call.
            try:
                await asyncio.wait_for(asyncio.to_thread(app.state.container.voice_agent.shutdown), SHUTDOWN_WAIT_S)
            except asyncio.TimeoutError:
                logging.warning("Voice replies were still finishing after %d s; the server stops without them.", SHUTDOWN_WAIT_S)

    app = FastAPI(title="LLM Lab API", version="1.0.0", lifespan=lifespan,
                  description="Proxies Claude API calls for the lab pages, with a spending cap.")
    app.state.settings = settings
    app.state.container = Container.build(settings, client if client is not None else make_client(), browser, speech, gpt,
                                          search, foundry, language, agents, tools, phone, workflows)

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
    app.include_router(control_proxy)  # /control/v1/...: the Messages API for outside agents, by virtual key
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

    # No body is read past its route's limit. The default sits above the largest upload any page sends (a 200 MB video
    # to translate); a route with a much smaller limit of its own is listed so it never takes in more than that.
    app.add_middleware(BodyLimit, default=MAX_BODY_BYTES, routes=[
        (r"/api/assistant/chats/[0-9a-f]{32}/files", ASSISTANT_UPLOAD_BYTES + FORM_OVERHEAD),
        (r"/api/voice-agent/conversations/[0-9a-f]{12}/audio", MAX_AUDIO_BYTES + FORM_OVERHEAD),
        (r"/api/image-to-3d/generate", MAX_3D_IMAGE_BYTES + FORM_OVERHEAD),
        (r"/api/sites/uploads", SITE_UPLOAD_MAX_FILES * SITE_UPLOAD_MAX_PDF_BYTES + FORM_OVERHEAD),
        (r"/api/shop/uploads", SITE_UPLOAD_MAX_FILES * SITE_UPLOAD_MAX_IMAGE_BYTES + FORM_OVERHEAD),
        (r"/api/shop/(?!uploads$|import$).*", 2 * MB),  # every other shop route takes JSON, never a file
        (r"/control/v1/messages(/count_tokens)?", 32 * MB),  # a long conversation with pictures, not a video
    ])
    app.add_middleware(RequestContext)  # outermost: names each request's area and trace for the call log

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
    """Serve the site builder's sites at /sites/<id>/, and their kept versions at /site-versions/<id>/<n>/, for the
    preview and the screenshots. HTML pages get the error reporter, which only posts messages to the frame's parent."""

    def serve(request: Request, site_id: str, path: str, version: int | None):
        c: Container = request.app.state.container
        site = c.sites.store.get(site_id)
        if request.headers.get("host") not in c.settings.allowed_hosts | {f"127.0.0.1:{c.settings.port}"} or site is None:
            return error_response(404, "not_found", "Not found")
        if version is not None and not any(v["n"] == version for v in site.versions):
            return error_response(404, "not_found", "Not found")
        files = site.files if version is None else site.version_files(version)
        try:
            _, file = files.resolve(path or "index.html")
        except FileProblem:
            return error_response(404, "not_found", "Not found")
        if not file.is_file():
            return error_response(404, "not_found", "Not found")
        media = TEXT_TYPES[file.suffix.lower()]
        if media == "text/html":
            html = with_reporter(file.read_text(encoding="utf-8", errors="replace"))
            return Response(html, media_type="text/html; charset=utf-8", headers=SITE_HEADERS)
        return FileResponse(file, media_type=f"{media}; charset=utf-8", headers=SITE_HEADERS)

    @app.get("/sites/{site_id}/{path:path}", include_in_schema=False)
    def site_page(site_id: str, path: str, request: Request):
        return serve(request, site_id, path, None)

    @app.get("/site-versions/{site_id}/{version}/{path:path}", include_in_schema=False)
    def site_version_page(site_id: str, version: int, path: str, request: Request):
        return serve(request, site_id, path, version)


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
