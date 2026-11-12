<?php
// app/Models/Order.php
namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

class Order extends Model
{
    protected $fillable = ['moonvex_checkout_id', 'status'];

    protected $casts = ['total' => 'decimal:2'];

    // processed_events migration: $table->string('event_id')->primary(); $table->timestamps();
    public static function markPaidOnce(string $eventId, string $orderId): void
    {
        DB::transaction(function () use ($eventId, $orderId) {
            $fresh = DB::table('processed_events')->insertOrIgnore([
                'event_id' => $eventId,
                'created_at' => now(),
                'updated_at' => now(),
            ]);
            if ($fresh === 0) {
                return; // a redelivery
            }
            static::whereKey($orderId)->where('status', '!=', 'paid')->update(['status' => 'paid']);
        });
    }
}
