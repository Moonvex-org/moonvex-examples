// OrderPayments.cs (EF Core 7+, PostgreSQL)
// CREATE TABLE processed_events (event_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
using Microsoft.EntityFrameworkCore;

static class OrderPayments
{
    public static async Task MarkPaidOnceAsync(AppDb db, string eventId, long orderId)
    {
        await using var tx = await db.Database.BeginTransactionAsync();
        // EF Core turns interpolated values into SQL parameters, not text
        var fresh = await db.Database.ExecuteSqlAsync(
            $"INSERT INTO processed_events (event_id) VALUES ({eventId}) ON CONFLICT DO NOTHING");
        if (fresh == 1)
        {
            await db.Orders
                .Where(o => o.Id == orderId && o.Status != "paid")
                .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, "paid"));
        }
        await tx.CommitAsync();
    }
}
