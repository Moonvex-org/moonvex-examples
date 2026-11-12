# Accept crypto payments in Next.js

A Moonvex integration for Next.js (App Router): a server Route Handler creates the payment and redirects to the payment page, and a second Route Handler receives the webhook, verifies the signature and marks the order paid.

Full guide with explanations: https://moonvex.org/en/guides/nextjs?utm_source=github&utm_medium=repo&utm_campaign=nextjs

## 1. Get an API key and a webhook secret

In the Moonvex dashboard go to “Integration” → “Create key” → type “Secret” (sk_live_…). The key is shown only once: store it on your server as MOONVEX_SECRET_KEY. On the same page add a webhook pointing to an https URL on your server and store its signing secret as MOONVEX_WEBHOOK_SECRET. In Next.js never prefix these names with NEXT_PUBLIC_, or the key ends up in the browser.

File: [`01-get-an-api-key-and-a-webhook-secret.sh`](./01-get-an-api-key-and-a-webhook-secret.sh)

```bash
npm install @moonvex/node pg

# .env — server only, never commit it
MOONVEX_SECRET_KEY=sk_live_...
MOONVEX_WEBHOOK_SECRET=whsec_...
DATABASE_URL=postgres://user:pass@localhost:5432/shop
```

## 2. Create a payment in a Route Handler

The POST handler in app/orders/[id]/pay/route.ts loads the order from the database and calls moonvex.payments.create. The API key stays on the server; the client component just submits a form with method="post".

File: [`02-create-a-payment-in-a-route-handler.ts`](./02-create-a-payment-in-a-route-handler.ts)

```ts
// lib/moonvex.ts
import { Moonvex } from '@moonvex/node';

export const moonvex = new Moonvex({ apiKey: process.env.MOONVEX_SECRET_KEY! });

// app/orders/[id]/pay/route.ts
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { moonvex } from '@/lib/moonvex';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { rows } = await db.query('SELECT id, total::text AS total FROM orders WHERE id = $1', [id]);
  const order = rows[0];
  if (!order) return new Response('not found', { status: 404 });

  const payment = await moonvex.payments.create(
    { orderId: String(order.id), amount: order.total, currency: 'USDT', network: 'TRON' },
    { idempotencyKey: 'order-' + order.id + '-1' },
  );
  // a method="post" form → 303 to the payment page
  return NextResponse.redirect(payment.paymentUrl, 303);
}
```

## 3. Send the customer to paymentUrl

paymentUrl is a hosted payment page: the exact amount including the fee, the address, a QR code, the official token contract and a timer, with a status that updates by itself. Open it with a redirect or in a new tab; it cannot be embedded in an iframe. A customer returning to your site is not proof of payment: mark the order paid only from a webhook or the status from GET /v1/payments/:id. NextResponse.redirect(url, 303) after the form opens the payment page.

## 4. Receive the webhook and verify the signature

Moonvex sends a POST with a Moonvex-Signature header: t=<unix time>,v1=<signature>. The signature is a hex HMAC-SHA256 of the string “t.raw_body” keyed with the webhook secret. Compute it over the body bytes before parsing JSON, compare in constant time and reject events older than 5 minutes. For 24 hours after a secret rotation the header carries two v1 values; either one is valid. In a Route Handler read the body with await req.arrayBuffer(): those are the original bytes. Do not call req.json() before verifying. Set runtime = 'nodejs', since verifyWebhook relies on node:crypto.

File: [`04-receive-the-webhook-and-verify-the.ts`](./04-receive-the-webhook-and-verify-the.ts)

```ts
// app/api/moonvex/webhook/route.ts
import { verifyWebhook, type Payment, type WebhookEvent } from '@moonvex/node';
import { markOrderPaidOnce } from '@/lib/orders';

export const runtime = 'nodejs'; // needs node:crypto, not Edge
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // read the bytes as is, not req.json()
  const raw = Buffer.from(await req.arrayBuffer());
  let event: WebhookEvent<Payment>;
  try {
    event = verifyWebhook<Payment>(raw, req.headers.get('moonvex-signature'), process.env.MOONVEX_WEBHOOK_SECRET!);
  } catch {
    return new Response('bad signature', { status: 400 });
  }

  if (event.type === 'payment.confirmed' || event.type === 'payment.overpaid') {
    await markOrderPaidOnce(event.id, event.data.orderId!);
  }
  return new Response('ok');
}
```

## 5. Mark the order paid exactly once

A redelivered event keeps the same id, so store it in a table with a unique key in the same transaction as the order update: a duplicate then changes nothing. Fulfil on payment.confirmed and payment.overpaid, never on payment.detected.

File: [`05-mark-the-order-paid-exactly-once.ts`](./05-mark-the-order-paid-exactly-once.ts)

```ts
// lib/db.ts
import { Pool } from 'pg';

export const db = new Pool({ connectionString: process.env.DATABASE_URL });

// lib/orders.ts
// CREATE TABLE processed_events (event_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
import { db } from '@/lib/db';

export async function markOrderPaidOnce(eventId: string, orderId: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const fresh = await client.query(
      'INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [eventId],
    );
    if (fresh.rowCount === 1) {
      // first delivery of the event: fulfil the order
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

- Create and use the key only in server code (Route Handlers, Server Actions). Any variable prefixed with NEXT_PUBLIC_ is shipped in the client bundle.
- If middleware checks authentication, exclude /api/moonvex/webhook in its matcher, or Moonvex gets redirected to your login page.
- The Edge runtime does not work for the webhook in this example: it needs node:crypto and pg. Keep runtime = 'nodejs'.
- Do not cache the handler: dynamic = 'force-dynamic' and the POST method make sure every webhook reaches your code.

## FAQ

**Can I create the payment in a Server Action?**

Yes: call moonvex.payments.create inside a 'use server' function and redirect(payment.paymentUrl) from next/navigation. The webhook still needs its own Route Handler.

**Why is amount in the response higher than the order price?**

The customer pays the Moonvex fee on top, so amount is the total due. Your price stays in pricing.amount, and what you receive on a full payment is in merchantAmount. Reconcile orders by orderId and pricing.amount, and show the customer amount.

**Is there a test mode or a sandbox?**

No, there is no test network: Moonvex runs on mainnets only. Check the signature with the “Send test” button (a webhook.test event) and the whole payment flow with a real payment of a small amount, for example 1 USDT on TRON.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=nextjs
