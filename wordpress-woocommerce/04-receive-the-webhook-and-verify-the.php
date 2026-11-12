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
