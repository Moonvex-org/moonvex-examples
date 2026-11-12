# Accept crypto payments in Express

A Moonvex integration for an Express app with no extra dependencies: the built-in fetch creates a checkout where the customer picks the coin and network, node:crypto verifies webhook signatures, and a PostgreSQL transaction marks each order paid exactly once.

Full guide with explanations: https://moonvex.org/en/guides/express?utm_source=github&utm_medium=repo&utm_campaign=express

## 1. Get an API key and a webhook secret

In the Moonvex dashboard go to “Integration” → “Create key” → type “Secret” (sk_live_…). The key is shown only once: store it on your server as MOONVEX_SECRET_KEY. On the same page add a webhook pointing to an https URL on your server and store its signing secret as MOONVEX_WEBHOOK_SECRET.

File: [`01-get-an-api-key-and-a-webhook-secret.sh`](./01-get-an-api-key-and-a-webhook-secret.sh)

```bash
npm install express pg

# .env — server only, never commit it
MOONVEX_SECRET_KEY=sk_live_...
MOONVEX_WEBHOOK_SECRET=whsec_...
DATABASE_URL=postgres://user:pass@localhost:5432/shop
```

## 2. Create a checkout

POST /v1/payments with the Authorization: Bearer and Idempotency-Key headers (8 to 128 characters). Required fields are orderId, amount (as a string) and currency: USD or a coin such as USDT. Without network and asset Moonvex creates a checkout where the customer picks the coin and network. description is shown to the customer as “You are paying for”, returnUrl (https only) is where the Back buttons lead. A 201 response returns an object with object: "checkout", id (inv_…), status AWAITING_SELECTION and paymentUrl. Errors share one format: error.code, error.message and requestId.

File: [`02-create-a-checkout.js`](./02-create-a-checkout.js)

```js
// server.js
import express from 'express';
import { db } from './db.js';

const app = express();

async function createCheckout(order, attempt = 1) {
  const res = await fetch('https://api.moonvex.org/v1/payments', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.MOONVEX_SECRET_KEY,
      'Idempotency-Key': 'order-' + order.id + '-' + attempt,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      orderId: String(order.id),
      amount: order.total, // a "25.00" string from numeric, no floats
      currency: 'USD', // no network: the customer picks the coin on the checkout page
      description: 'Order #' + order.id, // shown as “You are paying for”
      returnUrl: 'https://shop.example.com/orders/' + order.id, // the Back buttons
    }),
    signal: AbortSignal.timeout(15000),
  });
  const checkout = await res.json();
  if (!res.ok) throw new Error(checkout.error.code + ': ' + checkout.error.message);
  return checkout; // { object: 'checkout', id: 'inv_…', status: 'AWAITING_SELECTION', paymentUrl, … }
}

app.post('/orders/:id/pay', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, total::text AS total FROM orders WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.sendStatus(404);
    const checkout = await createCheckout(rows[0]);
    res.redirect(303, checkout.paymentUrl);
  } catch (err) {
    next(err);
  }
});
```

## 3. Send the customer to paymentUrl

paymentUrl is the Moonvex checkout page: the customer picks the coin and network, then sees the exact amount including the fee, the address, a QR code, the official token contract and a timer, with a status that updates by itself. Your description is shown as “You are paying for”, and the Back and “Back to the shop” buttons lead to returnUrl. If you know the customer's language, add ?lang=ru, ?lang=uk or ?lang=en to paymentUrl; otherwise the page picks the language itself. Open the page with a redirect or in a new tab; it cannot be embedded in an iframe. A customer returning to your site is not proof of payment: mark the order paid only from a webhook. In Express that is res.redirect(303, payment.paymentUrl).

## 4. Receive the webhook and verify the signature

Moonvex sends a POST with a Moonvex-Signature header: t=<unix time>,v1=<signature>. The signature is a hex HMAC-SHA256 of the string “t.raw_body” keyed with the webhook secret. Compute it over the body bytes before parsing JSON, compare in constant time and reject events older than 5 minutes. For 24 hours after a secret rotation the header carries two v1 values; either one is valid. The key point in Express: put express.raw({ type: 'application/json' }) on the webhook route itself and register it before the global express.json(), so req.body is a Buffer with the original bytes.

File: [`04-receive-the-webhook-and-verify-the.js`](./04-receive-the-webhook-and-verify-the.js)

```js
// server.js (continued)
import crypto from 'node:crypto';
import { markOrderPaidOnce } from './db.js';

/** true if the signature is valid and the event is at most 5 minutes old */
function verifyMoonvex(rawBody, header, secret, toleranceSec = 300) {
  const parts = (header || '').split(',').map((p) => p.split('='));
  const t = Number((parts.find(([k]) => k === 't') || [])[1]);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(t + '.').update(rawBody).digest();
  // during a secret rotation two v1 values arrive for 24 hours, either one is valid
  return parts
    .filter(([k]) => k === 'v1')
    .some(([, sig]) => {
      const got = Buffer.from(sig || '', 'hex');
      return got.length === expected.length && crypto.timingSafeEqual(got, expected);
    });
}

// express.raw BEFORE express.json: you need a Buffer with the original bytes
app.post('/moonvex/webhook', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    if (!verifyMoonvex(req.body, req.get('Moonvex-Signature'), process.env.MOONVEX_WEBHOOK_SECRET)) {
      return res.status(400).send('bad signature');
    }
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.type === 'payment.confirmed' || event.type === 'payment.overpaid') {
      await markOrderPaidOnce(event.id, event.data.orderId);
    }
    // payment.cancelled also arrives when the customer switches coins: do not cancel the order on it
    res.sendStatus(200);
  } catch (err) {
    next(err); // a 5xx makes Moonvex retry later
  }
});

// the global JSON parser goes after the webhook route
app.use(express.json());
app.listen(3000);
```

## 5. Mark the order paid exactly once

A redelivered event keeps the same id, so store it in a table with a unique key in the same transaction as the order update: a duplicate then changes nothing. Fulfil on payment.confirmed and payment.overpaid, never on payment.detected. Events arrive for the payment the customer starts: data.id is its pay_… id and data.orderId is your order number. If the customer switches coins, the previous payment gets payment.cancelled: do not cancel the order on it while the checkout is open. If processing fails, pass the error to next: a 5xx response makes Moonvex retry the delivery later.

File: [`05-mark-the-order-paid-exactly-once.js`](./05-mark-the-order-paid-exactly-once.js)

```js
// db.js
import pg from 'pg';

export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// CREATE TABLE processed_events (
//   event_id   text PRIMARY KEY,
//   created_at timestamptz NOT NULL DEFAULT now()
// );

/** Marks the order as paid exactly once, even if the event is delivered again */
export async function markOrderPaidOnce(eventId, orderId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const fresh = await client.query(
      'INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [eventId],
    );
    if (fresh.rowCount === 1) {
      // first delivery of this event
      await client.query(
        "UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1 AND status <> 'paid'",
        [orderId],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

## 6. Test the integration

Moonvex has no test network: everything runs on mainnets. The “Send test” button under “Integration” sends a webhook.test event, which is how you check the signature. Then pay a small invoice, for example 1 USDT on TRON: it is a regular payment and the money lands on your balance. The delivery log with response codes and a “Retry” button is on the same page.

## Pitfalls

- If app.use(express.json()) runs before the webhook route, the body is already parsed and the signature cannot be checked. Declare the webhook first or exclude its path from the JSON parser.
- Never compare signatures with ===. Use crypto.timingSafeEqual after checking the buffer lengths match.
- Moonvex retries a 4xx response (except 408 and 429) only 3 times. Return 5xx for temporary failures and 400 only for a bad signature.
- Protect the payment route with your usual CSRF protection and the webhook with the signature only: Moonvex does not have your cookies or tokens.
- Need one fixed coin instead of the customer's choice? Add network (and asset when currency is USD) to the same request, for example "network": "TRON", "asset": "USDT": that is the classic payment in one coin, and the page opens straight on the address. The checkout above is the recommended flow.

## FAQ

**How is the Express version different from the SDK?**

The protocol is the same: the same POST /v1/payments and the same signature scheme. Here everything is written by hand, which suits you if you want no extra packages. With @moonvex/node the checkout is moonvex.checkouts.create and verification is a single verifyWebhook call.

**Why is amount in the webhook higher than the order price?**

The checkout returns your price as is in amount and currency. The payment the customer starts (data in webhooks) is in the chosen coin, and its amount is the total due including the Moonvex fee on top. Your price stays in pricing.amount, and what you receive on a full payment is in merchantAmount. Reconcile orders by orderId and pricing.amount.

**Is there a test mode or a sandbox?**

No, there is no test network: Moonvex runs on mainnets only. Check the signature with the “Send test” button (a webhook.test event) and the whole payment flow with a real payment of a small amount, for example 1 USDT on TRON.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=express
