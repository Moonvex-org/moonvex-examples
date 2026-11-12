# Accept crypto payments in NestJS

How to accept USDT, BTC and other coins in a NestJS app: a provider wrapping the SDK, a controller that redirects to the payment page, and a webhook controller that reads req.rawBody and verifies the HMAC signature.

Full guide with explanations: https://moonvex.org/en/guides/nestjs?utm_source=github&utm_medium=repo&utm_campaign=nestjs

## 1. Get an API key and a webhook secret

In the Moonvex dashboard go to “Integration” → “Create key” → type “Secret” (sk_live_…). The key is shown only once: store it on your server as MOONVEX_SECRET_KEY. On the same page add a webhook pointing to an https URL on your server and store its signing secret as MOONVEX_WEBHOOK_SECRET. In NestJS you would normally read them through ConfigModule; the example uses process.env for brevity.

File: [`01-get-an-api-key-and-a-webhook-secret.sh`](./01-get-an-api-key-and-a-webhook-secret.sh)

```bash
npm install @moonvex/node

# .env
MOONVEX_SECRET_KEY=sk_live_...
MOONVEX_WEBHOOK_SECRET=whsec_...
```

## 2. Create a service and a payment controller

MoonvexService wraps the SDK client; the controller loads the order and creates a payment with an idempotencyKey built from the order number. @Redirect() combined with a returned { url, statusCode: 303 } sends the customer to the payment page.

File: [`02-create-a-service-and-a-payment.ts`](./02-create-a-service-and-a-payment.ts)

```ts
// moonvex.service.ts
import { Injectable } from '@nestjs/common';
import { Moonvex, type Payment } from '@moonvex/node';

@Injectable()
export class MoonvexService {
  readonly client = new Moonvex({ apiKey: process.env.MOONVEX_SECRET_KEY! });

  createPayment(orderId: string, amount: string, attempt = 1): Promise<Payment> {
    return this.client.payments.create(
      { orderId, amount, currency: 'USDT', network: 'TRON' },
      { idempotencyKey: 'order-' + orderId + '-' + attempt },
    );
  }
}

// orders.controller.ts
import { Controller, Param, Post, Redirect } from '@nestjs/common';
import { MoonvexService } from './moonvex.service';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly moonvex: MoonvexService,
  ) {}

  @Post(':id/pay')
  @Redirect()
  async pay(@Param('id') id: string) {
    const order = await this.orders.findOne(id); // your orders service; total is a string
    const payment = await this.moonvex.createPayment(String(order.id), order.total);
    return { url: payment.paymentUrl, statusCode: 303 };
  }
}
```

## 3. Send the customer to paymentUrl

paymentUrl is a hosted payment page: the exact amount including the fee, the address, a QR code, the official token contract and a timer, with a status that updates by itself. Open it with a redirect or in a new tab; it cannot be embedded in an iframe. A customer returning to your site is not proof of payment: mark the order paid only from a webhook or the status from GET /v1/payments/:id.

## 4. Receive the webhook and verify the signature

Moonvex sends a POST with a Moonvex-Signature header: t=<unix time>,v1=<signature>. The signature is a hex HMAC-SHA256 of the string “t.raw_body” keyed with the webhook secret. Compute it over the body bytes before parsing JSON, compare in constant time and reject events older than 5 minutes. For 24 hours after a secret rotation the header carries two v1 values; either one is valid. In NestJS enable rawBody: true in NestFactory.create: the original bytes then live in req.rawBody while regular JSON parsing keeps working for every other route.

File: [`04-receive-the-webhook-and-verify-the.ts`](./04-receive-the-webhook-and-verify-the.ts)

```ts
// main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: true makes Nest keep the original bytes in req.rawBody
  const app = await NestFactory.create(AppModule, { rawBody: true });
  await app.listen(3000);
}
bootstrap();

// moonvex-webhook.controller.ts
import { BadRequestException, Controller, Headers, HttpCode, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { verifyWebhook, type Payment, type WebhookEvent } from '@moonvex/node';
import { OrdersService } from './orders.service';

@Controller('moonvex')
export class MoonvexWebhookController {
  constructor(private readonly orders: OrdersService) {}

  @Post('webhook')
  @HttpCode(200)
  async handle(@Req() req: RawBodyRequest<Request>, @Headers('moonvex-signature') signature?: string) {
    let event: WebhookEvent<Payment>;
    try {
      event = verifyWebhook<Payment>(req.rawBody!, signature, process.env.MOONVEX_WEBHOOK_SECRET!);
    } catch {
      throw new BadRequestException('bad signature');
    }
    if (event.type === 'payment.confirmed' || event.type === 'payment.overpaid') {
      await this.orders.markPaidOnce(event.id, event.data.orderId!);
    }
    return { received: true };
  }
}
```

## 5. Mark the order paid exactly once

A redelivered event keeps the same id, so store it in a table with a unique key in the same transaction as the order update: a duplicate then changes nothing. Fulfil on payment.confirmed and payment.overpaid, never on payment.detected. The example uses a TypeORM transaction: INSERT … ON CONFLICT DO NOTHING RETURNING plus the order update. With Prisma, do the same with $transaction and a unique key.

File: [`05-mark-the-order-paid-exactly-once.ts`](./05-mark-the-order-paid-exactly-once.ts)

```ts
// orders.service.ts
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class OrdersService {
  constructor(private readonly dataSource: DataSource) {}

  // CREATE TABLE processed_events (event_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
  async markPaidOnce(eventId: string, orderId: string): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const fresh: unknown[] = await m.query(
        'INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id',
        [eventId],
      );
      if (fresh.length === 0) return; // event already processed
      await m.query(
        "UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1 AND status <> 'paid'",
        [orderId],
      );
    });
  }
}
```

## 6. Test the integration

Moonvex has no test network: everything runs on mainnets. The “Send test” button under “Integration” sends a webhook.test event, which is how you check the signature. Then pay a small invoice, for example 1 USDT on TRON: it is a regular payment and the money lands on your balance. The delivery log with response codes and a “Retry” button is on the same page.

## Pitfalls

- Without rawBody: true, req.rawBody is undefined and @Body() only holds the parsed object, which cannot be used to verify the signature.
- If you have a global AuthGuard, mark the webhook controller as public (for example with your own @Public() decorator): Moonvex does not send your JWT.
- Nest answers POST with 201 by default. That is still a successful 2xx, but @HttpCode(200) makes the response explicit.
- The WebhookEvent<Payment> type from the SDK gives you autocompletion on event.data: orderId, status, amount, pricing.

## FAQ

**Can I verify the signature in a Guard or an Interceptor?**

Yes. The logic is the same: take req.rawBody and the moonvex-signature header and call verifyWebhook. A Guard is handy if you have several webhook routes.

**What if the customer does not pay in time?**

The payment moves to EXPIRED and you receive payment.expired. You can create a new payment for the same orderId with a new Idempotency-Key (for example, bump the attempt number at the end of the key). The payment window is set with expiresInMinutes: 5 to 1440 minutes, 30 by default.

**Is there a test mode or a sandbox?**

No, there is no test network: Moonvex runs on mainnets only. Check the signature with the “Send test” button (a webhook.test event) and the whole payment flow with a real payment of a small amount, for example 1 USDT on TRON.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=nestjs
