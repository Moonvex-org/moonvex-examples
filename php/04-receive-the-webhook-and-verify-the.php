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
// payment.cancelled also arrives when the customer switches coins: do not cancel the order on it
http_response_code(200);
echo 'ok';
