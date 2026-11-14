# bot.py (continued) — the key needs the wallets:write scope
@dp.message(Command("topup"))
async def topup(message: Message) -> None:
    r = await moonvex.post(
        "/v1/deposit-addresses",
        json={"customerId": str(message.from_user.id), "network": "TRON"},
    )
    if r.status_code >= 400:
        await message.answer("Could not get the address, try again later")
        return
    # the same address on every call: the customer can top it up any time
    await message.answer("Your top-up address (USDT or TRX, TRON network):\n" + r.json()["address"])


# in moonvex_webhook: credit the customer balance once per event id
if event["type"] == "deposit.confirmed" and await claim_event(request.app["db"], event["id"]):
    d = event["data"]
    await credit_balance(d["customerId"], d["asset"], d["netAmount"])  # your function; netAmount = after the Moonvex fee
    await bot.send_message(int(d["customerId"]), "Balance topped up: " + d["netAmount"] + " " + d["asset"])
