// db.js
import pg from 'pg';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// CREATE TABLE processed_events (event_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());

/** true only for the first delivery of the event */
export async function claimEvent(eventId) {
  const r = await db.query('INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId]);
  return r.rowCount === 1;
}
