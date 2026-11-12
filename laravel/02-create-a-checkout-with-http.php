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
                'currency' => 'USD', // no network: the customer picks the coin on the checkout page
                'description' => 'Order #' . $order->id, // shown as “You are paying for”
                'returnUrl' => route('orders.show', $order), // the Back buttons, https only
            ]);

        if ($response->failed()) {
            abort(502, 'Moonvex: ' . $response->json('error.code'));
        }

        $order->update(['moonvex_checkout_id' => $response->json('id')]); // inv_…

        return redirect()->away($response->json('paymentUrl'));
    }
}

// routes/web.php
Route::post('/orders/{order}/pay', PayController::class)->middleware('auth');
Route::get('/orders/{order}', [OrderController::class, 'show'])->name('orders.show');
