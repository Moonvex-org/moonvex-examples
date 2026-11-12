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
