// app/api/moonvex/webhook/route.ts
import { verifyWebhook, type Payment, type WebhookEvent } from '@moonvex/node';
import { markOrderPaidOnce } from '@/lib/orders';

export const runtime = 'nodejs'; // needs node:crypto, not Edge
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // read the bytes as is, not req.json()
  const raw = Buffer.from(await req.arrayBuffer());
  let event: WebhookEvent<Payment>;
  try {
    event = verifyWebhook<Payment>(raw, req.headers.get('moonvex-signature'), process.env.MOONVEX_WEBHOOK_SECRET!);
  } catch {
    return new Response('bad signature', { status: 400 });
  }

  if (event.type === 'payment.confirmed' || event.type === 'payment.overpaid') {
    await markOrderPaidOnce(event.id, event.data.orderId!);
  }
  // payment.cancelled also arrives when the customer switches coins: do not cancel the order on it
  return new Response('ok');
}
