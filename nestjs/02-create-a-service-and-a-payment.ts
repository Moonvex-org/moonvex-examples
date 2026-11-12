// moonvex.service.ts
import { Injectable } from '@nestjs/common';
import { Moonvex, type Checkout } from '@moonvex/node';

@Injectable()
export class MoonvexService {
  readonly client = new Moonvex({ apiKey: process.env.MOONVEX_SECRET_KEY! });

  createCheckout(orderId: string, amount: string, attempt = 1): Promise<Checkout> {
    return this.client.checkouts.create(
      {
        orderId,
        amount,
        currency: 'USD', // the customer picks the coin and network on the checkout page
        description: 'Order #' + orderId, // shown as “You are paying for”
        returnUrl: 'https://shop.example.com/orders/' + orderId, // the Back buttons
      },
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
    const checkout = await this.moonvex.createCheckout(String(order.id), order.total);
    return { url: checkout.paymentUrl, statusCode: 303 };
  }
}
