# app.py (continued)
# CREATE TABLE processed_events (event_id TEXT PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP);


def mark_paid_once(event_id: str, order_id: str) -> None:
    # the second "conn" is a transaction: commit on success, rollback on error
    with closing(db()) as conn, conn:
        cur = conn.execute("INSERT OR IGNORE INTO processed_events (event_id) VALUES (?)", (event_id,))
        if cur.rowcount == 1:  # first delivery of the event
            conn.execute("UPDATE orders SET status = 'paid' WHERE id = ? AND status <> 'paid'", (int(order_id),))
