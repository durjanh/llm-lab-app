"""core/body_limit.py: the middleware holds every request to the app's ceiling, and a route that takes less declares it
where it is declared (`openapi_extra=limit(n)`, `default_limit(router, n)`) on a `LimitedRoute` router, which checks
it after the route is matched and before the body is read. No list of paths has to be kept in step."""
from __future__ import annotations

import importlib
import pkgutil

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import backend.app.api as api_package
from backend.app.core.body_limit import KEY, BodyLimit, LimitedRoute, default_limit, limit


def app_with_limits() -> FastAPI:
    app = FastAPI()
    api = APIRouter(prefix="/api")
    shop = APIRouter(route_class=LimitedRoute)

    @shop.post("/shop/uploads", openapi_extra=limit(1000))
    def uploads(body: dict) -> dict:
        return {"ok": True}

    @shop.post("/shop/items/{item_id}")
    def item(item_id: str, body: dict) -> dict:
        return {"ok": True}

    @shop.post("/shop/import", openapi_extra=limit(5000))
    def import_file(body: dict) -> dict:
        return {"ok": True}

    default_limit(shop, 100)  # every other route on the router: a route added later is covered too
    api.include_router(shop)
    app.include_router(api)

    @app.post("/elsewhere")
    def elsewhere(body: dict) -> dict:
        return {"ok": True}

    app.add_middleware(BodyLimit, default=10_000)
    return app


def post(client: TestClient, path: str, size: int, chunked: bool = False) -> int:
    body = b'{"x": "' + b"a" * size + b'"}'
    if chunked:  # no Content-Length: the limit must be found by counting the bytes as they arrive
        return client.post(path, content=iter([body[i:i + 64] for i in range(0, len(body), 64)]),
                           headers={"content-type": "application/json"}).status_code
    return client.post(path, content=body, headers={"content-type": "application/json"}).status_code


def test_each_route_gets_its_own_limit_and_everything_else_the_ceiling():
    client = TestClient(app_with_limits())
    assert post(client, "/api/shop/uploads", 900) == 200 and post(client, "/api/shop/uploads", 1200) == 413
    assert post(client, "/api/shop/items/abc", 50) == 200 and post(client, "/api/shop/items/abc", 200) == 413
    assert post(client, "/api/shop/import", 4000) == 200 and post(client, "/api/shop/import", 6000) == 413
    assert post(client, "/elsewhere", 9000) == 200 and post(client, "/elsewhere", 11_000) == 413  # the ceiling


def test_a_body_without_content_length_is_counted_as_it_arrives():
    client = TestClient(app_with_limits())
    assert post(client, "/api/shop/uploads", 900, chunked=True) == 200
    r = client.post("/api/shop/uploads", content=iter([b'{"x": "' + b"a" * 600, b"a" * 600 + b'"}']),
                    headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json()["error"]["type"] == "too_large"
    assert post(client, "/elsewhere", 11_000, chunked=True) == 413


def test_every_declared_limit_is_on_a_router_that_enforces_it():
    """A limit on a plain APIRoute would do nothing: every route that declares one must be a LimitedRoute."""
    unenforced = []
    for info in pkgutil.iter_modules(api_package.__path__):
        module = importlib.import_module(f"{api_package.__name__}.{info.name}")
        for router in (v for v in vars(module).values() if isinstance(v, APIRouter)):
            for route in router.routes:
                if KEY in (getattr(route, "openapi_extra", None) or {}) and not isinstance(route, LimitedRoute):
                    unenforced.append(f"{info.name}: {route.path}")
    assert unenforced == []


def test_the_lab_declares_its_upload_and_json_limits(tmp_path):
    from backend.app.api import assistant, control_layer, image_to_3d, shop, sites, voice_agent

    def declared(router: APIRouter, path: str, method: str = "POST") -> int | None:
        route = next(r for r in router.routes if r.path == path and method in r.methods)
        return (route.openapi_extra or {}).get(KEY)

    for router, path in ((assistant.router, "/assistant/chats/{chat_id}/files"),
                         (voice_agent.router, "/voice-agent/conversations/{cid}/audio"),
                         (image_to_3d.router, "/image-to-3d/generate"), (sites.router, "/sites/uploads"),
                         (shop.router, "/shop/uploads"), (shop.router, "/shop/import"),
                         (control_layer.proxy, "/control/v1/messages")):
        assert declared(router, path), path
    assert declared(shop.router, "/shop/basket/items") == 2 * 2**20  # the shop router's default for JSON routes
