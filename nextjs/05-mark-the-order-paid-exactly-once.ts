// lib/db.ts
import { Pool } from 'pg';

export const db = new Pool({ connectionString: process.env.DATABASE_URL });

// lib/orders.ts
// CREATE TABLE processed_events (event_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
import { db } from '@/lib/db';

export async function markOrderPaidOnce(eventId: string, orderId: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const fresh = await client.query(
      'INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [eventId],
    );
    if (fresh.rowCount === 1) {
      // first delivery of the event: fulfil the order
      await client.query(
        "UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1 AND status <> 'paid'",
        [orderId],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
