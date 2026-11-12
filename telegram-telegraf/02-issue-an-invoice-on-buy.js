// bot.js
import { Markup, Telegraf } from 'telegraf';
import { Moonvex } from '@moonvex/node';

export const bot = new Telegraf(process.env.BOT_TOKEN);
export const moonvex = new Moonvex({ apiKey: process.env.MOONVEX_SECRET_KEY });

bot.command('buy', async (ctx) => {
  // a unique order id: chat + message
  const orderId = 'tg-' + ctx.chat.id + '-' + ctx.message.message_id;
  const payment = await moonvex.payments.create(
    {
      orderId,
      amount: '10',
      currency: 'USDT',
      network: 'TRON',
      customerId: String(ctx.from.id),
      metadata: { chatId: ctx.chat.id }, // comes back in the webhook
    },
    { idempotencyKey: orderId + '-1' },
  );
  await ctx.reply(
    'Amount due: ' + payment.amount + ' ' + payment.asset + ' (' + payment.network + ')',
    Markup.inlineKeyboard([Markup.button.url('Pay', payment.paymentUrl)]),
  );
});

bot.catch((err, ctx) => {
  console.error(err);
  return ctx.reply('Could not create the invoice, try again later');
});
