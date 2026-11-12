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
