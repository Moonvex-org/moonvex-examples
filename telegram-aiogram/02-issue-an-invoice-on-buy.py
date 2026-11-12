# bot.py
import os

import httpx
from aiogram import Bot, Dispatcher
from aiogram.filters import Command
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message

bot = Bot(os.environ["BOT_TOKEN"])
dp = Dispatcher()
moonvex = httpx.AsyncClient(
    base_url="https://api.moonvex.org",
    headers={"Authorization": "Bearer " + os.environ["MOONVEX_SECRET_KEY"]},
    timeout=15,
)


@dp.message(Command("buy"))
async def buy(message: Message) -> None:
    # a unique order id: chat + message
    order_id = f"tg-{message.chat.id}-{message.message_id}"
    r = await moonvex.post(
        "/v1/payments",
        headers={"Idempotency-Key": order_id + "-1"},
        json={
            "orderId": order_id,
            "amount": "10",
            "currency": "USDT",
            "network": "TRON",
            "customerId": str(message.from_user.id),
            "metadata": {"chatId": message.chat.id},  # comes back in the webhook
        },
    )
    payment = r.json()
    if r.status_code >= 400:
        await message.answer("Could not create the invoice, try again later")
        return
    kb = InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text="Pay", url=payment["paymentUrl"])]])
    await message.answer(f"Amount due: {payment['amount']} {payment['asset']} ({payment['network']})", reply_markup=kb)
