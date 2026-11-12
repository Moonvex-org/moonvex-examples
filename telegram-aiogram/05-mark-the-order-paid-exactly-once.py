# bot.py (continued)
# CREATE TABLE processed_events (event_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());


async def claim_event(db: asyncpg.Pool, event_id: str) -> bool:
    """True only for the first delivery of the event"""
    fresh = await db.fetchval(
        "INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id",
        event_id,
    )
    return fresh is not None
