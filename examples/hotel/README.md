# The Harbour Light: a hotel booking agent

A guest books, changes and cancels a room at an invented hotel in Whitby by chatting with an agent. It runs on Claude, a GPT deployment in Azure OpenAI or the local open model: the tool loop is written in Claude's message format, and the lab's client (`python/local_model.py`, `python/gpt_model.py`) translates for the other two. The `/hotel` page and the command line here share one implementation, `hotel.py`, and one database, `generated/hotel/hotel.db`.

The model chats and chooses tools. The rules live in the tools, so a persuasive message cannot change them:

| Rule | Where it is enforced |
|---|---|
| Prices come from the room rates, with £20 more on Friday and Saturday nights. No tool takes a price, discount or upgrade. | `Hotel.price`, the tool schemas |
| A room is never sold twice. `room_nights` has one row per room per night, and its primary key refuses a second. | `Hotel._claim` |
| Booking, changing and cancelling take two turns: a summary first, then the action only after the guest answers. | `Chat._confirmed_later` |
| A booking is held for 15 minutes until the deposit (the first night) is paid on a payment page. Card numbers typed into the chat are removed before the model sees them (a Luhn check). | `Hotel.hold`, `Hotel.pay`, `screen_guest_text` |
| A booking is seen or changed only after its reference and email address match. Three wrong tries lock the conversation. | `Chat._find_booking`, `Chat._own` |
| Free cancellation until 48 hours before check-in at 15:00; after that the deposit is kept. | `Hotel.refund_due` |
| The confirmation email and text are written by the code from reviewed wording, not by the model, when a booking is confirmed, changed or cancelled. | `Hotel.notify` |

## Run it

```sh
source .venv/bin/activate
python examples/hotel/hotel_agent.py            # /pay, /board, /desk SEA <in> <out>, /quit
python examples/hotel/hotel_agent.py --model gpt-5.4-mini   # or the local model's id
```

Or open `/hotel` in the lab: the guest chat on the left, the back office on the right (room calendar, bookings, the guest's phone and inbox, the audit log), a pretend payment page, a front desk for the double-booking demonstration, and messages that try to break the rules.

## Real texts and emails

Every confirmation is kept in the hotel's outbox. The backend also sends them for real when you say where to, because the guests are invented:

- `HOTEL_SMS_TO`: your phone. Texts go through the Communication Services resource in `MEDASSIST_SMS_ENDPOINT`, from `MEDASSIST_SMS_SENDER`.
- `HOTEL_EMAIL_TO` and `HOTEL_EMAIL_SENDER`: your inbox, and a sender address on an email domain connected to that resource. Needs `pip install azure-communication-email`. The lab's `infra/` does not create an email domain yet.

Both sign in with your Azure login. A send that fails is marked failed in the outbox, with the reason.

## Tests

`pytest backend/tests/test_hotel.py`: prices, the double-booking guard, two-turn confirmation, payment and hold expiry, another guest's booking, card screening, the refund policy, changes, bad dates, and a whole booking through the API with a scripted Claude.
