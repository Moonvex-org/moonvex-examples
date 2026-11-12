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
  // payment.cancelled also arrives when the customer switches coins: do not cancel the order on it
  // any 2xx within 10 seconds, otherwise Moonvex retries the delivery
  res.writeHead(200).end('ok');
}
