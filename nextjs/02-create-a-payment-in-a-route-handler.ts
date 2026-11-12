// lib/moonvex.ts
import { Moonvex } from '@moonvex/node';

export const moonvex = new Moonvex({ apiKey: process.env.MOONVEX_SECRET_KEY! });

// app/orders/[id]/pay/route.ts
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { moonvex } from '@/lib/moonvex';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { rows } = await db.query('SELECT id, total::text AS total FROM orders WHERE id = $1', [id]);
  const order = rows[0];
  if (!order) return new Response('not found', { status: 404 });

  const payment = await moonvex.payments.create(
    { orderId: String(order.id), amount: order.total, currency: 'USDT', network: 'TRON' },
    { idempotencyKey: 'order-' + order.id + '-1' },
  );
  // a method="post" form → 303 to the payment page
  return NextResponse.redirect(payment.paymentUrl, 303);
}
