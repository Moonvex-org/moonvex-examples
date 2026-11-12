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
