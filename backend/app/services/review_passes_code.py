"""The invented change set the review-passes lab asks a model to review: a refunds feature for a small shop.

It is five new Python files. They are shown to the reviewer with line numbers. The answer key (what is really wrong,
and what only looks wrong) lives in `review_passes.py`, which finds each place by a snippet of text rather than by line
number, so editing these files cannot leave the key pointing at the wrong line.
"""
from __future__ import annotations

MODELS = r'''"""The shapes the refunds code passes around."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Optional

REFUND_WINDOW_DAYS = 30


@dataclass(frozen=True)
class Order:
    id: str
    customer_ref: str
    paid_pence: int
    placed_on: date


@dataclass
class RefundRequest:
    order_id: str
    amount_pence: int
    reason: str
    requested_on: date
    status: str = "pending"  # pending, then sent
'''

POLICY = r'''"""Who may be refunded, and how much."""
from __future__ import annotations

from datetime import date

from .models import REFUND_WINDOW_DAYS, Order

# Refunds above this need a second person to approve them.
APPROVAL_LIMIT_POUNDS = 100.0

FULL_REFUND_REASONS = {"faulty", "not_delivered"}


def within_window(order: Order, today: date) -> bool:
    """True up to and including the 30th day after the order was placed."""
    return (today - order.placed_on).days < REFUND_WINDOW_DAYS


def refund_amount(order: Order, reason: str) -> float:
    """The refund in pounds, to two places. Faulty or undelivered goods get everything back; a change of mind
    gets the money back less a 10% restocking fee."""
    paid = order.paid_pence / 100
    assert paid > 0, "orders are only stored once they are paid"
    if reason in FULL_REFUND_REASONS:
        return round(paid, 2)
    return round(paid * 0.9, 2)


def needs_approval(amount_pounds: float) -> bool:
    return amount_pounds > APPROVAL_LIMIT_POUNDS
'''

STORE = r'''"""Refund requests, kept in SQLite."""
from __future__ import annotations

import sqlite3
from typing import Iterable

from .models import RefundRequest

_SCHEMA = """CREATE TABLE IF NOT EXISTS refunds (
    order_id TEXT NOT NULL, amount_pence INTEGER NOT NULL, reason TEXT NOT NULL,
    requested_on TEXT NOT NULL, status TEXT NOT NULL)"""


class RefundStore:
    def __init__(self, path: str = "refunds.db") -> None:
        self.db = sqlite3.connect(path)
        self.db.execute(_SCHEMA)

    def add(self, request: RefundRequest) -> None:
        self.db.execute("INSERT INTO refunds VALUES (?, ?, ?, ?, ?)",
                        (request.order_id, request.amount_pence, request.reason, request.requested_on.isoformat(), request.status))
        self.db.commit()

    def find_by_customer(self, customer_ref: str) -> list[tuple]:
        """Every refund request on a customer's orders. The reference comes from the support form."""
        sql = f"SELECT r.* FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.customer_ref = '{customer_ref}'"
        return self.db.execute(sql).fetchall()

    def refunded_pence(self, order_id: str) -> int:
        """What has already been sent back on an order."""
        row = self.db.execute("SELECT COALESCE(SUM(amount_pence), 0) FROM refunds WHERE order_id = ? AND status = 'sent'",
                              (order_id,)).fetchone()
        return int(row[0])

    def delete_pending(self, order_id: str) -> None:
        """Remove an order's pending request, so the nightly job does not pick it up as well."""
        self.db.execute("DELETE FROM refunds WHERE order_id = ? AND status = 'pending'", (order_id,))
        self.db.commit()

    def pending(self) -> Iterable[tuple]:
        # TODO: page this once there are more than a few thousand
        return self.db.execute("SELECT * FROM refunds WHERE status = 'pending'").fetchall()
'''

GATEWAY = r'''"""The payment provider's refund call, with retries."""
from __future__ import annotations

import logging
import time
from typing import Any

log = logging.getLogger(__name__)


class GatewayError(Exception):
    """The provider could not be reached, or refused the refund."""


class PaymentGateway:
    def __init__(self, client: Any, retries: int = 3) -> None:
        self.client, self.retries = client, retries

    def send_refund(self, order_id: str, amount_pence: int) -> str:
        """Ask the provider to refund `amount_pence` on an order. Returns the provider's refund id."""
        last: Exception | None = None
        for attempt in range(self.retries):
            try:
                reply = self.client.post("/refunds", {"order": order_id, "amount": amount_pence})
                return reply["id"]
            except TimeoutError as exc:  # the provider may have processed the refund before it timed out
                last = exc
                log.warning("refund for %s timed out (attempt %d)", order_id, attempt + 1)
                time.sleep(2 ** attempt)
        raise GatewayError(f"refund for {order_id} timed out {self.retries} times") from last
'''

SERVICE = r'''"""Issuing a refund: check it is allowed, record it, send it."""
from __future__ import annotations

import logging
from dataclasses import replace
from datetime import date

from .gateway import GatewayError, PaymentGateway
from .models import Order, RefundRequest
from .policy import needs_approval, refund_amount, within_window
from .store import RefundStore

log = logging.getLogger(__name__)

_ORDERS: dict[str, Order] = {}  # filled by the order feed at start-up; only read here


class RefundError(Exception):
    """A refund that cannot go ahead, with a reason the support agent can read out."""


class RefundService:
    def __init__(self, store: RefundStore, gateway: PaymentGateway, today=date.today) -> None:
        self.store, self.gateway, self.today = store, gateway, today

    def issue_refund(self, order_id: str, reason: str) -> dict:
        order = _ORDERS.get(order_id)
        if order is None:
            raise LookupError(order_id)
        today = self.today()
        if not within_window(order, today):
            raise RefundError("The 30 day refund window has passed.")
        ordr_total_gbp = order.paid_pence / 100  # shown to the agent in the reply
        amount = refund_amount(order, reason)
        request = RefundRequest(order.id, amount, reason, today)
        already = self.store.refunded_pence(order.id)
        if request.amount_pence > order.paid_pence:
            raise RefundError("That is more than the customer paid.")
        self.store.add(request)
        if needs_approval(amount):
            return {"status": "awaiting_approval", "amount_gbp": amount, "order_total_gbp": ordr_total_gbp}
        self.store.delete_pending(order.id)  # the nightly job sends pending requests, so clear this one first
        try:
            refund_id = self.gateway.send_refund(order.id, request.amount_pence)
        except GatewayError as exc:
            log.warning("refund on %s failed: %s", order.id, exc)
            raise RefundError("The payment provider did not respond. Try again in a few minutes.") from exc
        self.store.add(replace(request, status="sent"))
        return {"status": "sent", "refund_id": refund_id, "amount_gbp": amount, "order_total_gbp": ordr_total_gbp}


def handle_refund(service: RefundService, form: dict) -> dict:
    """The support form's handler: always answers with a status and a message, never a stack trace."""
    try:
        return {"ok": True, **service.issue_refund(form["order_id"].strip(), form.get("reason", "change_of_mind"))}
    except LookupError:
        return {"ok": False, "message": "No such order."}
    except RefundError as exc:
        return {"ok": False, "message": str(exc)}
    except Exception:  # last line of defence at the edge: log it, show the agent something calm
        log.exception("refund handler failed")
        return {"ok": False, "message": "Something went wrong. It has been logged."}
'''

FILES: dict[str, str] = {
    "refunds/models.py": MODELS,
    "refunds/policy.py": POLICY,
    "refunds/store.py": STORE,
    "refunds/gateway.py": GATEWAY,
    "refunds/service.py": SERVICE,
}

# The store's fix for the SQL problem, used by the CI re-run: the same file with the query parameterised.
FIXED_STORE = STORE.replace(
    """        sql = f"SELECT r.* FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.customer_ref = '{customer_ref}'"
        return self.db.execute(sql).fetchall()""",
    """        sql = "SELECT r.* FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.customer_ref = ?"
        return self.db.execute(sql, (customer_ref,)).fetchall()""")
assert FIXED_STORE != STORE


def numbered(files: dict[str, str]) -> str:
    """The files as the reviewer sees them: a header per file, and every line numbered."""
    out = []
    for name, body in files.items():
        out.append(f"=== {name} (new file) ===")
        out += [f"{i:>3} | {line}" for i, line in enumerate(body.splitlines(), 1)]
        out.append("")
    return "\n".join(out)
