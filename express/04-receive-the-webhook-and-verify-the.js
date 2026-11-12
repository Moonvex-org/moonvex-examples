// server.js (continued)
import crypto from 'node:crypto';
import { markOrderPaidOnce } from './db.js';

/** true if the signature is valid and the event is at most 5 minutes old */
function verifyMoonvex(rawBody, header, secret, toleranceSec = 300) {
  const parts = (header || '').split(',').map((p) => p.split('='));
  const t = Number((parts.find(([k]) => k === 't') || [])[1]);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(t + '.').update(rawBody).digest();
  // during a secret rotation two v1 values arrive for 24 hours, either one is valid
  return parts
    .filter(([k]) => k === 'v1')
    .some(([, sig]) => {
      const got = Buffer.from(sig || '', 'hex');
      return got.length === expected.length && crypto.timingSafeEqual(got, expected);
    });
}

// express.raw BEFORE express.json: you need a Buffer with the original bytes
app.post('/moonvex/webhook', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    if (!verifyMoonvex(req.body, req.get('Moonvex-Signature'), process.env.MOONVEX_WEBHOOK_SECRET)) {
      return res.status(400).send('bad signature');
    }
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.type === 'payment.confirmed' || event.type === 'payment.overpaid') {
      await markOrderPaidOnce(event.id, event.data.orderId);
    }
    res.sendStatus(200);
  } catch (err) {
    next(err); // a 5xx makes Moonvex retry later
  }
});

// the global JSON parser goes after the webhook route
app.use(express.json());
app.listen(3000);
