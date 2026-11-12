// store.go
package main

import "context"

// CREATE TABLE processed_events (event_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());

func markOrderPaidOnce(ctx context.Context, eventID, orderID string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(ctx, `INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`, eventID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 1 { // 0 means already processed
		if _, err := tx.ExecContext(ctx, `UPDATE orders SET status = 'paid' WHERE id = $1 AND status <> 'paid'`, orderID); err != nil {
			return err
		}
	}
	return tx.Commit()
}
