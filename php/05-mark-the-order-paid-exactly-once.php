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
