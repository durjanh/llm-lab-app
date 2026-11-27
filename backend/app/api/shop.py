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

from typing import Any

from fastapi import APIRouter, Depends, File, Form, Header, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..core.errors import ApiError
from ..core.body_limit import FORM_OVERHEAD, MB, LimitedRoute, default_limit, limit
from ..services.shop import ShopService
from ..services.shop_import import MAX_FILE_BYTES
from ..services.site_uploads import MAX_FILES, MAX_IMAGE_BYTES
from .deps import require_budget, require_lab_page, shop

router = APIRouter(dependencies=[Depends(require_lab_page)], route_class=LimitedRoute)
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
def shop_info(service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.info()


@router.get("/shop/customers")
def shop_customers(limit: int = 50, service: ShopService = Depends(shop)) -> list[dict[str, Any]]:
    """The demo shoppers, for the sign-in switcher (a lab stand-in for real sign-in)."""
    return service.customers(limit)


@router.post("/shop/session")
def shop_session(body: SignIn, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.sign_in(body.customer_id, body.guest_events)


@router.post("/shop/accounts")
def shop_account(body: Account, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.create_account(body.display_name, body.email, body.guest_events)


# ----- the catalogue -----
@router.get("/shop/products")
def shop_products(query: str = Query(default="", max_length=200), category: str | None = None,
                  max_price_pence: int | None = None, min_rating: float | None = None, size: str | None = None,
                  colour: str | None = None, in_stock_only: bool = False, limit: int = 24,
                  service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.browse(query, {"category": category, "max_price_pence": max_price_pence, "min_rating": min_rating,
                                  "size": size, "colour": colour, "in_stock_only": in_stock_only}, limit)


@router.get("/shop/products/{product_id}")
def shop_product(product_id: str, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.product(product_id)


@router.post("/shop/products", dependencies=Lab)
def shop_add_product(body: dict[str, Any], service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.add_product(body)


@router.patch("/shop/products/{product_id}", dependencies=Lab)
def shop_edit_product(product_id: str, body: dict[str, Any], service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.edit_product(product_id, body)


@router.delete("/shop/products/{product_id}", dependencies=Lab)
def shop_delete_product(product_id: str, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.delete_product(product_id)


@router.get("/shop/embedding")
def shop_embedding(service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.embedding()


@router.post("/shop/embedding/retry", dependencies=Lab)
def shop_embedding_retry(body: Retry, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.retry_embedding(body.ids)


def signed_in(token: str | None = Token, service: ShopService = Depends(shop)) -> str:
    """The signed-in shopper's id from their session, or 401. Every route on a shopper's own rows takes it, so none
    can forget the check and serve a guest."""
    return service.customer_of(token)


Shopper = Depends(signed_in)


# ----- the shopper's own things -----
@router.get("/shop/basket")
def shop_basket(cid: str = Shopper, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.basket(cid)


@router.post("/shop/basket/items")
def shop_basket_add(body: AddItem, cid: str = Shopper, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.add_to_basket(cid, body.product_id, body.quantity, body.size)


@router.patch("/shop/basket/items/{item_id}")
def shop_basket_update(item_id: str, body: Quantity, cid: str = Shopper,
                       service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.update_basket_item(cid, item_id, body.quantity)


@router.delete("/shop/basket/items/{item_id}")
def shop_basket_remove(item_id: str, cid: str = Shopper, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.remove_from_basket(cid, item_id)


@router.post("/shop/checkout")
def shop_checkout(body: Checkout, cid: str = Shopper, service: ShopService = Depends(shop)) -> dict[str, Any]:
    """Prepares a checkout. Nothing is ordered until /shop/confirm."""
    return service.propose_checkout(cid, body.delivery)


@router.post("/shop/returns")
def shop_return(body: Return, cid: str = Shopper, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.propose_return(cid, body.order_item_id, body.reason)


@router.post("/shop/confirm")
def shop_confirm(body: Confirm, cid: str = Shopper, service: ShopService = Depends(shop)) -> dict[str, Any]:
    """The person pressed Confirm (or Cancel): the only way an order or a return is placed."""
    return service.confirm(cid, body.confirmation_id, body.accept)


@router.get("/shop/orders")
def shop_orders(limit: int = 20, cid: str = Shopper, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.orders(cid, limit)


@router.get("/shop/wishlist")
def shop_wishlist(cid: str = Shopper, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.wishlist(cid)


@router.post("/shop/wishlist")
def shop_wish(body: Wish, cid: str = Shopper, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.add_to_wishlist(cid, body.product_id)


# ----- browsing behaviour -----
@router.post("/shop/events")
def shop_events(body: Events, cid: str = Shopper, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.record_events(cid, body.events)


@router.get("/shop/profile")
def shop_profile(cid: str = Shopper, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.profile(cid)


@router.delete("/shop/activity")
def shop_forget(cid: str = Shopper, service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.forget_activity(cid)


@router.post("/shop/recommendations")
def shop_recommendations(body: Recommend, token: str | None = Token,
                         service: ShopService = Depends(shop)) -> dict[str, Any]:
    """From the stored profile when signed in (any summary sent is ignored); from the guest's checked summary
    otherwise, with nothing stored."""
    customer = service.customer_of(token, required=False)
    return service.recommendations(customer, None if customer else body.activity_summary, body.limit)


# ----- the chat -----
@router.post("/shop/uploads", openapi_extra=limit(MAX_FILES * MAX_IMAGE_BYTES + FORM_OVERHEAD))
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
def shop_chat(body: Chat, token: str | None = Token, service: ShopService = Depends(shop)) -> StreamingResponse:
    return StreamingResponse(service.chat(token, body.model_dump()), **NDJSON)


# ----- the data behind the shop -----
@router.get("/shop/import")
def shop_import_state(service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.importer.state()


@router.post("/shop/generate", dependencies=Lab)
def shop_generate(body: Generate, service: ShopService = Depends(shop)) -> dict[str, Any]:
    """Starts the seeded generator (409 while an import runs); generating the same size again after a stop resumes."""
    return service.generate(body.size, body.force)


@router.post("/shop/import", dependencies=Lab, openapi_extra=limit(MAX_FILE_BYTES + FORM_OVERHEAD))
async def shop_import(file: UploadFile = File(...), kind: str = Form(...),
                      service: ShopService = Depends(shop)) -> dict[str, Any]:
    raw = await file.read(MAX_FILE_BYTES + 1)
    return await run_in_threadpool(service.importer.import_file, kind, file.filename or "", raw)


@router.post("/shop/import/stop", dependencies=Lab)
def shop_import_stop(service: ShopService = Depends(shop)) -> dict[str, Any]:
    return service.importer.stop()


@router.post("/shop/isolation-check")
def shop_isolation(token: str | None = Token, service: ShopService = Depends(shop)) -> dict[str, Any]:
    """The fishing suite, live: each attempt to reach another shopper's data, and whether it was held."""
    return service.isolation_check(token)


default_limit(router, 2 * MB)  # every other shop route takes JSON, never a file
