# Embedded checkout: the customer pays inside your page

For games, casinos, balance top-ups and any app where leaving the page breaks the flow. No redirect to Moonvex: your page shows the coin choice, exact amount, address and QR code.

```bash
npm install
MOONVEX_SECRET_KEY=sk_live_... npm start   # http://localhost:3000
```

## Flow

1. `POST /v1/payments` **without** `network` → a checkout `inv_…`.
2. `GET /v1/checkouts/{id}` → `options`: every coin/network the customer can use, with the exact amount in each.
3. The customer picks one in your UI → `POST /v1/checkouts/{id}/select` `{ "asset": "USDT", "network": "TRON" }` → the payment:
   `address`, `amount`, `qr.imageUrl` (SVG) / `qr.pngUrl` (PNG 512 px) / `qr.data`, `paymentUrl`, `receiptUrl`, `receiptPdfUrl`, `provider`.
4. Credit the balance only on the signed `payment.confirmed` webhook (see [../express](../express)). Polling `GET /v1/payments/{id}` is for the UI.

Until money arrives the customer may switch coins: another `select` cancels the untouched previous payment (`payment.cancelled`, ignore it while the checkout is open) and returns a new one. Up to 10 picks per checkout.

Already know the coin? Skip the choice: `POST /v1/payments` with `network` returns the same fields at once.

## Required on your page

Moonvex rules, section 4: next to an embedded payment show
- "Payment processed by Moonvex" with the `provider.url` link;
- the payment link `paymentUrl`;
- the receipt: the `receiptUrl` link or a PDF download button for `receiptPdfUrl`.

Node.js SDK 1.6.0+: `moonvex.checkouts.get(id)` and `moonvex.checkouts.select(id, { asset, network })`.

Docs: [moonvex.org/en/docs#embedded](https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=embedded#embedded) · [на русском](https://moonvex.org/docs#embedded)
