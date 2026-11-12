// Embedded checkout: the customer pays inside your page, no redirect to Moonvex.
// Node.js 18+, Express. Run: MOONVEX_SECRET_KEY=sk_live_... node server.js  → http://localhost:3000
import express from 'express';
import { randomUUID } from 'node:crypto';

const API = 'https://api.moonvex.org';
const KEY = process.env.MOONVEX_SECRET_KEY;
const app = express();
app.use(express.json());
app.use(express.static('public'));

async function moonvex(method, path, body, idempotencyKey) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json();
  if (!r.ok) throw Object.assign(new Error(json.error?.message ?? `HTTP ${r.status}`), { status: r.status, body: json });
  return json;
}

// 1. A checkout without a network: the customer will choose the coin in YOUR interface.
//    In a real app take the amount and user from your session, never from the browser.
app.post('/api/deposit', async (req, res, next) => {
  try {
    const orderId = `dep-${randomUUID()}`;
    const checkout = await moonvex('POST', '/v1/payments', { orderId, amount: '50', currency: 'USD', description: 'Balance top-up' }, orderId);
    // 2. Coins and networks to offer, with the exact amount in each
    const details = await moonvex('GET', `/v1/checkouts/${checkout.id}`);
    res.json({ checkoutId: checkout.id, options: details.options, expiresAt: details.expiresAt });
  } catch (e) { next(e); }
});

// 3. The customer picked a coin: get the address, amount, QR and the links you must show
app.post('/api/deposit/:id/select', async (req, res, next) => {
  try {
    const { asset, network } = req.body;
    const p = await moonvex('POST', `/v1/checkouts/${encodeURIComponent(req.params.id)}/select`, { asset, network });
    res.json({
      id: p.id, status: p.status, asset: p.asset, networkName: p.network, tokenStandard: p.tokenStandard,
      amount: p.amount, address: p.address, qr: p.qr, expiresAt: p.expiresAt,
      paymentUrl: p.paymentUrl, receiptUrl: p.receiptUrl, receiptPdfUrl: p.receiptPdfUrl, provider: p.provider,
    });
  } catch (e) { next(e); }
});

// 4. Status for the page (credit the balance only from the signed webhook, see ../express)
app.get('/api/payment/:id', async (req, res, next) => {
  try {
    const p = await moonvex('GET', `/v1/payments/${encodeURIComponent(req.params.id)}`);
    res.json({ status: p.status, receivedAmount: p.receivedAmount, confirmations: p.confirmations, requiredConfirmations: p.requiredConfirmations });
  } catch (e) { next(e); }
});

app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.body?.error ?? { message: err.message } }));
app.listen(3000, () => console.log('http://localhost:3000'));
