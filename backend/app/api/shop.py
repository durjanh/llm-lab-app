"""The shopping assistant page: the shop's catalogue, a shopper's own basket, orders, wish list and browsing, the chat
streamed as NDJSON, the confirm step, the data behind the shop, and "Try to break it".

Every route needs the lab page (require_lab_page); the chat, which calls a model, also needs the budget. The shopper is
the X-Shop-Session token's, looked up on the server: routes about a shopper's own things answer 401 without one, and
the catalogue, the chat and suggestions also work for a guest.

The Lab's data routes (adding, editing and deleting products, generating a shop, importing a file, stopping an import,
retrying embeddings) change the shop for everyone, so they are kept out of shoppers' reach: they need the
`X-Shop-Lab: 1` header the Lab tab sends, and refuse any request that carries a shopper's X-Shop-Session (403). A
generate that would replace the shop while shoppers are signed in or a checkout is waiting for Confirm is refused (409,
`in_use`) unless the body says `force: true`, which the Lab tab sends only after asking the person.
"""
from __future__ import annotations

import functools
from typing import Any, Callable

from fastapi import APIRouter, Depends, File, Form, Header, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..core.errors import ApiError
from ..gateways.pgvector import VectorDbUnavailable
from ..services.shop import ShopService
from ..services.shop_import import MAX_FILE_BYTES
from ..services.site_uploads import MAX_FILES, MAX_IMAGE_BYTES
from .deps import require_budget, require_lab_page, shop

router = APIRouter(dependencies=[Depends(require_lab_page)])
NDJSON = {"media_type": "application/x-ndjson", "headers": {"Cache-Control": "no-store"}}
Token = Header(default=None, alias="X-Shop-Session", max_length=200)


def require_lab_tab(x_shop_lab: str | None = Header(default=None, alias="X-Shop-Lab", max_length=10),
                    token: str | None = Token) -> None:
    """The Lab tab only: its own header, and no shopper's session on the request."""
    if x_shop_lab != "1":
        raise ApiError(403, "lab_only", "This changes the shop's data: only the Lab tab can do it.")
    if token:
        raise ApiError(403, "lab_only", "A shopper's session cannot change the shop's data. The Lab tab sends its "
                                        "requests without one.")


Lab = [Depends(require_lab_tab)]


def db(fn: Callable[..., Any]) -> Callable[..., Any]:
    """The database being down is a 503 with what to start, not a server error."""
    @functools.wraps(fn)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        try:
            return fn(*args, **kwargs)
        except VectorDbUnavailable as exc:
            raise ApiError(503, "no_database", str(exc)) from exc
    return wrapped


class SignIn(BaseModel):
    customer_id: str = Field(max_length=40)
    guest_events: list[Any] | None = Field(default=None, max_length=500)


class Account(BaseModel):
    display_name: str = Field(max_length=60)
    email: str = Field(max_length=200)
    guest_events: list[Any] | None = Field(default=None, max_length=500)


class Events(BaseModel):
    events: list[Any] = Field(max_length=100)


class Recommend(BaseModel):
    limit: int = 8
    activity_summary: Any = None


class Generate(BaseModel):
    size: int
    force: bool = False


class Chat(BaseModel):
    session_id: str | None = Field(default=None, max_length=64)
    text: str = Field(max_length=4000)
    model: str = Field(default="", max_length=80)
    effort: str = Field(default="", max_length=10)
    auto: bool = False
    context: dict[str, Any] = Field(default_factory=dict)
    attachments: list[str] = Field(default_factory=list, max_length=4)


class Confirm(BaseModel):
    confirmation_id: str = Field(max_length=64)
    accept: bool


class AddItem(BaseModel):
    product_id: str = Field(max_length=64)
    quantity: int = 1
    size: str | None = Field(default=None, max_length=12)


class Quantity(BaseModel):
    quantity: int


class Checkout(BaseModel):
    delivery: str = Field(max_length=20)


class Return(BaseModel):
    order_item_id: str = Field(max_length=80)
    reason: str = Field(max_length=200)


class Wish(BaseModel):
    product_id: str = Field(max_length=64)


class Retry(BaseModel):
    ids: list[str] | None = Field(default=None, max_length=1000)


# ----- the shop and signing in -----
@router.get("/shop/info")
@db
def shop_info(service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.info()


@router.get("/shop/customers")
@db
def shop_customers(limit: int = 50, service: ShopService = Depends(shop)) -> list[dict[str, Any]]:
    """The demo shoppers, for the sign-in switcher (a lab stand-in for real sign-in)."""
    return service.customers(limit)


@router.post("/shop/session")
@db
def shop_session(body: SignIn, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.sign_in(body.customer_id, body.guest_events)


@router.post("/shop/accounts")
@db
def shop_account(body: Account, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.create_account(body.display_name, body.email, body.guest_events)


# ----- the catalogue -----
@router.get("/shop/products")
@db
def shop_products(query: str = Query(default="", max_length=200), category: str | None = None,
                  max_price_pence: int | None = None, min_rating: float | None = None, size: str | None = None,
                  colour: str | None = None, in_stock_only: bool = False, limit: int = 24,
                  service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.browse(query, {"category": category, "max_price_pence": max_price_pence, "min_rating": min_rating,
                                  "size": size, "colour": colour, "in_stock_only": in_stock_only}, limit)


@router.get("/shop/products/{product_id}")
@db
def shop_product(product_id: str, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.product(product_id)


@router.post("/shop/products", dependencies=Lab)
@db
def shop_add_product(body: dict[str, Any], service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.add_product(body)


@router.patch("/shop/products/{product_id}", dependencies=Lab)
@db
def shop_edit_product(product_id: str, body: dict[str, Any], service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.edit_product(product_id, body)


@router.delete("/shop/products/{product_id}", dependencies=Lab)
@db
def shop_delete_product(product_id: str, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.delete_product(product_id)


@router.get("/shop/embedding")
@db
def shop_embedding(service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.embedding()


@router.post("/shop/embedding/retry", dependencies=Lab)
@db
def shop_embedding_retry(body: Retry, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.retry_embedding(body.ids)


# ----- the shopper's own things -----
@router.get("/shop/basket")
@db
def shop_basket(token: str | None = Token, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.basket(service.customer_of(token))


@router.post("/shop/basket/items")
@db
def shop_basket_add(body: AddItem, token: str | None = Token, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.add_to_basket(service.customer_of(token), body.product_id, body.quantity, body.size)


@router.patch("/shop/basket/items/{item_id}")
@db
def shop_basket_update(item_id: str, body: Quantity, token: str | None = Token,
                       service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.update_basket_item(service.customer_of(token), item_id, body.quantity)


@router.delete("/shop/basket/items/{item_id}")
@db
def shop_basket_remove(item_id: str, token: str | None = Token, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.remove_from_basket(service.customer_of(token), item_id)


@router.post("/shop/checkout")
@db
def shop_checkout(body: Checkout, token: str | None = Token, service: ShopService = Depends(shop)) -> dict[str, Any]:
    """Prepares a checkout. Nothing is ordered until /shop/confirm."""
    return service.propose_checkout(service.customer_of(token), body.delivery)


@router.post("/shop/returns")
@db
def shop_return(body: Return, token: str | None = Token, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.propose_return(service.customer_of(token), body.order_item_id, body.reason)


@router.post("/shop/confirm")
@db
def shop_confirm(body: Confirm, token: str | None = Token, service: ShopService = Depends(shop)) -> dict[str, Any]:
    """The person pressed Confirm (or Cancel): the only way an order or a return is placed."""
    return service.confirm(service.customer_of(token), body.confirmation_id, body.accept)


@router.get("/shop/orders")
@db
def shop_orders(limit: int = 20, token: str | None = Token, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.orders(service.customer_of(token), limit)


@router.get("/shop/wishlist")
@db
def shop_wishlist(token: str | None = Token, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.wishlist(service.customer_of(token))


@router.post("/shop/wishlist")
@db
def shop_wish(body: Wish, token: str | None = Token, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.add_to_wishlist(service.customer_of(token), body.product_id)


# ----- browsing behaviour -----
@router.post("/shop/events")
@db
def shop_events(body: Events, token: str | None = Token, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.record_events(service.customer_of(token), body.events)


@router.get("/shop/profile")
@db
def shop_profile(token: str | None = Token, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.profile(service.customer_of(token))


@router.delete("/shop/activity")
@db
def shop_forget(token: str | None = Token, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.forget_activity(service.customer_of(token))


@router.post("/shop/recommendations")
@db
def shop_recommendations(body: Recommend, token: str | None = Token,
                         service: ShopService = Depends(shop)) -> dict[str, Any]:
    """From the stored profile when signed in (any summary sent is ignored); from the guest's checked summary
    otherwise, with nothing stored."""
    customer = service.customer_of(token, required=False)
    return service.recommendations(customer, None if customer else body.activity_summary, body.limit)


# ----- the chat -----
@router.post("/shop/uploads")
async def shop_uploads(files: list[UploadFile] = File(...), caller: str | None = Form(default=None),
                       token: str | None = Token, service: ShopService = Depends(shop)) -> list[dict[str, Any]]:
    """Pictures for the next message ("find me something like this"). Free: nothing reaches a model until a message
    attaches them."""
    customer = service.customer_of(token)
    if len(files) > MAX_FILES:
        raise ApiError(400, "invalid_request", f"Attach at most {MAX_FILES} pictures at once.")
    read = [(f.filename or "picture", await f.read(MAX_IMAGE_BYTES + 1)) for f in files]
    return await run_in_threadpool(service.upload, customer, read)


@router.post("/shop/chat", dependencies=[Depends(require_budget)])
@db
def shop_chat(body: Chat, token: str | None = Token, service: ShopService = Depends(shop)) -> StreamingResponse:
    return StreamingResponse(service.chat(token, body.model_dump()), **NDJSON)


# ----- the data behind the shop -----
@router.get("/shop/import")
@db
def shop_import_state(service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.importer.state()


@router.post("/shop/generate", dependencies=Lab)
@db
def shop_generate(body: Generate, service: ShopService = Depends(shop)) -> dict[str, Any]:
    """Starts the seeded generator (409 while an import runs); generating the same size again after a stop resumes."""
    return service.generate(body.size, body.force)


@router.post("/shop/import", dependencies=Lab)
async def shop_import(file: UploadFile = File(...), kind: str = Form(...),
                      service: ShopService = Depends(shop)) -> dict[str, Any]:
    raw = await file.read(MAX_FILE_BYTES + 1)
    try:
        return await run_in_threadpool(service.importer.import_file, kind, file.filename or "", raw)
    except VectorDbUnavailable as exc:
        raise ApiError(503, "no_database", str(exc)) from exc


@router.post("/shop/import/stop", dependencies=Lab)
@db
def shop_import_stop(service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.importer.stop()


@router.post("/shop/isolation-check")
@db
def shop_isolation(token: str | None = Token, service: ShopService = Depends(shop)) -> dict[str, Any]:
    """The fishing suite, live: each attempt to reach another shopper's data, and whether it was held."""
    return service.isolation_check(token)
