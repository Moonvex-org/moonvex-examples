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
