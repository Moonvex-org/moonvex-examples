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
    me = await bot.me()
    r = await moonvex.post(
        "/v1/payments",
        headers={"Idempotency-Key": order_id + "-1"},
        json={
            "orderId": order_id,
            "amount": "10",
            "currency": "USD",  # no network: the customer picks the coin on the checkout page
            "description": "Premium access for 30 days",  # shown as “You are paying for”
            "returnUrl": f"https://t.me/{me.username}",  # the Back buttons lead back to the bot
            "customerId": str(message.from_user.id),
            "metadata": {"chatId": message.chat.id},  # comes back in the webhook
        },
    )
    checkout = r.json()
    if r.status_code >= 400:
        await message.answer("Could not create the invoice, try again later")
        return
    # checkout language from the Telegram user's language
    code = (message.from_user.language_code or "")[:2]
    lang = code if code in ("ru", "uk") else "en"
    url = checkout["paymentUrl"] + "?lang=" + lang
    kb = InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text="Pay", url=url)]])
    await message.answer(f"To pay: {checkout['amount']} {checkout['currency']}. Choose the coin and network on the next page.", reply_markup=kb)
