// bot.js
import { Markup, Telegraf } from 'telegraf';
import { Moonvex, withLanguage } from '@moonvex/node';

export const bot = new Telegraf(process.env.BOT_TOKEN);
export const moonvex = new Moonvex({ apiKey: process.env.MOONVEX_SECRET_KEY });

bot.command('buy', async (ctx) => {
  // a unique order id: chat + message
  const orderId = 'tg-' + ctx.chat.id + '-' + ctx.message.message_id;
  const checkout = await moonvex.checkouts.create(
    {
      orderId,
      amount: '10',
      currency: 'USD', // no network: the customer picks the coin on the checkout page
      description: 'Premium access for 30 days', // shown as “You are paying for”
      returnUrl: 'https://t.me/' + ctx.botInfo.username, // the Back buttons lead back to the bot
      customerId: String(ctx.from.id),
      metadata: { chatId: ctx.chat.id }, // comes back in the webhook
    },
    { idempotencyKey: orderId + '-1' },
  );
  // checkout language from the Telegram user's language
  const code = (ctx.from.language_code || '').slice(0, 2);
  const lang = code === 'ru' || code === 'uk' ? code : 'en';
  await ctx.reply(
    'To pay: ' + checkout.amount + ' ' + checkout.currency + '. Choose the coin and network on the next page.',
    Markup.inlineKeyboard([Markup.button.url('Pay', withLanguage(checkout.paymentUrl, lang))]),
  );
});

bot.catch((err, ctx) => {
  console.error(err);
  return ctx.reply('Could not create the invoice, try again later');
});
