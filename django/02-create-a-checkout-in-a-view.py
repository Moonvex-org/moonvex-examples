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
