// OrderService.java
// CREATE TABLE processed_events (event_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
@Service
public class OrderService {
    private final JdbcTemplate jdbc;

    public OrderService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Transactional
    public void markPaidOnce(String eventId, String orderId) {
        int fresh = jdbc.update("INSERT INTO processed_events (event_id) VALUES (?) ON CONFLICT DO NOTHING", eventId);
        if (fresh == 0) return; // a redelivery
        jdbc.update("UPDATE orders SET status = 'paid' WHERE id = ? AND status <> 'paid'", Long.parseLong(orderId));
    }
}
