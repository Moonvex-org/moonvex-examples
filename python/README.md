# Accept crypto payments in Python

A minimal Moonvex integration in Python with Flask and requests: create a checkout, send the customer to the Moonvex page where they pick the coin and network, receive the webhook and verify its HMAC-SHA256 signature with the standard library. Works for any WSGI app.

Full guide with explanations: https://moonvex.org/en/guides/python?utm_source=github&utm_medium=repo&utm_campaign=python

## 1. Get an API key and a webhook secret

In the Moonvex dashboard go to “Integration” → “Create key” → type “Secret” (sk_live_…). The key is shown only once: store it on your server as MOONVEX_SECRET_KEY. On the same page add a webhook pointing to an https URL on your server and store its signing secret as MOONVEX_WEBHOOK_SECRET.

File: [`01-get-an-api-key-and-a-webhook-secret.sh`](./01-get-an-api-key-and-a-webhook-secret.sh)

```bash
pip install flask requests

# environment variables on the server
export MOONVEX_SECRET_KEY=sk_live_...
export MOONVEX_WEBHOOK_SECRET=whsec_...
```

## 2. Create a checkout

POST /v1/payments with requests: Authorization: Bearer and Idempotency-Key in the headers; orderId, amount as a string and currency (USD or a coin) in the body. Without network the API creates a checkout and the customer picks the coin and network on the Moonvex page. description is shown as “You are paying for”, returnUrl (https only) is where the Back buttons lead. A 201 response returns an object with object: "checkout", id (inv_…) and paymentUrl.

File: [`02-create-a-checkout.py`](./02-create-a-checkout.py)

```python
# app.py
import os
import sqlite3
from contextlib import closing

import requests
from flask import Flask, abort, redirect

app = Flask(__name__)
API = "https://api.moonvex.org"


def db() -> sqlite3.Connection:
    conn = sqlite3.connect("shop.db")
    conn.row_factory = sqlite3.Row
    return conn


def create_checkout(order_id: int, amount: str, attempt: int = 1) -> dict:
    r = requests.post(
        API + "/v1/payments",
        headers={
            "Authorization": "Bearer " + os.environ["MOONVEX_SECRET_KEY"],
            # a retry with the same key never creates a second checkout
            "Idempotency-Key": f"order-{order_id}-{attempt}",
        },
        json={
            "orderId": str(order_id),
            "amount": amount,
            "currency": "USD",  # no network: the customer picks the coin on the checkout page
            "description": f"Order #{order_id}",  # shown as “You are paying for”
            "returnUrl": f"https://shop.example.com/orders/{order_id}",  # the Back buttons
        },
        timeout=15,
    )
    checkout = r.json()
    if r.status_code >= 400:
        raise RuntimeError(checkout["error"]["code"] + ": " + checkout["error"]["message"])
    return checkout  # {"object": "checkout", "id": "inv_…", "paymentUrl": …}


@app.post("/orders/<int:order_id>/pay")
def pay(order_id: int):
    with closing(db()) as conn:
        order = conn.execute("SELECT id, total FROM orders WHERE id = ?", (order_id,)).fetchone()
    if order is None:
        abort(404)
    # total is stored as TEXT "25.00", so the amount is sent as a string
    checkout = create_checkout(order["id"], str(order["total"]))
    return redirect(checkout["paymentUrl"], code=303)
```

## 3. Send the customer to paymentUrl

paymentUrl is the Moonvex checkout page: the customer picks the coin and network, then sees the exact amount including the fee, the address, a QR code, the official token contract and a timer, with a status that updates by itself. Your description is shown as “You are paying for”, and the Back and “Back to the shop” buttons lead to returnUrl. If you know the customer's language, add ?lang=ru, ?lang=uk or ?lang=en to paymentUrl; otherwise the page picks the language itself. Open the page with a redirect or in a new tab; it cannot be embedded in an iframe. A customer returning to your site is not proof of payment: mark the order paid only from a webhook. In Flask: redirect(payment["paymentUrl"], code=303).

## 4. Receive the webhook and verify the signature

Moonvex sends a POST with a Moonvex-Signature header: t=<unix time>,v1=<signature>. The signature is a hex HMAC-SHA256 of the string “t.raw_body” keyed with the webhook secret. Compute it over the body bytes before parsing JSON, compare in constant time and reject events older than 5 minutes. For 24 hours after a secret rotation the header carries two v1 values; either one is valid. In Flask the raw body is request.get_data(), and hmac.compare_digest compares signatures in constant time.

File: [`04-receive-the-webhook-and-verify-the.py`](./04-receive-the-webhook-and-verify-the.py)

```python
# moonvex_signature.py
import hashlib
import hmac
import time


def verify_moonvex(raw: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    """Checks Moonvex-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + raw)>"""
    parts = [p.split("=", 1) for p in (header or "").split(",") if "=" in p]
    t = next((v for k, v in parts if k == "t"), None)
    if t is None or not t.isdigit() or abs(time.time() - int(t)) > tolerance:
        return False
    expected = hmac.new(secret.encode(), t.encode() + b"." + raw, hashlib.sha256).hexdigest()
    # compare_digest is constant-time; during a secret rotation there are two v1 values
    return any(hmac.compare_digest(expected, v) for k, v in parts if k == "v1")

# app.py (continued)
import json

from flask import request

from moonvex_signature import verify_moonvex


@app.post("/moonvex/webhook")
def moonvex_webhook():
    raw = request.get_data()  # raw bytes, before JSON parsing
    if not verify_moonvex(raw, request.headers.get("Moonvex-Signature", ""), os.environ["MOONVEX_WEBHOOK_SECRET"]):
        return "bad signature", 400
    event = json.loads(raw)
    if event["type"] in ("payment.confirmed", "payment.overpaid"):
        mark_paid_once(event["id"], event["data"]["orderId"])
    # payment.cancelled also arrives when the customer switches coins: do not cancel the order on it
    return "", 200
```

## 5. Mark the order paid exactly once

A redelivered event keeps the same id, so store it in a table with a unique key in the same transaction as the order update: a duplicate then changes nothing. Fulfil on payment.confirmed and payment.overpaid, never on payment.detected. Events arrive for the payment the customer starts: data.id is its pay_… id and data.orderId is your order number. If the customer switches coins, the previous payment gets payment.cancelled: do not cancel the order on it while the checkout is open. In SQLite that is INSERT OR IGNORE plus a cursor.rowcount check in one transaction.

File: [`05-mark-the-order-paid-exactly-once.py`](./05-mark-the-order-paid-exactly-once.py)

```python
# app.py (continued)
# CREATE TABLE processed_events (event_id TEXT PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP);


def mark_paid_once(event_id: str, order_id: str) -> None:
    # the second "conn" is a transaction: commit on success, rollback on error
    with closing(db()) as conn, conn:
        cur = conn.execute("INSERT OR IGNORE INTO processed_events (event_id) VALUES (?)", (event_id,))
        if cur.rowcount == 1:  # first delivery of the event
            conn.execute("UPDATE orders SET status = 'paid' WHERE id = ? AND status <> 'paid'", (int(order_id),))
```

## 6. Test the integration

Moonvex has no test network: everything runs on mainnets. The “Send test” button under “Integration” sends a webhook.test event, which is how you check the signature. Then pay a small invoice, for example 1 USDT on TRON: it is a regular payment and the money lands on your balance. The delivery log with response codes and a “Retry” button is on the same page.

## Pitfalls

- Use request.get_data(), not request.json: the signature covers the original bytes and re-serialising changes them.
- Keep amounts as Decimal or strings. 0.1 + 0.2 in float is not 0.3, and in payments that is an error in cents.
- Always pass a timeout to requests.post; without it a hung request holds the worker forever.
- verify_moonvex accepts every v1 value in the header, so a secret rotation causes no downtime.
- Need one fixed coin instead of the customer's choice? Add network (and asset when currency is USD) to the same request, for example "network": "TRON", "asset": "USDT": that is the classic payment in one coin. The checkout above is the recommended flow.

## FAQ

**Is there an official Python SDK?**

The official SDK is for Node.js (@moonvex/node). In Python requests or httpx is enough: the API is plain HTTPS with JSON, and signature verification is the dozen lines shown in this guide.

**What if the customer does not pay in time?**

The checkout is valid until expiresAt; the window is set with expiresInMinutes, 5 to 1440 minutes, 30 by default. If the customer started a payment and did not pay it in time, it moves to EXPIRED and you receive payment.expired. To let them try again, create a new checkout with a new Idempotency-Key (for example, bump the attempt number at the end of the key); if the API answers DUPLICATE_ORDER, that order number is closed, so use a new orderId such as 1001-2.

**Is there a test mode or a sandbox?**

No, there is no test network: Moonvex runs on mainnets only. Check the signature with the “Send test” button (a webhook.test event) and the whole payment flow with a real payment of a small amount, for example 1 USDT on TRON.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=python
