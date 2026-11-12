# Accept crypto payments in Django

How to accept crypto in a Django project: a view creates a Moonvex checkout and sends the customer there to pick the coin and network, and a separate view receives the webhook, verifies the signature over request.body and marks the order paid once.

Full guide with explanations: https://moonvex.org/en/guides/django?utm_source=github&utm_medium=repo&utm_campaign=django

## 1. Get an API key and a webhook secret

In the Moonvex dashboard go to “Integration” → “Create key” → type “Secret” (sk_live_…). The key is shown only once: store it on your server as MOONVEX_SECRET_KEY. On the same page add a webhook pointing to an https URL on your server and store its signing secret as MOONVEX_WEBHOOK_SECRET. In Django keep them in settings, read from environment variables. A ProcessedEvent model keyed by event_id protects against double processing.

File: [`01-get-an-api-key-and-a-webhook-secret.py`](./01-get-an-api-key-and-a-webhook-secret.py)

```python
# settings.py
import os

MOONVEX_SECRET_KEY = os.environ["MOONVEX_SECRET_KEY"]  # sk_live_...
MOONVEX_WEBHOOK_SECRET = os.environ["MOONVEX_WEBHOOK_SECRET"]  # whsec_...

# shop/models.py
from django.db import models


class Order(models.Model):
    class Status(models.TextChoices):
        NEW = "new"
        PAID = "paid"

    user = models.ForeignKey("auth.User", on_delete=models.PROTECT)
    total = models.DecimalField(max_digits=18, decimal_places=2)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.NEW)
    moonvex_checkout_id = models.CharField(max_length=64, blank=True)  # inv_…


class ProcessedEvent(models.Model):
    # the Moonvex event id is the primary key, so a duplicate is impossible
    event_id = models.CharField(max_length=64, primary_key=True)
    created_at = models.DateTimeField(auto_now_add=True)
```

## 2. Create a checkout in a view

The pay view accepts only POST from a signed-in user and creates a checkout with str(order.total) as the amount (a DecimalField gives a string like 25.00 with no precision loss). There is no network in the request: the customer picks the coin and network on the Moonvex page. description is shown as “You are paying for”, and returnUrl, built with request.build_absolute_uri, is where the Back buttons lead; it must be https, so behind a proxy set SECURE_PROXY_SSL_HEADER. The checkout id (inv_…) is saved on the order.

File: [`02-create-a-checkout-in-a-view.py`](./02-create-a-checkout-in-a-view.py)

```python
# shop/views.py
import requests
from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.shortcuts import get_object_or_404, redirect
from django.views.decorators.http import require_POST

from .models import Order


@login_required
@require_POST
def pay(request, order_id: int):
    order = get_object_or_404(Order, pk=order_id, user=request.user, status=Order.Status.NEW)
    r = requests.post(
        "https://api.moonvex.org/v1/payments",
        headers={
            "Authorization": "Bearer " + settings.MOONVEX_SECRET_KEY,
            "Idempotency-Key": f"order-{order.pk}-1",
        },
        json={
            "orderId": str(order.pk),
            "amount": str(order.total),  # Decimal → "25.00", no float
            "currency": "USD",  # no network: the customer picks the coin on the checkout page
            "description": f"Order #{order.pk}",  # shown as “You are paying for”
            "returnUrl": request.build_absolute_uri(f"/orders/{order.pk}/"),  # the Back buttons, https only
        },
        timeout=15,
    )
    checkout = r.json()
    if r.status_code >= 400:
        raise RuntimeError(checkout["error"]["code"] + ": " + checkout["error"]["message"])
    Order.objects.filter(pk=order.pk).update(moonvex_checkout_id=checkout["id"])
    return redirect(checkout["paymentUrl"])
```

## 3. Send the customer to paymentUrl

paymentUrl is the Moonvex checkout page: the customer picks the coin and network, then sees the exact amount including the fee, the address, a QR code, the official token contract and a timer, with a status that updates by itself. Your description is shown as “You are paying for”, and the Back and “Back to the shop” buttons lead to returnUrl. If you know the customer's language, add ?lang=ru, ?lang=uk or ?lang=en to paymentUrl; otherwise the page picks the language itself. Open the page with a redirect or in a new tab; it cannot be embedded in an iframe. A customer returning to your site is not proof of payment: mark the order paid only from a webhook. In Django: redirect(payment["paymentUrl"]).

## 4. Receive the webhook and verify the signature

Moonvex sends a POST with a Moonvex-Signature header: t=<unix time>,v1=<signature>. The signature is a hex HMAC-SHA256 of the string “t.raw_body” keyed with the webhook secret. Compute it over the body bytes before parsing JSON, compare in constant time and reject events older than 5 minutes. For 24 hours after a secret rotation the header carries two v1 values; either one is valid. The webhook view is decorated with @csrf_exempt: Moonvex sends no CSRF token, the signature is the protection. The raw body is request.body.

File: [`04-receive-the-webhook-and-verify-the.py`](./04-receive-the-webhook-and-verify-the.py)

```python
# shop/webhooks.py
import hashlib
import hmac
import json
import time

from django.conf import settings
from django.http import HttpResponse, HttpResponseBadRequest
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .payments import mark_paid_once


def verify_moonvex(raw: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    parts = [p.split("=", 1) for p in (header or "").split(",") if "=" in p]
    t = next((v for k, v in parts if k == "t"), None)
    if t is None or not t.isdigit() or abs(time.time() - int(t)) > tolerance:
        return False
    expected = hmac.new(secret.encode(), t.encode() + b"." + raw, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, v) for k, v in parts if k == "v1")


@csrf_exempt  # Moonvex has no CSRF token; the HMAC signature is the protection
@require_POST
def moonvex_webhook(request):
    raw = request.body  # raw bytes; do not touch request.POST before this
    if not verify_moonvex(raw, request.headers.get("Moonvex-Signature", ""), settings.MOONVEX_WEBHOOK_SECRET):
        return HttpResponseBadRequest("bad signature")
    event = json.loads(raw)
    if event["type"] in ("payment.confirmed", "payment.overpaid"):
        mark_paid_once(event["id"], event["data"]["orderId"])
    # payment.cancelled also arrives when the customer switches coins: do not cancel the order on it
    return HttpResponse("ok")


# urls.py
# path("orders/<int:order_id>/pay/", views.pay),
# path("moonvex/webhook/", webhooks.moonvex_webhook),
```

## 5. Mark the order paid exactly once

A redelivered event keeps the same id, so store it in a table with a unique key in the same transaction as the order update: a duplicate then changes nothing. Fulfil on payment.confirmed and payment.overpaid, never on payment.detected. Events arrive for the payment the customer starts: data.id is its pay_… id and data.orderId is your order number. If the customer switches coins, the previous payment gets payment.cancelled: do not cancel the order on it while the checkout is open. get_or_create inside transaction.atomic: if the row already exists, this is a redelivery and the order is left alone.

File: [`05-mark-the-order-paid-exactly-once.py`](./05-mark-the-order-paid-exactly-once.py)

```python
# shop/payments.py
from django.db import transaction

from .models import Order, ProcessedEvent


def mark_paid_once(event_id: str, order_id: str) -> None:
    with transaction.atomic():
        _, created = ProcessedEvent.objects.get_or_create(event_id=event_id)
        if not created:
            return  # a redelivery: do nothing
        Order.objects.filter(pk=int(order_id)).exclude(status=Order.Status.PAID).update(status=Order.Status.PAID)
```

## 6. Test the integration

Moonvex has no test network: everything runs on mainnets. The “Send test” button under “Integration” sends a webhook.test event, which is how you check the signature. Then pay a small invoice, for example 1 USDT on TRON: it is a regular payment and the money lands on your balance. The delivery log with response codes and a “Retry” button is on the same page.

## Pitfalls

- Without @csrf_exempt Django answers every webhook with 403, and Moonvex retries a 4xx only 3 times.
- Do not touch request.POST before reading request.body: you do not need it for application/json, and the stream read order matters.
- Send heavy work (emails, granting access) to Celery after responding 200; you have 10 seconds to respond.
- Use DecimalField for prices and str() when sending. A float from FloatField gives amounts like 24.999999.
- With django.utils.translation you know the customer's language: redirect to checkout["paymentUrl"] + "?lang=" + get_language()[:2] when it is ru, uk or en, so the checkout opens in the same language.
- Need one fixed coin instead of the customer's choice? Add network (and asset when currency is USD) to the same request, for example "network": "TRON", "asset": "USDT": that is the classic payment in one coin. The checkout above is the recommended flow.

## FAQ

**Does this work with Django REST Framework?**

Yes, but in the webhook read request.body before touching request.data, and disable authentication and CSRF for that view (authentication_classes = [] and permission_classes = [AllowAny]).

**Why is amount in the webhook higher than the order price?**

The checkout returns your price as is in amount and currency. The payment the customer starts (data in webhooks) is in the chosen coin, and its amount is the total due including the Moonvex fee on top. Your price stays in pricing.amount, and what you receive on a full payment is in merchantAmount. Reconcile orders by orderId and pricing.amount.

**What if the customer does not pay in time?**

The checkout is valid until expiresAt; the window is set with expiresInMinutes, 5 to 1440 minutes, 30 by default. If the customer started a payment and did not pay it in time, it moves to EXPIRED and you receive payment.expired. To let them try again, create a new checkout with a new Idempotency-Key (for example, bump the attempt number at the end of the key); if the API answers DUPLICATE_ORDER, that order number is closed, so use a new orderId such as 1001-2.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=django
