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


def create_payment(order_id: int, amount: str, attempt: int = 1) -> dict:
    r = requests.post(
        API + "/v1/payments",
        headers={
            "Authorization": "Bearer " + os.environ["MOONVEX_SECRET_KEY"],
            # a retry with the same key never creates a second invoice
            "Idempotency-Key": f"order-{order_id}-{attempt}",
        },
        json={"orderId": str(order_id), "amount": amount, "currency": "USDT", "network": "TRON"},
        timeout=15,
    )
    payment = r.json()
    if r.status_code >= 400:
        raise RuntimeError(payment["error"]["code"] + ": " + payment["error"]["message"])
    return payment


@app.post("/orders/<int:order_id>/pay")
def pay(order_id: int):
    with closing(db()) as conn:
        order = conn.execute("SELECT id, total FROM orders WHERE id = ?", (order_id,)).fetchone()
    if order is None:
        abort(404)
    # total is stored as TEXT "25.00", so the amount is sent as a string
    payment = create_payment(order["id"], str(order["total"]))
    return redirect(payment["paymentUrl"], code=303)
