<?php
// app/Http/Controllers/MoonvexWebhookController.php
namespace App\Http\Controllers;

use App\Models\Order;
use Illuminate\Http\Request;

class MoonvexWebhookController extends Controller
{
    public function __invoke(Request $request)
    {
        $raw = $request->getContent(); // the raw body, not $request->all()

        if (! $this->verify($raw, (string) $request->header('Moonvex-Signature'), config('services.moonvex.webhook_secret'))) {
            return response('bad signature', 400);
        }

        $event = json_decode($raw, true);
        if (in_array($event['type'], ['payment.confirmed', 'payment.overpaid'], true)) {
            Order::markPaidOnce($event['id'], $event['data']['orderId']);
        }
        // payment.cancelled also arrives when the customer switches coins: do not cancel the order on it

        return response('ok');
    }

    private function verify(string $raw, string $header, string $secret, int $tolerance = 300): bool
    {
        $t = null;
        $sigs = [];
        foreach (explode(',', $header) as $part) {
            [$k, $v] = array_pad(explode('=', $part, 2), 2, '');
            if ($k === 't' && ctype_digit($v)) { $t = (int) $v; }
            if ($k === 'v1') { $sigs[] = $v; }
        }
        if (! $t || abs(time() - $t) > $tolerance) {
            return false;
        }
        $expected = hash_hmac('sha256', $t . '.' . $raw, $secret);

        return collect($sigs)->contains(fn ($s) => hash_equals($expected, $s));
    }
}

// routes/web.php
Route::post('/moonvex/webhook', MoonvexWebhookController::class);

// bootstrap/app.php (Laravel 11+): webhook without a CSRF token
->withMiddleware(function (Middleware $middleware) {
    $middleware->validateCsrfTokens(except: ['moonvex/webhook']);
})
