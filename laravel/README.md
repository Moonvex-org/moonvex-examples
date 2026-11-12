# Accept crypto payments in Laravel

How to connect Moonvex to Laravel: an invokable controller creates the payment through the Http facade, and a second controller receives the webhook via $request->getContent(), verifies the signature and marks the order in a transaction.

Full guide with explanations: https://moonvex.org/en/guides/laravel?utm_source=github&utm_medium=repo&utm_campaign=laravel

## 1. Get an API key and a webhook secret

In the Moonvex dashboard go to “Integration” → “Create key” → type “Secret” (sk_live_…). The key is shown only once: store it on your server as MOONVEX_SECRET_KEY. On the same page add a webhook pointing to an https URL on your server and store its signing secret as MOONVEX_WEBHOOK_SECRET. In Laravel move them into config/services.php so config:cache keeps working.

File: [`01-get-an-api-key-and-a-webhook-secret.php`](./01-get-an-api-key-and-a-webhook-secret.php)

```php
# .env
MOONVEX_SECRET_KEY=sk_live_...
MOONVEX_WEBHOOK_SECRET=whsec_...

// config/services.php
'moonvex' => [
    'secret' => env('MOONVEX_SECRET_KEY'),
    'webhook_secret' => env('MOONVEX_WEBHOOK_SECRET'),
],
```

## 2. Create a payment with Http

Http::withToken(…)->withHeaders(['Idempotency-Key' => …])->post(…) sends JSON. The decimal:2 cast on the model returns the amount as a string. API errors show up in $response->failed() and $response->json('error.code').

File: [`02-create-a-payment-with-http.php`](./02-create-a-payment-with-http.php)

```php
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
```

## 3. Send the customer to paymentUrl

paymentUrl is a hosted payment page: the exact amount including the fee, the address, a QR code, the official token contract and a timer, with a status that updates by itself. Open it with a redirect or in a new tab; it cannot be embedded in an iframe. A customer returning to your site is not proof of payment: mark the order paid only from a webhook or the status from GET /v1/payments/:id. redirect()->away($url) is Laravel's external redirect.

## 4. Receive the webhook and verify the signature

Moonvex sends a POST with a Moonvex-Signature header: t=<unix time>,v1=<signature>. The signature is a hex HMAC-SHA256 of the string “t.raw_body” keyed with the webhook secret. Compute it over the body bytes before parsing JSON, compare in constant time and reject events older than 5 minutes. For 24 hours after a secret rotation the header carries two v1 values; either one is valid. The webhook route must be excluded from CSRF checks: in Laravel 11+ use validateCsrfTokens(except: …) in bootstrap/app.php. The raw body is $request->getContent().

File: [`04-receive-the-webhook-and-verify-the.php`](./04-receive-the-webhook-and-verify-the.php)

```php
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
```

## 5. Mark the order paid exactly once

A redelivered event keeps the same id, so store it in a table with a unique key in the same transaction as the order update: a duplicate then changes nothing. Fulfil on payment.confirmed and payment.overpaid, never on payment.detected. DB::table()->insertOrIgnore() returns the number of inserted rows: 0 means the event was already processed.

File: [`05-mark-the-order-paid-exactly-once.php`](./05-mark-the-order-paid-exactly-once.php)

```php
<?php
// app/Models/Order.php
namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

class Order extends Model
{
    protected $fillable = ['moonvex_payment_id', 'status'];

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
```

## 6. Test the integration

Moonvex has no test network: everything runs on mainnets. The “Send test” button under “Integration” sends a webhook.test event, which is how you check the signature. Then pay a small invoice, for example 1 USDT on TRON: it is a regular payment and the money lands on your balance. The delivery log with response codes and a “Retry” button is on the same page.

## Pitfalls

- Without the CSRF exclusion Laravel answers every webhook with 419. Alternatively put the route in routes/api.php, which has no CSRF.
- Never call env() outside config files: after php artisan config:cache it returns null.
- You can queue the post-webhook work (dispatch(...)->afterResponse() or a Job), but record the event_id right away.
- Do not use $request->all() for signature checks: that is parsed data and the bytes differ.

## FAQ

**Does this work in Laravel 10?**

Yes. The only difference is CSRF: in Laravel 10 and earlier add moonvex/webhook to $except in app/Http/Middleware/VerifyCsrfToken.php.

**What if the customer does not pay in time?**

The payment moves to EXPIRED and you receive payment.expired. You can create a new payment for the same orderId with a new Idempotency-Key (for example, bump the attempt number at the end of the key). The payment window is set with expiresInMinutes: 5 to 1440 minutes, 30 by default.

**Is there a test mode or a sandbox?**

No, there is no test network: Moonvex runs on mainnets only. Check the signature with the “Send test” button (a webhook.test event) and the whole payment flow with a real payment of a small amount, for example 1 USDT on TRON.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=laravel
