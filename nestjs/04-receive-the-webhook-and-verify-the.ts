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
