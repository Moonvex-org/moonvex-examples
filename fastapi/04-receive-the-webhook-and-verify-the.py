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
