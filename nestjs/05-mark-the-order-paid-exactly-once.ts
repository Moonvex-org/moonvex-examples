// orders.service.ts
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class OrdersService {
  constructor(private readonly dataSource: DataSource) {}

  // CREATE TABLE processed_events (event_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
  async markPaidOnce(eventId: string, orderId: string): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const fresh: unknown[] = await m.query(
        'INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id',
        [eventId],
      );
      if (fresh.length === 0) return; // event already processed
      await m.query(
        "UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1 AND status <> 'paid'",
        [orderId],
      );
    });
  }
}
