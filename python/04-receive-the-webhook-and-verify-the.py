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
