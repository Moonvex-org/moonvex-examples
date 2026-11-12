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
