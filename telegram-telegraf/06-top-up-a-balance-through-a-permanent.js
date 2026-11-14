// bot.js (continued) — the key needs the wallets:write scope
bot.command('topup', async (ctx) => {
  // the same address on every call: the customer tops it up any time
  const deposit = await moonvex.depositAddresses.create({ customerId: String(ctx.from.id), network: 'TRON' });
  await ctx.reply('Your top-up address (USDT or TRX, TRON network):\n' + deposit.address);
});

// server.js, in the webhook handler: credit once per event.id
if (event.type === 'deposit.confirmed' && (await claimEvent(event.id))) {
  const d = event.data;
  await creditBalance(d.customerId, d.asset, d.netAmount); // your function; netAmount = after the Moonvex fee
  await bot.telegram.sendMessage(Number(d.customerId), 'Balance topped up: ' + d.netAmount + ' ' + d.asset);
}
