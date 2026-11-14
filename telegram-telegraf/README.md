# Accept crypto payments in a Telegraf Telegram bot

A Telegraf bot creates a checkout on /buy with checkouts.create from @moonvex/node and sends a pay button (the customer picks the coin and network on the page), while an Express server receives the Moonvex webhook, verifies the signature and messages the customer. Bots with a balance get a permanent top-up address.

Full guide with explanations: https://moonvex.org/en/guides/telegram-telegraf?utm_source=github&utm_medium=repo&utm_campaign=telegram-telegraf

## 1. Get an API key and a webhook secret

In the Moonvex dashboard go to “Integration” → “Create key” → type “Secret” (sk_live_…). The key is shown only once: store it on your server as MOONVEX_SECRET_KEY. On the same page add a webhook pointing to an https URL on your server and store its signing secret as MOONVEX_WEBHOOK_SECRET. The bot also needs a BOT_TOKEN from @BotFather.

File: [`01-get-an-api-key-and-a-webhook-secret.sh`](./01-get-an-api-key-and-a-webhook-secret.sh)

```bash
npm install telegraf express @moonvex/node pg

# .env
BOT_TOKEN=123456:ABC...
MOONVEX_SECRET_KEY=sk_live_...
MOONVEX_WEBHOOK_SECRET=whsec_...
DATABASE_URL=postgres://user:pass@localhost:5432/bot
```

## 2. Issue an invoice on /buy

moonvex.checkouts.create creates a checkout: there is no network, so the customer picks the coin and network on the Moonvex page. orderId comes from the chat and message, customerId is the user id and chatId goes into metadata, which comes back in the webhook. description is shown as “You are paying for”, and returnUrl is the bot link https://t.me/<bot_username> (ctx.botInfo.username), so the Back buttons return the customer to the chat. withLanguage picks the checkout language from the user's language_code: ru or uk, otherwise en. idempotencyKey prevents a second checkout if the user repeats the command on a slow connection.

File: [`02-issue-an-invoice-on-buy.js`](./02-issue-an-invoice-on-buy.js)

```js
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
```

## 3. Send the pay button

Markup.button.url opens paymentUrl, the Moonvex checkout page. There the customer picks the coin and network and sees the exact amount including the fee, the address and a QR code; until funds arrive they can switch to another coin. The page opens in the browser and cannot be embedded in a frame. The Back and “Back to the shop” buttons lead to returnUrl, the bot chat. The checkout response carries your price (amount and currency); the total in the chosen coin is shown on the page.

## 4. Receive the webhook and verify the signature

Moonvex sends a POST with a Moonvex-Signature header: t=<unix time>,v1=<signature>. The signature is a hex HMAC-SHA256 of the string “t.raw_body” keyed with the webhook secret. Compute it over the body bytes before parsing JSON, compare in constant time and reject events older than 5 minutes. For 24 hours after a secret rotation the header carries two v1 values; either one is valid. verifyWebhook from the SDK takes the Buffer from express.raw and throws on a bad signature or a stale event.

File: [`04-receive-the-webhook-and-verify-the.js`](./04-receive-the-webhook-and-verify-the.js)

```js
// server.js
import express from 'express';
import { verifyWebhook } from '@moonvex/node';
import { bot } from './bot.js';
import { claimEvent } from './db.js';

const app = express();

// express.raw: the signature covers the raw body
app.post('/moonvex/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = verifyWebhook(req.body, req.get('Moonvex-Signature'), process.env.MOONVEX_WEBHOOK_SECRET);
  } catch {
    return res.status(400).send('bad signature');
  }

  if ((event.type === 'payment.confirmed' || event.type === 'payment.overpaid') && (await claimEvent(event.id))) {
    await bot.telegram.sendMessage(
      event.data.metadata.chatId,
      'Payment received, thank you! Order ' + event.data.orderId,
    );
  }
  // payment.cancelled also arrives when the customer switches coins: ignore it, the checkout stays open
  res.sendStatus(200);
});

app.listen(3000); // behind nginx with https
bot.launch();
```

## 5. Mark the order paid exactly once

A redelivered event keeps the same id, so store it in a table with a unique key in the same transaction as the order update: a duplicate then changes nothing. Fulfil on payment.confirmed and payment.overpaid, never on payment.detected. Events arrive for the payment the customer starts: data.id is its pay_… id and data.orderId is your order number. If the customer switches coins, the previous payment gets payment.cancelled: do not cancel the order on it while the checkout is open. claimEvent returns true only on the first insert of the event id, so the payment message never goes out twice.

File: [`05-mark-the-order-paid-exactly-once.js`](./05-mark-the-order-paid-exactly-once.js)

```js
// db.js
import pg from 'pg';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// CREATE TABLE processed_events (event_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());

/** true only for the first delivery of the event */
export async function claimEvent(eventId) {
  const r = await db.query('INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId]);
  return r.rowCount === 1;
}
```

## 6. Top up a balance through a permanent address

For a bot with an internal balance: moonvex.depositAddresses.create({ customerId, network }) returns a permanent address, the same one on every call. Every incoming transfer arrives as a deposit.confirmed event with customerId and netAmount (what reaches your balance after the fee; receivedAmount is the gross transfer); credit netAmount once per event.id. The key needs the wallets:write scope.

File: [`06-top-up-a-balance-through-a-permanent.js`](./06-top-up-a-balance-through-a-permanent.js)

```js
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
```

## Pitfalls

- Use express.raw on the webhook route only: a global express.json() breaks signature verification.
- bot.catch handles API errors (such as MoonvexError) and keeps the bot alive.
- Never deliver goods on a button press; only on payment.confirmed / payment.overpaid.
- There is no test network: test the bot with a 1 USDT payment on TRON and the “Send test” button in the dashboard.
- Need one fixed coin instead of the customer's choice? moonvex.payments.create with network (and asset when currency is USD), for example network: 'TRON', asset: 'USDT', still works. The checkout above is the recommended flow.

## FAQ

**Can the bot and the webhook run on one server?**

Yes, as in the example: Telegraf uses polling and Express listens on a port for Moonvex. From the outside you need an https URL, for example nginx in front of port 3000.

**Is this Telegram Payments or Stars?**

No. The customer pays in crypto on the Moonvex payment page and the money lands on your Moonvex project balance. No Telegram payment provider is involved.

**What if the customer does not pay in time?**

The checkout is valid until expiresAt; the window is set with expiresInMinutes, 5 to 1440 minutes, 30 by default. If the customer started a payment and did not pay it in time, it moves to EXPIRED and you receive payment.expired. To let them try again, create a new checkout with a new Idempotency-Key (for example, bump the attempt number at the end of the key); if the API answers DUPLICATE_ORDER, that order number is closed, so use a new orderId such as 1001-2.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=telegram-telegraf
