// db.js
import pg from 'pg';

export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// CREATE TABLE processed_events (
//   event_id   text PRIMARY KEY,
//   created_at timestamptz NOT NULL DEFAULT now()
// );

/** Marks the order as paid exactly once, even if the event is delivered again */
export async function markOrderPaidOnce(eventId, orderId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const fresh = await client.query(
      'INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [eventId],
    );
    if (fresh.rowCount === 1) {
      // first delivery of this event
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
