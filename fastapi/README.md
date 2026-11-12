# Accept crypto payments in FastAPI

Fully asynchronous crypto payments in FastAPI: a shared httpx.AsyncClient for the Moonvex API, a redirect to the checkout where the customer picks the coin, and a webhook that verifies the signature over the raw body and marks the order in PostgreSQL through asyncpg.

Full guide with explanations: https://moonvex.org/en/guides/fastapi?utm_source=github&utm_medium=repo&utm_campaign=fastapi

## 1. Get an API key and a webhook secret

In the Moonvex dashboard go to “Integration” → “Create key” → type “Secret” (sk_live_…). The key is shown only once: store it on your server as MOONVEX_SECRET_KEY. On the same page add a webhook pointing to an https URL on your server and store its signing secret as MOONVEX_WEBHOOK_SECRET.

File: [`01-get-an-api-key-and-a-webhook-secret.sh`](./01-get-an-api-key-and-a-webhook-secret.sh)

```bash
pip install fastapi uvicorn httpx asyncpg

export MOONVEX_SECRET_KEY=sk_live_...
export MOONVEX_WEBHOOK_SECRET=whsec_...
export DATABASE_URL=postgresql://user:pass@localhost:5432/shop
```

## 2. Create a checkout

The httpx client is created once in lifespan with the base URL and the Authorization header. The request has no network, so Moonvex creates a checkout where the customer picks the coin and network. Each checkout gets its own Idempotency-Key, the amount is str(Decimal) from a numeric column, description is shown as “You are paying for” and returnUrl (https only) is where the Back buttons lead.

File: [`02-create-a-checkout.py`](./02-create-a-checkout.py)

```python
# main.py
import os
from contextlib import asynccontextmanager

import asyncpg
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.db = await asyncpg.create_pool(os.environ["DATABASE_URL"])
    app.state.moonvex = httpx.AsyncClient(
        base_url="https://api.moonvex.org",
        headers={"Authorization": "Bearer " + os.environ["MOONVEX_SECRET_KEY"]},
        timeout=15,
    )
    yield
    await app.state.moonvex.aclose()
    await app.state.db.close()


app = FastAPI(lifespan=lifespan)


@app.post("/orders/{order_id}/pay")
async def pay(order_id: int, request: Request):
    order = await request.app.state.db.fetchrow("SELECT id, total FROM orders WHERE id = $1", order_id)
    if order is None:
        raise HTTPException(404)
    r = await request.app.state.moonvex.post(
        "/v1/payments",
        headers={"Idempotency-Key": f"order-{order_id}-1"},
        json={
            "orderId": str(order_id),
            "amount": str(order["total"]),  # numeric arrives as Decimal → str(): "25.00"
            "currency": "USD",  # no network: the customer picks the coin on the checkout page
            "description": f"Order #{order_id}",  # shown as “You are paying for”
            "returnUrl": f"https://shop.example.com/orders/{order_id}",  # the Back buttons
        },
    )
    checkout = r.json()
    if r.status_code >= 400:
        raise HTTPException(502, checkout["error"]["code"])
    return RedirectResponse(checkout["paymentUrl"], status_code=303)
```

## 3. Send the customer to paymentUrl

paymentUrl is the Moonvex checkout page: the customer picks the coin and network, then sees the exact amount including the fee, the address, a QR code, the official token contract and a timer, with a status that updates by itself. Your description is shown as “You are paying for”, and the Back and “Back to the shop” buttons lead to returnUrl. If you know the customer's language, add ?lang=ru, ?lang=uk or ?lang=en to paymentUrl; otherwise the page picks the language itself. Open the page with a redirect or in a new tab; it cannot be embedded in an iframe. A customer returning to your site is not proof of payment: mark the order paid only from a webhook. RedirectResponse(..., status_code=303) after a POST opens the payment page.

## 4. Receive the webhook and verify the signature

Moonvex sends a POST with a Moonvex-Signature header: t=<unix time>,v1=<signature>. The signature is a hex HMAC-SHA256 of the string “t.raw_body” keyed with the webhook secret. Compute it over the body bytes before parsing JSON, compare in constant time and reject events older than 5 minutes. For 24 hours after a secret rotation the header carries two v1 values; either one is valid. In FastAPI do not declare a Pydantic model for the webhook body: take the Request and await request.body(), which gives you the original bytes.

File: [`04-receive-the-webhook-and-verify-the.py`](./04-receive-the-webhook-and-verify-the.py)

```python
# main.py (continued)
import hashlib
import hmac
import json
import time


def verify_moonvex(raw: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    parts = [p.split("=", 1) for p in (header or "").split(",") if "=" in p]
    t = next((v for k, v in parts if k == "t"), None)
    if t is None or not t.isdigit() or abs(time.time() - int(t)) > tolerance:
        return False
    expected = hmac.new(secret.encode(), t.encode() + b"." + raw, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, v) for k, v in parts if k == "v1")


@app.post("/moonvex/webhook")
async def moonvex_webhook(request: Request):
    # Request.body(), not a Pydantic model: you need the original bytes
    raw = await request.body()
    if not verify_moonvex(raw, request.headers.get("moonvex-signature", ""), os.environ["MOONVEX_WEBHOOK_SECRET"]):
        raise HTTPException(400, "bad signature")
    event = json.loads(raw)
    if event["type"] in ("payment.confirmed", "payment.overpaid"):
        await mark_paid_once(request.app.state.db, event["id"], event["data"]["orderId"])
    # payment.cancelled also arrives when the customer switches coins: do not cancel the order on it
    return {"received": True}
```

## 5. Mark the order paid exactly once

A redelivered event keeps the same id, so store it in a table with a unique key in the same transaction as the order update: a duplicate then changes nothing. Fulfil on payment.confirmed and payment.overpaid, never on payment.detected. Events arrive for the payment the customer starts: data.id is its pay_… id and data.orderId is your order number. If the customer switches coins, the previous payment gets payment.cancelled: do not cancel the order on it while the checkout is open. With asyncpg: INSERT … ON CONFLICT DO NOTHING RETURNING inside conn.transaction(); None means a redelivery.

File: [`05-mark-the-order-paid-exactly-once.py`](./05-mark-the-order-paid-exactly-once.py)

```python
# main.py (continued)
# CREATE TABLE processed_events (event_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());


async def mark_paid_once(db: asyncpg.Pool, event_id: str, order_id: str) -> None:
    async with db.acquire() as conn, conn.transaction():
        fresh = await conn.fetchval(
            "INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id",
            event_id,
        )
        if fresh is None:
            return  # event already processed
        await conn.execute("UPDATE orders SET status = 'paid' WHERE id = $1 AND status <> 'paid'", int(order_id))
```

## 6. Test the integration

Moonvex has no test network: everything runs on mainnets. The “Send test” button under “Integration” sends a webhook.test event, which is how you check the signature. Then pay a small invoice, for example 1 USDT on TRON: it is a regular payment and the money lands on your balance. The delivery log with response codes and a “Retry” button is on the same page.

## Pitfalls

- A Pydantic model in the endpoint signature parses and validates the body before you see it, so you cannot verify the signature against it. You need the raw Request.
- Create httpx.AsyncClient once (in lifespan) rather than per request, so connections are reused.
- Do not call synchronous requests inside async endpoints: it blocks the event loop.
- For long jobs after a webhook use BackgroundTasks or a queue; the response must go out within 10 seconds.
- Need one fixed coin instead of the customer's choice? Add network (and asset when currency is USD) to the same request, for example "network": "TRON", "asset": "USDT": that is the classic payment in one coin. The checkout above is the recommended flow.

## FAQ

**Should I model the events with Pydantic?**

You can, after verifying the signature: run verify_moonvex on the raw bytes first, then Event.model_validate_json(raw). An event has id, type, apiVersion, createdAt and data holding the payment object (data.id is pay_…, data.orderId is your order number).

**What if the customer does not pay in time?**

The checkout is valid until expiresAt; the window is set with expiresInMinutes, 5 to 1440 minutes, 30 by default. If the customer started a payment and did not pay it in time, it moves to EXPIRED and you receive payment.expired. To let them try again, create a new checkout with a new Idempotency-Key (for example, bump the attempt number at the end of the key); if the API answers DUPLICATE_ORDER, that order number is closed, so use a new orderId such as 1001-2.

**Is there a test mode or a sandbox?**

No, there is no test network: Moonvex runs on mainnets only. Check the signature with the “Send test” button (a webhook.test event) and the whole payment flow with a real payment of a small amount, for example 1 USDT on TRON.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=fastapi
