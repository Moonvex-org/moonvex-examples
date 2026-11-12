// server.js
import http from 'node:http';
import { db } from './db.js';
import { createCheckoutForOrder } from './moonvex.js';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pay = url.pathname.match(/^\/orders\/(\d+)\/pay$/);

  if (req.method === 'POST' && pay) {
    const { rows } = await db.query(
      'SELECT id, user_id AS "userId", total::text AS total, item_count AS "itemCount" FROM orders WHERE id = $1',
      [pay[1]],
    );
    if (!rows[0]) return res.writeHead(404).end();
    const checkout = await createCheckoutForOrder(rows[0]);
    // 303 makes the browser open the checkout page with a GET
    return res.writeHead(303, { Location: checkout.paymentUrl }).end();
  }

  if (req.method === 'POST' && url.pathname === '/moonvex/webhook') {
    return handleWebhook(req, res); // step 4
  }

  res.writeHead(404).end();
});

server.listen(3000);
