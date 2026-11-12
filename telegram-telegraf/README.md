# Accept crypto payments in a Telegraf Telegram bot

A Telegraf bot issues an invoice on /buy through the @moonvex/node SDK and sends a pay button, while an Express server receives the Moonvex webhook, verifies the signature and messages the customer. Bots with a balance get a permanent top-up address.

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

moonvex.payments.create with orderId from the chat and message, customerId as the user id and chatId in metadata. Metadata comes back in the webhook. idempotencyKey prevents a second invoice if the user repeats the command on a slow connection.

File: [`02-issue-an-invoice-on-buy.js`](./02-issue-an-invoice-on-buy.js)

```js
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
```

## 3. Send the pay button

Markup.button.url opens paymentUrl, a hosted payment page with the amount, address and QR code. It opens in the browser and cannot be embedded in a frame. Show the customer amount from the response: that is the total including the fee.

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
  res.sendStatus(200);
});

app.listen(3000); // behind nginx with https
bot.launch();
```

## 5. Mark the order paid exactly once

A redelivered event keeps the same id, so store it in a table with a unique key in the same transaction as the order update: a duplicate then changes nothing. Fulfil on payment.confirmed and payment.overpaid, never on payment.detected. claimEvent returns true only on the first insert of the event id, so the payment message never goes out twice.

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

For a bot with an internal balance: moonvex.depositAddresses.create({ customerId, network }) returns a permanent address, the same one on every call. Every incoming transfer arrives as a deposit.confirmed event with customerId and receivedAmount; credit it once per event.id. The key needs the wallets:write scope.

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
  await creditBalance(d.customerId, d.asset, d.receivedAmount); // your function
  await bot.telegram.sendMessage(Number(d.customerId), 'Balance topped up: ' + d.receivedAmount + ' ' + d.asset);
}
```

## Pitfalls

- Use express.raw on the webhook route only: a global express.json() breaks signature verification.
- bot.catch handles API errors (such as MoonvexError) and keeps the bot alive.
- Never deliver goods on a button press; only on payment.confirmed / payment.overpaid.
- There is no test network: test the bot with a 1 USDT payment on TRON and the “Send test” button in the dashboard.

## FAQ

**Can the bot and the webhook run on one server?**

Yes, as in the example: Telegraf uses polling and Express listens on a port for Moonvex. From the outside you need an https URL, for example nginx in front of port 3000.

**Is this Telegram Payments or Stars?**

No. The customer pays in crypto on the Moonvex payment page and the money lands on your Moonvex project balance. No Telegram payment provider is involved.

**What if the customer does not pay in time?**

The payment moves to EXPIRED and you receive payment.expired. You can create a new payment for the same orderId with a new Idempotency-Key (for example, bump the attempt number at the end of the key). The payment window is set with expiresInMinutes: 5 to 1440 minutes, 30 by default.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=telegram-telegraf
