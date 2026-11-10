"""The hotel booking agent: guest conversations, the back office, the payment page and the front desk."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..schemas import HotelFrontDesk, HotelMessage, ModelChoice
from ..services.hotel import HotelService
from .deps import hotel, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


@router.get("/hotel/info")
def info(service: HotelService = Depends(hotel)) -> dict[str, Any]:
    return service.info()


@router.get("/hotel/board")
def board(service: HotelService = Depends(hotel)) -> dict[str, Any]:
    """The room calendar, bookings, the guest's outbox and the audit log."""
    return service.board()


@router.post("/hotel/chats")
def start(body: ModelChoice, service: HotelService = Depends(hotel)) -> dict[str, Any]:
    """A new guest conversation. Nothing is sent to the model until the guest writes."""
    return service.start(body.model)


@router.post("/hotel/chats/{chat_id}/messages", dependencies=[Depends(require_budget)])
def message(chat_id: str, body: HotelMessage, service: HotelService = Depends(hotel)) -> dict[str, Any]:
    return service.message(chat_id, body.message.strip())


@router.post("/hotel/chats/{chat_id}/update", dependencies=[Depends(require_budget)])
def update(chat_id: str, service: HotelService = Depends(hotel)) -> dict[str, Any]:
    """The agent's turn after the hotel's systems told it something, such as a deposit paid on the payment page."""
    return service.update(chat_id)


@router.post("/hotel/pay/{token}")
def pay(token: str, service: HotelService = Depends(hotel)) -> dict[str, Any]:
    """The pretend payment provider: the deposit is paid here, never in the chat."""
    return service.pay(token)


@router.post("/hotel/front-desk")
def front_desk(body: HotelFrontDesk, service: HotelService = Depends(hotel)) -> dict[str, Any]:
    """Another guest books at reception, for the double-booking demonstration."""
    return service.front_desk(body.type_code, body.check_in, body.check_out)


@router.post("/hotel/reset")
def reset(service: HotelService = Depends(hotel)) -> dict[str, Any]:
    return service.reset()
