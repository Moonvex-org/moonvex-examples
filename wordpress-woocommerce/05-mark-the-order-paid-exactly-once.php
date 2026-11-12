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
