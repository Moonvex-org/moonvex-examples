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
        # numeric arrives as Decimal → str(): "25.00"
        json={"orderId": str(order_id), "amount": str(order["total"]), "currency": "USDT", "network": "TRON"},
    )
    payment = r.json()
    if r.status_code >= 400:
        raise HTTPException(502, payment["error"]["code"])
    return RedirectResponse(payment["paymentUrl"], status_code=303)
