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
    'currency' => 'USD', // no network: the customer picks the coin on the checkout page
    'description' => 'Order #' . $order['id'], // shown as “You are paying for”
    'returnUrl' => 'https://shop.example.com/orders/' . $order['id'], // the Back buttons
  ]),
]);
$checkout = json_decode(curl_exec($ch), true);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
if ($status >= 400 || !$checkout) {
  http_response_code(502);
  exit('Moonvex: ' . ($checkout['error']['code'] ?? 'network error'));
}

header('Location: ' . $checkout['paymentUrl'], true, 303);
