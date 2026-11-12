# Accept crypto payments in PHP

A Moonvex integration in plain PHP: cURL creates the payment, the customer pays on a hosted page, and the webhook reads php://input, verifies the hash_hmac signature and marks the order in MySQL exactly once.

Full guide with explanations: https://moonvex.org/en/guides/php?utm_source=github&utm_medium=repo&utm_campaign=php

## 1. Get an API key and a webhook secret

In the Moonvex dashboard go to “Integration” → “Create key” → type “Secret” (sk_live_…). The key is shown only once: store it on your server as MOONVEX_SECRET_KEY. On the same page add a webhook pointing to an https URL on your server and store its signing secret as MOONVEX_WEBHOOK_SECRET.

File: [`01-get-an-api-key-and-a-webhook-secret.sh`](./01-get-an-api-key-and-a-webhook-secret.sh)

```bash
# web server environment variables (php-fpm: env[...] in the pool)
MOONVEX_SECRET_KEY=sk_live_...
MOONVEX_WEBHOOK_SECRET=whsec_...
```

## 2. Create a payment with cURL

POST /v1/payments with Authorization: Bearer, Idempotency-Key and a JSON body. A DECIMAL column already comes back from PDO as a string, so pass it as is. Always set CURLOPT_TIMEOUT.

File: [`02-create-a-payment-with-curl.php`](./02-create-a-payment-with-curl.php)

```php
<?php
// pay.php
$pdo = new PDO(getenv('DB_DSN'), getenv('DB_USER'), getenv('DB_PASS'), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

$stmt = $pdo->prepare('SELECT id, total FROM orders WHERE id = ?');
$stmt->execute([(int) ($_POST['order_id'] ?? 0)]);
$order = $stmt->fetch(PDO::FETCH_ASSOC);
if (!$order) { http_response_code(404); exit; }

$ch = curl_init('https://api.moonvex.org/v1/payments');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_TIMEOUT => 15,
  CURLOPT_HTTPHEADER => [
    'Authorization: Bearer ' . getenv('MOONVEX_SECRET_KEY'),
    'Idempotency-Key: order-' . $order['id'] . '-1',
    'Content-Type: application/json',
  ],
  CURLOPT_POSTFIELDS => json_encode([
    'orderId' => (string) $order['id'],
    'amount' => (string) $order['total'], // DECIMAL from PDO is already a "25.00" string
    'currency' => 'USDT',
    'network' => 'TRON',
  ]),
]);
$payment = json_decode(curl_exec($ch), true);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
if ($status >= 400 || !$payment) {
  http_response_code(502);
  exit('Moonvex: ' . ($payment['error']['code'] ?? 'network error'));
}

header('Location: ' . $payment['paymentUrl'], true, 303);
```

## 3. Send the customer to paymentUrl

paymentUrl is a hosted payment page: the exact amount including the fee, the address, a QR code, the official token contract and a timer, with a status that updates by itself. Open it with a redirect or in a new tab; it cannot be embedded in an iframe. A customer returning to your site is not proof of payment: mark the order paid only from a webhook or the status from GET /v1/payments/:id. In PHP: header('Location: …', true, 303).

## 4. Receive the webhook and verify the signature

Moonvex sends a POST with a Moonvex-Signature header: t=<unix time>,v1=<signature>. The signature is a hex HMAC-SHA256 of the string “t.raw_body” keyed with the webhook secret. Compute it over the body bytes before parsing JSON, compare in constant time and reject events older than 5 minutes. For 24 hours after a secret rotation the header carries two v1 values; either one is valid. The raw body is file_get_contents('php://input') and the header is $_SERVER['HTTP_MOONVEX_SIGNATURE']. Compare with hash_equals only.

File: [`04-receive-the-webhook-and-verify-the.php`](./04-receive-the-webhook-and-verify-the.php)

```php
<?php
// webhook.php
require __DIR__ . '/orders.php'; // mark_paid_once() — step 5

function moonvex_verify(string $raw, string $header, string $secret, int $tolerance = 300): bool {
  $t = null; $sigs = [];
  foreach (explode(',', $header) as $part) {
    [$k, $v] = array_pad(explode('=', $part, 2), 2, '');
    if ($k === 't' && ctype_digit($v)) { $t = (int) $v; }
    if ($k === 'v1') { $sigs[] = $v; }
  }
  if (!$t || abs(time() - $t) > $tolerance) { return false; }
  $expected = hash_hmac('sha256', $t . '.' . $raw, $secret);
  foreach ($sigs as $s) {
    if (hash_equals($expected, $s)) { return true; } // constant-time comparison
  }
  return false;
}

$raw = file_get_contents('php://input'); // raw body, not $_POST
if (!moonvex_verify($raw, $_SERVER['HTTP_MOONVEX_SIGNATURE'] ?? '', getenv('MOONVEX_WEBHOOK_SECRET'))) {
  http_response_code(400);
  exit('bad signature');
}

$event = json_decode($raw, true);
if (in_array($event['type'], ['payment.confirmed', 'payment.overpaid'], true)) {
  mark_paid_once($event['id'], $event['data']['orderId']);
}
http_response_code(200);
echo 'ok';
```

## 5. Mark the order paid exactly once

A redelivered event keeps the same id, so store it in a table with a unique key in the same transaction as the order update: a duplicate then changes nothing. Fulfil on payment.confirmed and payment.overpaid, never on payment.detected. In MySQL INSERT IGNORE is convenient: rowCount() returns 0 if the event was seen before.

File: [`05-mark-the-order-paid-exactly-once.php`](./05-mark-the-order-paid-exactly-once.php)

```php
<?php
// orders.php (MySQL)
// CREATE TABLE processed_events (event_id VARCHAR(64) PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);

function mark_paid_once(string $eventId, string $orderId): void {
  $pdo = new PDO(getenv('DB_DSN'), getenv('DB_USER'), getenv('DB_PASS'), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
  $pdo->beginTransaction();
  try {
    $ins = $pdo->prepare('INSERT IGNORE INTO processed_events (event_id) VALUES (?)');
    $ins->execute([$eventId]);
    if ($ins->rowCount() === 1) { // 0 means the event was seen before
      $pdo->prepare("UPDATE orders SET status = 'paid' WHERE id = ? AND status <> 'paid'")->execute([(int) $orderId]);
    }
    $pdo->commit();
  } catch (Throwable $e) {
    $pdo->rollBack();
    throw $e;
  }
}
```

## 6. Test the integration

Moonvex has no test network: everything runs on mainnets. The “Send test” button under “Integration” sends a webhook.test event, which is how you check the signature. Then pay a small invoice, for example 1 USDT on TRON: it is a regular payment and the money lands on your balance. The delivery log with response codes and a “Retry” button is on the same page.

## Pitfalls

- $_POST is empty for application/json, so read php://input.
- Never compare signatures with == or ===: hash_equals runs in constant time.
- Do not cast amounts to float: use (string) on a DECIMAL, or number_format with a dot and no thousands separator.
- Behind nginx and php-fpm the Moonvex-Signature header is available as HTTP_MOONVEX_SIGNATURE; make sure your proxy does not strip it.

## FAQ

**Which PHP version do I need?**

The code in this guide runs on PHP 7.4+ with the curl and pdo extensions. Nothing beyond the standard library is required.

**Why is amount in the response higher than the order price?**

The customer pays the Moonvex fee on top, so amount is the total due. Your price stays in pricing.amount, and what you receive on a full payment is in merchantAmount. Reconcile orders by orderId and pricing.amount, and show the customer amount.

**Is there a test mode or a sandbox?**

No, there is no test network: Moonvex runs on mainnets only. Check the signature with the “Send test” button (a webhook.test event) and the whole payment flow with a real payment of a small amount, for example 1 USDT on TRON.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=php
