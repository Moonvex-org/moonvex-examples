<?php
// app/Http/Controllers/PayController.php
namespace App\Http\Controllers;

use App\Models\Order;
use Illuminate\Support\Facades\Http;

class PayController extends Controller
{
    public function __invoke(Order $order)
    {
        abort_unless($order->user_id === auth()->id() && $order->status === 'new', 404);

        $response = Http::withToken(config('services.moonvex.secret'))
            ->withHeaders(['Idempotency-Key' => 'order-' . $order->id . '-1'])
            ->timeout(15)
            ->post('https://api.moonvex.org/v1/payments', [
                'orderId' => (string) $order->id,
                'amount' => (string) $order->total, // the decimal:2 cast gives a "25.00" string
                'currency' => 'USDT',
                'network' => 'TRON',
            ]);

        if ($response->failed()) {
            abort(502, 'Moonvex: ' . $response->json('error.code'));
        }

        $order->update(['moonvex_payment_id' => $response->json('id')]);

        return redirect()->away($response->json('paymentUrl'));
    }
}

// routes/web.php
Route::post('/orders/{order}/pay', PayController::class)->middleware('auth');
