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
