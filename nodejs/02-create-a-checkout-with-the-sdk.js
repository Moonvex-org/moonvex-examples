// moonvex.js
import { Moonvex, MoonvexError } from '@moonvex/node';

export const moonvex = new Moonvex({ apiKey: process.env.MOONVEX_SECRET_KEY });

/** Creates a checkout for the order; a retry with the same key returns the same checkout */
export async function createCheckoutForOrder(order, attempt = 1) {
  try {
    return await moonvex.checkouts.create(
      {
        orderId: String(order.id),
        amount: order.total, // a string such as "25.00", not a number
        currency: 'USD', // the customer picks the coin and network on the checkout page
        description: 'Order #' + order.id + ': ' + order.itemCount + ' items', // “You are paying for”
        returnUrl: 'https://shop.example.com/orders/' + order.id, // the Back buttons
        customerId: String(order.userId),
        expiresInMinutes: 30,
      },
      { idempotencyKey: 'order-' + order.id + '-' + attempt },
    );
  } catch (err) {
    if (err instanceof MoonvexError && err.detailsCode === 'DUPLICATE_ORDER') {
      // the customer has already started a payment for this order, return it (it has a paymentUrl too)
      const page = await moonvex.payments.list({ orderId: String(order.id), limit: 1 });
      if (page.data[0]) return page.data[0];
    }
    throw err;
  }
}
