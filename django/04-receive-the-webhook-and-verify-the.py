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
    return HttpResponse("ok")


# urls.py
# path("orders/<int:order_id>/pay/", views.pay),
# path("moonvex/webhook/", webhooks.moonvex_webhook),
