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
