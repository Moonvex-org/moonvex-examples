# Accept crypto payments in WooCommerce with the Moonvex plugin

Moonvex has an official plugin, Moonvex Crypto Payments for WooCommerce. It adds a payment method that sends the customer to the Moonvex checkout, where they pick the coin and network and pay; a signed webhook then marks the order paid. Setup takes about ten minutes and needs no code.

Full guide with explanations: https://moonvex.org/en/guides/wordpress-woocommerce?utm_source=github&utm_medium=repo&utm_campaign=wordpress-woocommerce

## 1. Install and activate the plugin

Download the archive from https://moonvex.org/downloads/moonvex-crypto-payments.zip (the plugin is also coming to the WordPress.org directory). In the WordPress admin open Plugins → Add New → Upload Plugin, choose the zip file, click “Install Now”, then “Activate”. The plugin requires an active WooCommerce and PHP 7.4+.

## 2. Create a secret API key

In the Moonvex dashboard go to “Integration” → “Create key” → type “Secret” (sk_live_…). The key is shown only once: paste it straight into the plugin settings (step 4) and do not keep it in emails or chats.

## 3. Add the webhook

On the same “Integration” page add a webhook with the address below, replacing your-shop with your store domain; https is required. The exact URL is also shown in the plugin settings. Copy the webhook signing secret (whsec_…): the plugin checks the signature of every event with it and applies each event once.

File: [`03-add-the-webhook.txt`](./03-add-the-webhook.txt)

```text
https://your-shop/wp-json/moonvex/v1/webhook
```

## 4. Enable Moonvex in WooCommerce

Open WooCommerce → Settings → Payments → Moonvex, tick “Enable”, paste the secret API key and the webhook secret and save. You can also change the method name, the text the customer sees at checkout and the payment window. The store currency (WooCommerce → Settings → General) must be USD or a coin such as USDT; with any other currency the method stays hidden. The plugin works with both the block-based and the classic checkout and is compatible with HPOS.

## 5. How an order gets paid

The customer chooses crypto at checkout and lands on the Moonvex checkout page, which shows the order number and items as “You are paying for”. There they pick the coin and network, see the exact amount, address and QR code and pay from any wallet or exchange; until funds arrive they can switch to another coin. After network confirmations the webhook moves the order to Processing (Completed for virtual and downloadable orders, as usual in WooCommerce). If the customer paid less, the order goes On hold with a note showing the amount received. The “Back to the shop” button returns the customer to the “Order received” page.

## 6. Test with a real payment

Moonvex has no test network: everything runs on mainnets. First press “Send test” next to the webhook under “Integration”: the delivery log should show a 200 response. Then place an order and pay a small amount, for example 1 USDT on TRON. It is a regular payment and the money lands on your Moonvex balance. The order notes show each step, from the detected transfer to the payment.

## Pitfalls

- If the method does not appear at checkout, check the store currency: only USD or a coin is supported, and with other currencies the method is hidden.
- Security and caching plugins sometimes lock down /wp-json/. Make sure /wp-json/moonvex/v1/webhook accepts POST requests from outside and is not cached.
- A customer returning to the store is not proof of payment: the order changes status only after the signed webhook arrives.
- Refunds are not sent from WooCommerce: send the money back as a payout from the Moonvex dashboard to the customer's address.

## FAQ

**Is there an official Moonvex plugin for WordPress?**

Yes: Moonvex Crypto Payments for WooCommerce. Download it from https://moonvex.org/downloads/moonvex-crypto-payments.zip and install it via Plugins → Add New → Upload Plugin; it is also coming to the WordPress.org directory.

**How do refunds work?**

Automatic refunds from WooCommerce are not supported. Send the refund from the Moonvex dashboard as a payout to the customer's address, then mark the order refunded in WooCommerce.

**Is there a test mode or a sandbox?**

No, there is no test network: Moonvex runs on mainnets only. Check the webhook with the “Send test” button in the dashboard and the whole flow with a small real payment, for example 1 USDT on TRON.

**Which store currencies are supported?**

USD or a coin such as USDT. With any other store currency the Moonvex method is hidden at checkout.

**The customer came back to the store but the order is unpaid. Why?**

Returning to the store does not confirm payment. The order becomes paid when the payment.confirmed webhook arrives, after the required number of network confirmations. Check the order notes and the delivery log under “Integration”.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=wordpress-woocommerce
