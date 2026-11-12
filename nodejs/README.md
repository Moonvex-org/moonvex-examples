# Accept crypto payments in Node.js

A step-by-step Moonvex integration in plain Node.js with the official @moonvex/node SDK: your server creates an invoice, the customer pays on a hosted page, and an HMAC-signed webhook marks the order paid. No framework, just node:http and PostgreSQL.

Full guide with explanations: https://moonvex.org/en/guides/nodejs?utm_source=github&utm_medium=repo&utm_campaign=nodejs

## 1. Get an API key and a webhook secret

In the Moonvex dashboard go to “Integration” → “Create key” → type “Secret” (sk_live_…). The key is shown only once: store it on your server as MOONVEX_SECRET_KEY. On the same page add a webhook pointing to an https URL on your server and store its signing secret as MOONVEX_WEBHOOK_SECRET. The @moonvex/node SDK has no dependencies and needs Node.js 18+.

File: [`01-get-an-api-key-and-a-webhook-secret.sh`](./01-get-an-api-key-and-a-webhook-secret.sh)

```bash
npm install @moonvex/node pg

# .env — server only, never commit it
MOONVEX_SECRET_KEY=sk_live_...
MOONVEX_WEBHOOK_SECRET=whsec_...
DATABASE_URL=postgres://user:pass@localhost:5432/shop
```

## 2. Create a payment with the SDK

payments.create takes orderId, the amount as a string, currency and network. The second argument is idempotencyKey: a retry after a timeout returns the same payment instead of creating another one. The SDK itself retries network errors, 429 and 5xx with the same key. Errors are thrown as MoonvexError with status, code and detailsCode, for example DUPLICATE_ORDER when the order already has an active payment.

File: [`02-create-a-payment-with-the-sdk.js`](./02-create-a-payment-with-the-sdk.js)

```js
// moonvex.js
import { Moonvex, MoonvexError } from '@moonvex/node';

export const moonvex = new Moonvex({ apiKey: process.env.MOONVEX_SECRET_KEY });

/** Creates an invoice for the order; a retry with the same key returns the same payment */
export async function createPaymentForOrder(order, attempt = 1) {
  try {
    return await moonvex.payments.create(
      {
        orderId: String(order.id),
        amount: order.total, // a string such as "25.00", not a number
        currency: 'USDT',
        network: 'TRON',
        customerId: String(order.userId),
        expiresInMinutes: 30,
      },
      { idempotencyKey: 'order-' + order.id + '-' + attempt },
    );
  } catch (err) {
    if (err instanceof MoonvexError && err.detailsCode === 'DUPLICATE_ORDER') {
      // the order already has an active payment, return it
      const page = await moonvex.payments.list({ orderId: String(order.id), limit: 1 });
      if (page.data[0]) return page.data[0];
    }
    throw err;
  }
}
```

## 3. Send the customer to paymentUrl

paymentUrl is a hosted payment page: the exact amount including the fee, the address, a QR code, the official token contract and a timer, with a status that updates by itself. Open it with a redirect or in a new tab; it cannot be embedded in an iframe. A customer returning to your site is not proof of payment: mark the order paid only from a webhook or the status from GET /v1/payments/:id. Answering a POST form with 303 makes the browser open the payment page with a plain GET.

File: [`03-send-the-customer-to-paymenturl.js`](./03-send-the-customer-to-paymenturl.js)

```js
// server.js
import http from 'node:http';
import { db } from './db.js';
import { createPaymentForOrder } from './moonvex.js';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pay = url.pathname.match(/^\/orders\/(\d+)\/pay$/);

  if (req.method === 'POST' && pay) {
    const { rows } = await db.query(
      'SELECT id, user_id AS "userId", total::text AS total FROM orders WHERE id = $1',
      [pay[1]],
    );
    if (!rows[0]) return res.writeHead(404).end();
    const payment = await createPaymentForOrder(rows[0]);
    // 303 makes the browser open the payment page with a GET
    return res.writeHead(303, { Location: payment.paymentUrl }).end();
  }

  if (req.method === 'POST' && url.pathname === '/moonvex/webhook') {
    return handleWebhook(req, res); // step 4
  }

  res.writeHead(404).end();
});

server.listen(3000);
```

## 4. Receive the webhook and verify the signature

Moonvex sends a POST with a Moonvex-Signature header: t=<unix time>,v1=<signature>. The signature is a hex HMAC-SHA256 of the string “t.raw_body” keyed with the webhook secret. Compute it over the body bytes before parsing JSON, compare in constant time and reject events older than 5 minutes. For 24 hours after a secret rotation the header carries two v1 values; either one is valid. verifyWebhook from the SDK does all of this and throws WebhookVerificationError when something is off. It needs the raw body as a Buffer, not an object.

File: [`04-receive-the-webhook-and-verify-the.js`](./04-receive-the-webhook-and-verify-the.js)

```js
// server.js (continued)
import { verifyWebhook, WebhookVerificationError } from '@moonvex/node';
import { markOrderPaidOnce } from './db.js';

/** Raw request body: the signature covers the bytes, not parsed JSON */
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function handleWebhook(req, res) {
  const raw = await readRawBody(req);
  let event;
  try {
    // checks HMAC-SHA256, both v1 values during a secret rotation and the event age (5 minutes)
    event = verifyWebhook(raw, req.headers['moonvex-signature'], process.env.MOONVEX_WEBHOOK_SECRET);
  } catch (err) {
    if (err instanceof WebhookVerificationError) return res.writeHead(400).end('bad signature');
    throw err;
  }

  if (event.type === 'payment.confirmed' || event.type === 'payment.overpaid') {
    await markOrderPaidOnce(event.id, event.data.orderId);
  }
  // any 2xx within 10 seconds, otherwise Moonvex retries the delivery
  res.writeHead(200).end('ok');
}
```

## 5. Mark the order paid exactly once

A redelivered event keeps the same id, so store it in a table with a unique key in the same transaction as the order update: a duplicate then changes nothing. Fulfil on payment.confirmed and payment.overpaid, never on payment.detected. Respond with a 2xx within 10 seconds; on failure (5xx, timeout) Moonvex retries the delivery for about three days.

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

- Pass the original Buffer to verifyWebhook. JSON.stringify(JSON.parse(body)) produces different bytes and the signature will not match.
- Build idempotencyKey from the order number and attempt (order-1001-1) rather than a random UUID, so a retry after a process restart is safe too.
- Amounts are strings. Read total from PostgreSQL as numeric::text instead of Number(): floats lose cents.
- Do slow work (emails, granting access) after responding 200, in a queue. A response slower than 10 seconds counts as a failed delivery.

## FAQ

**Do I need the SDK, or is fetch enough?**

You can skip the SDK: the API is plain HTTPS with JSON and an Authorization: Bearer header. The SDK adds TypeScript types, retries with the same Idempotency-Key and a ready-made verifyWebhook. See the Express guide for a version without the SDK.

**Is there a test mode or a sandbox?**

No, there is no test network: Moonvex runs on mainnets only. Check the signature with the “Send test” button (a webhook.test event) and the whole payment flow with a real payment of a small amount, for example 1 USDT on TRON.

**What if the customer does not pay in time?**

The payment moves to EXPIRED and you receive payment.expired. You can create a new payment for the same orderId with a new Idempotency-Key (for example, bump the attempt number at the end of the key). The payment window is set with expiresInMinutes: 5 to 1440 minutes, 30 by default.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=nodejs
