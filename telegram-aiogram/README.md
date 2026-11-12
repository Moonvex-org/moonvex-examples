# Accept crypto payments in an aiogram Telegram bot

An aiogram 3 bot issues a Moonvex invoice on /buy and sends a pay button, while an aiohttp server in the same process receives the webhook, verifies the signature and tells the customer the payment arrived. Bots with a balance get a permanent top-up address.

Full guide with explanations: https://moonvex.org/en/guides/telegram-aiogram?utm_source=github&utm_medium=repo&utm_campaign=telegram-aiogram

## 1. Get an API key and a webhook secret

In the Moonvex dashboard go to “Integration” → “Create key” → type “Secret” (sk_live_…). The key is shown only once: store it on your server as MOONVEX_SECRET_KEY. On the same page add a webhook pointing to an https URL on your server and store its signing secret as MOONVEX_WEBHOOK_SECRET. The bot also needs a BOT_TOKEN from @BotFather.

File: [`01-get-an-api-key-and-a-webhook-secret.sh`](./01-get-an-api-key-and-a-webhook-secret.sh)

```bash
pip install aiogram httpx asyncpg

export BOT_TOKEN=123456:ABC...
export MOONVEX_SECRET_KEY=sk_live_...
export MOONVEX_WEBHOOK_SECRET=whsec_...
export DATABASE_URL=postgresql://user:pass@localhost:5432/bot
```

## 2. Issue an invoice on /buy

The handler creates the payment with httpx.AsyncClient: orderId from the chat and message, customerId as the Telegram user id, and chatId in metadata. Metadata comes back in the webhook, so the bot knows whom to message.

File: [`02-issue-an-invoice-on-buy.py`](./02-issue-an-invoice-on-buy.py)

```python
# bot.py
import os

import httpx
from aiogram import Bot, Dispatcher
from aiogram.filters import Command
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message

bot = Bot(os.environ["BOT_TOKEN"])
dp = Dispatcher()
moonvex = httpx.AsyncClient(
    base_url="https://api.moonvex.org",
    headers={"Authorization": "Bearer " + os.environ["MOONVEX_SECRET_KEY"]},
    timeout=15,
)


@dp.message(Command("buy"))
async def buy(message: Message) -> None:
    # a unique order id: chat + message
    order_id = f"tg-{message.chat.id}-{message.message_id}"
    r = await moonvex.post(
        "/v1/payments",
        headers={"Idempotency-Key": order_id + "-1"},
        json={
            "orderId": order_id,
            "amount": "10",
            "currency": "USDT",
            "network": "TRON",
            "customerId": str(message.from_user.id),
            "metadata": {"chatId": message.chat.id},  # comes back in the webhook
        },
    )
    payment = r.json()
    if r.status_code >= 400:
        await message.answer("Could not create the invoice, try again later")
        return
    kb = InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text="Pay", url=payment["paymentUrl"])]])
    await message.answer(f"Amount due: {payment['amount']} {payment['asset']} ({payment['network']})", reply_markup=kb)
```

## 3. Send the pay button

paymentUrl is a hosted payment page with the amount, address and QR code; open it with an inline button carrying a url. It opens in the browser and cannot be embedded in a frame. Show the customer amount from the response: that is the total including the fee.

## 4. Receive the webhook and verify the signature

Moonvex sends a POST with a Moonvex-Signature header: t=<unix time>,v1=<signature>. The signature is a hex HMAC-SHA256 of the string “t.raw_body” keyed with the webhook secret. Compute it over the body bytes before parsing JSON, compare in constant time and reject events older than 5 minutes. For 24 hours after a secret rotation the header carries two v1 values; either one is valid. aiohttp reads the raw body with await request.read(). The webhook server listens on its own port while the bot uses polling; from the outside you need https, for example nginx in front of port 8080.

File: [`04-receive-the-webhook-and-verify-the.py`](./04-receive-the-webhook-and-verify-the.py)

```python
# bot.py (continued)
import asyncio
import hashlib
import hmac
import json
import time

import asyncpg
from aiohttp import web


def verify_moonvex(raw: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    parts = [p.split("=", 1) for p in (header or "").split(",") if "=" in p]
    t = next((v for k, v in parts if k == "t"), None)
    if t is None or not t.isdigit() or abs(time.time() - int(t)) > tolerance:
        return False
    expected = hmac.new(secret.encode(), t.encode() + b"." + raw, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, v) for k, v in parts if k == "v1")


async def moonvex_webhook(request: web.Request) -> web.Response:
    raw = await request.read()  # raw bytes
    if not verify_moonvex(raw, request.headers.get("Moonvex-Signature", ""), os.environ["MOONVEX_WEBHOOK_SECRET"]):
        return web.Response(status=400, text="bad signature")
    event = json.loads(raw)
    if event["type"] in ("payment.confirmed", "payment.overpaid") and await claim_event(request.app["db"], event["id"]):
        chat_id = event["data"]["metadata"]["chatId"]
        await bot.send_message(chat_id, "Payment received, thank you! Order " + event["data"]["orderId"])
    return web.Response(text="ok")


async def main() -> None:
    app = web.Application()
    app["db"] = await asyncpg.create_pool(os.environ["DATABASE_URL"])
    app.router.add_post("/moonvex/webhook", moonvex_webhook)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", 8080).start()  # behind nginx with https
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
```

## 5. Mark the order paid exactly once

A redelivered event keeps the same id, so store it in a table with a unique key in the same transaction as the order update: a duplicate then changes nothing. Fulfil on payment.confirmed and payment.overpaid, never on payment.detected. claim_event inserts the event id with ON CONFLICT DO NOTHING and returns True only for the first delivery, so the message is never sent twice.

File: [`05-mark-the-order-paid-exactly-once.py`](./05-mark-the-order-paid-exactly-once.py)

```python
# bot.py (continued)
# CREATE TABLE processed_events (event_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());


async def claim_event(db: asyncpg.Pool, event_id: str) -> bool:
    """True only for the first delivery of the event"""
    fresh = await db.fetchval(
        "INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id",
        event_id,
    )
    return fresh is not None
```

## 6. Top up a balance through a permanent address

If your bot has an internal balance, give each user a permanent deposit address: POST /v1/deposit-addresses with customerId and network. Calling it again returns the same address. Every incoming transfer arrives as a deposit.confirmed event with customerId and receivedAmount; credit it once per event id. The key needs the wallets:write scope.

File: [`06-top-up-a-balance-through-a-permanent.py`](./06-top-up-a-balance-through-a-permanent.py)

```python
# bot.py (continued) — the key needs the wallets:write scope
@dp.message(Command("topup"))
async def topup(message: Message) -> None:
    r = await moonvex.post(
        "/v1/deposit-addresses",
        json={"customerId": str(message.from_user.id), "network": "TRON"},
    )
    if r.status_code >= 400:
        await message.answer("Could not get the address, try again later")
        return
    # the same address on every call: the customer can top it up any time
    await message.answer("Your top-up address (USDT or TRX, TRON network):\n" + r.json()["address"])


# in moonvex_webhook: credit the customer balance once per event id
if event["type"] == "deposit.confirmed" and await claim_event(request.app["db"], event["id"]):
    d = event["data"]
    await credit_balance(d["customerId"], d["asset"], d["receivedAmount"])  # your function
    await bot.send_message(int(d["customerId"]), "Balance topped up: " + d["receivedAmount"] + " " + d["asset"])
```

## Pitfalls

- Never mark a payment from a button press or a return to the bot; only from the payment.confirmed / payment.overpaid webhook.
- Keep chat_id in metadata: metadata values are strings, numbers, true/false or null.
- If sending the message fails after claim_event, the event is already marked. For critical actions enqueue them in the same transaction.
- There is no test network: test the bot with a 1 USDT payment on TRON and the “Send test” button in the dashboard.

## FAQ

**Do I need a webhook if the bot uses polling?**

Yes. Polling fetches updates from Telegram, while Moonvex reports payments through its own webhook to your https URL. In the example both run in one process.

**Is this Telegram Payments or Stars?**

No. The customer pays in crypto on the Moonvex payment page and the money lands on your Moonvex project balance. No Telegram payment provider is involved.

**What if the customer does not pay in time?**

The payment moves to EXPIRED and you receive payment.expired. You can create a new payment for the same orderId with a new Idempotency-Key (for example, bump the attempt number at the end of the key). The payment window is set with expiresInMinutes: 5 to 1440 minutes, 30 by default.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=telegram-aiogram
