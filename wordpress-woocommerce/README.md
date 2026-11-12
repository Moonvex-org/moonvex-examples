# Crypto payments in WordPress and WooCommerce via API

There is no ready-made Moonvex plugin for WordPress or WooCommerce yet, so the integration is your own code on top of the API. Below is a small custom plugin: a WooCommerce payment method that creates a payment and sends the customer to the payment page, plus a REST route for the webhook with signature verification.

Full guide with explanations: https://moonvex.org/en/guides/wordpress-woocommerce?utm_source=github&utm_medium=repo&utm_campaign=wordpress-woocommerce

## 1. Get an API key and a webhook secret

In the Moonvex dashboard go to “Integration” → “Create key” → type “Secret” (sk_live_…). The key is shown only once: store it on your server as MOONVEX_SECRET_KEY. On the same page add a webhook pointing to an https URL on your server and store its signing secret as MOONVEX_WEBHOOK_SECRET. In WordPress define them as constants in wp-config.php, not as plugin settings stored in the database.

File: [`01-get-an-api-key-and-a-webhook-secret.php`](./01-get-an-api-key-and-a-webhook-secret.php)

```php
// wp-config.php — keys outside the database and outside the theme repository
define('MOONVEX_SECRET_KEY', 'sk_live_...');
define('MOONVEX_WEBHOOK_SECRET', 'whsec_...');
```

## 2. Add a WooCommerce payment method

WC_Gateway_Moonvex extends WC_Payment_Gateway. Its process_payment creates the payment with wp_remote_post and returns a redirect to paymentUrl. A USD price is sent as currency: USD with asset: USDT as the coin to pay with. The attempt number lives in order meta and only grows after a successful create.

File: [`02-add-a-woocommerce-payment-method.php`](./02-add-a-woocommerce-payment-method.php)

```php
<?php
/**
 * Plugin Name: Moonvex Crypto Payments (custom)
 * Description: Your own WooCommerce integration with the Moonvex API
 */
// wp-content/plugins/moonvex-custom/moonvex-custom.php

add_action('plugins_loaded', function () {
    if (!class_exists('WC_Payment_Gateway')) {
        return;
    }

    class WC_Gateway_Moonvex extends WC_Payment_Gateway
    {
        public function __construct()
        {
            $this->id = 'moonvex';
            $this->method_title = 'Moonvex';
            $this->method_description = 'Pay in USDT on the Moonvex payment page';
            $this->has_fields = false;
            $this->init_form_fields();
            $this->init_settings();
            $this->title = $this->get_option('title', 'Crypto (USDT)');
            add_action('woocommerce_update_options_payment_gateways_' . $this->id, [$this, 'process_admin_options']);
        }

        public function process_payment($order_id)
        {
            $order = wc_get_order($order_id);
            if ($order->get_currency() !== 'USD') {
                wc_add_notice('Crypto payment is available for prices in USD', 'error');
                return ['result' => 'failure'];
            }

            // the attempt number grows only after a successful create, so a retry after a timeout is idempotent
            $attempt = (int) $order->get_meta('_moonvex_attempts') + 1;
            $res = wp_remote_post('https://api.moonvex.org/v1/payments', [
                'timeout' => 15,
                'headers' => [
                    'Authorization' => 'Bearer ' . MOONVEX_SECRET_KEY,
                    'Idempotency-Key' => 'wc-order-' . $order->get_id() . '-' . $attempt,
                    'Content-Type' => 'application/json',
                ],
                'body' => wp_json_encode([
                    'orderId' => (string) $order->get_id(),
                    'amount' => wc_format_decimal($order->get_total(), 2),
                    'currency' => 'USD',
                    'asset' => 'USDT',
                    'network' => 'TRON',
                    'customerEmail' => $order->get_billing_email(),
                ]),
            ]);

            $payment = is_wp_error($res) ? null : json_decode(wp_remote_retrieve_body($res), true);
            if (!$payment || empty($payment['paymentUrl'])) {
                wc_add_notice('Could not create the payment, please try again', 'error');
                return ['result' => 'failure'];
            }

            $order->update_meta_data('_moonvex_attempts', $attempt);
            $order->update_meta_data('_moonvex_payment_id', $payment['id']);
            $order->update_status('pending', 'Moonvex: ' . $payment['id']);
            $order->save();

            return ['result' => 'success', 'redirect' => $payment['paymentUrl']];
        }
    }

    add_filter('woocommerce_payment_gateways', function ($gateways) {
        $gateways[] = 'WC_Gateway_Moonvex';
        return $gateways;
    });
});
```

## 3. Send the customer to paymentUrl

paymentUrl is a hosted payment page: the exact amount including the fee, the address, a QR code, the official token contract and a timer, with a status that updates by itself. Open it with a redirect or in a new tab; it cannot be embedded in an iframe. A customer returning to your site is not proof of payment: mark the order paid only from a webhook or the status from GET /v1/payments/:id. WooCommerce redirects the buyer itself using the redirect returned by process_payment.

## 4. Receive the webhook and verify the signature

Moonvex sends a POST with a Moonvex-Signature header: t=<unix time>,v1=<signature>. The signature is a hex HMAC-SHA256 of the string “t.raw_body” keyed with the webhook secret. Compute it over the body bytes before parsing JSON, compare in constant time and reject events older than 5 minutes. For 24 hours after a secret rotation the header carries two v1 values; either one is valid. The route is registered with register_rest_route; the URL for the dashboard is /wp-json/moonvex/v1/webhook. The raw body is $request->get_body().

File: [`04-receive-the-webhook-and-verify-the.php`](./04-receive-the-webhook-and-verify-the.php)

```php
// moonvex-custom.php (continued)
// URL for the Moonvex dashboard: https://shop.example.com/wp-json/moonvex/v1/webhook
add_action('rest_api_init', function () {
    register_rest_route('moonvex/v1', '/webhook', [
        'methods' => 'POST',
        'permission_callback' => '__return_true', // access is checked by the signature
        'callback' => function (WP_REST_Request $request) {
            $raw = $request->get_body(); // raw body
            if (!moonvex_verify($raw, (string) $request->get_header('Moonvex-Signature'), MOONVEX_WEBHOOK_SECRET)) {
                return new WP_REST_Response('bad signature', 400);
            }
            moonvex_handle_event(json_decode($raw, true));
            return new WP_REST_Response('ok', 200);
        },
    ]);
});

function moonvex_verify(string $raw, string $header, string $secret, int $tolerance = 300): bool
{
    $t = null;
    $sigs = [];
    foreach (explode(',', $header) as $part) {
        [$k, $v] = array_pad(explode('=', $part, 2), 2, '');
        if ($k === 't' && ctype_digit($v)) { $t = (int) $v; }
        if ($k === 'v1') { $sigs[] = $v; }
    }
    if (!$t || abs(time() - $t) > $tolerance) {
        return false;
    }
    $expected = hash_hmac('sha256', $t . '.' . $raw, $secret);
    foreach ($sigs as $s) {
        if (hash_equals($expected, $s)) {
            return true;
        }
    }
    return false;
}
```

## 5. Mark the order paid exactly once

A redelivered event keeps the same id, so store it in a table with a unique key in the same transaction as the order update: a duplicate then changes nothing. Fulfil on payment.confirmed and payment.overpaid, never on payment.detected. In the example the event id is stored in order meta, and payment_complete() runs only when !$order->is_paid(). On payment.expired the order moves to Failed.

File: [`05-mark-the-order-paid-exactly-once.php`](./05-mark-the-order-paid-exactly-once.php)

```php
// moonvex-custom.php (continued)
function moonvex_handle_event(array $event): void
{
    $order = wc_get_order((int) ($event['data']['orderId'] ?? 0));
    if (!$order || $order->get_payment_method() !== 'moonvex') {
        return;
    }
    $seen = '_moonvex_event_' . $event['id'];
    if ($order->get_meta($seen)) {
        return; // this event was already processed
    }

    switch ($event['type']) {
        case 'payment.confirmed':
        case 'payment.overpaid':
            if (!$order->is_paid()) {
                $order->payment_complete($event['data']['id']); // pay_… becomes the order transaction id
            }
            break;
        case 'payment.expired':
            if (!$order->is_paid()) {
                $order->update_status('failed', 'Moonvex: payment expired');
            }
            break;
    }

    $order->update_meta_data($seen, time());
    $order->save();
}
```

## 6. Test the integration

Moonvex has no test network: everything runs on mainnets. The “Send test” button under “Integration” sends a webhook.test event, which is how you check the signature. Then pay a small invoice, for example 1 USDT on TRON: it is a regular payment and the money lands on your balance. The delivery log with response codes and a “Retry” button is on the same page. Enable the payment method under WooCommerce → Settings → Payments.

## Pitfalls

- There is no ready-made Moonvex plugin for WooCommerce yet: the code in this guide is yours, so keep it updated along with your store.
- The block-based Checkout only lists gateways that have a blocks integration. Use the classic [woocommerce_checkout] shortcode with this code, or add a registration through AbstractPaymentMethodType.
- The store currency must be USD (or a coin): Moonvex accepts prices in USD or crypto, so other fiat currencies need converting on your side.
- Security and caching plugins sometimes lock down /wp-json/. Make sure the moonvex/v1/webhook route accepts POST.

## FAQ

**Is there a ready-made Moonvex plugin for WordPress?**

Not yet. You connect through the API as in this guide, with about a hundred lines of PHP in your own plugin. If you would rather not write code, you can issue invoices manually from the Moonvex dashboard.

**The buyer came back to the site but the order is unpaid. Why?**

Returning to the site does not confirm payment. The order becomes paid when the payment.confirmed webhook arrives, after the required number of network confirmations. Check the delivery log under “Integration”.

**Why is amount in the response higher than the order price?**

The customer pays the Moonvex fee on top, so amount is the total due. Your price stays in pricing.amount, and what you receive on a full payment is in merchantAmount. Reconcile orders by orderId and pricing.amount, and show the customer amount.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=wordpress-woocommerce
