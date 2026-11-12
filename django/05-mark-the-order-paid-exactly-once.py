# shop/payments.py
from django.db import transaction

from .models import Order, ProcessedEvent


def mark_paid_once(event_id: str, order_id: str) -> None:
    with transaction.atomic():
        _, created = ProcessedEvent.objects.get_or_create(event_id=event_id)
        if not created:
            return  # a redelivery: do nothing
        Order.objects.filter(pk=int(order_id)).exclude(status=Order.Status.PAID).update(status=Order.Status.PAID)
