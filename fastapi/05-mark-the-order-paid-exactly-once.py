# main.py (continued)
# CREATE TABLE processed_events (event_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());


async def mark_paid_once(db: asyncpg.Pool, event_id: str, order_id: str) -> None:
    async with db.acquire() as conn, conn.transaction():
        fresh = await conn.fetchval(
            "INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id",
            event_id,
        )
        if fresh is None:
            return  # event already processed
        await conn.execute("UPDATE orders SET status = 'paid' WHERE id = $1 AND status <> 'paid'", int(order_id))
