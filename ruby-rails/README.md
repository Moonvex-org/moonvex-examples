# Accept crypto payments in Ruby on Rails

How to accept crypto in a Rails app: a small Net::HTTP module creates the payment, a controller sends the customer to the payment page, and the webhook controller verifies the signature over request.raw_post and marks the order once.

Full guide with explanations: https://moonvex.org/en/guides/ruby-rails?utm_source=github&utm_medium=repo&utm_campaign=ruby-rails

## 1. Get an API key and a webhook secret

In the Moonvex dashboard go to “Integration” → “Create key” → type “Secret” (sk_live_…). The key is shown only once: store it on your server as MOONVEX_SECRET_KEY. On the same page add a webhook pointing to an https URL on your server and store its signing secret as MOONVEX_WEBHOOK_SECRET. In Rails use credentials or environment variables. The example includes the generator for a ProcessedEvent model with a unique index.

File: [`01-get-an-api-key-and-a-webhook-secret.sh`](./01-get-an-api-key-and-a-webhook-secret.sh)

```bash
# keys go to credentials or environment variables
export MOONVEX_SECRET_KEY=sk_live_...
export MOONVEX_WEBHOOK_SECRET=whsec_...

bin/rails g model ProcessedEvent event_id:string:uniq
```

## 2. Create a payment

The Moonvex module sends POST /v1/payments with Net::HTTP. The amount is BigDecimal#to_s("F"), a string without an exponent. In Rails 7+ an external redirect needs allow_other_host: true.

File: [`02-create-a-payment.rb`](./02-create-a-payment.rb)

```ruby
# app/services/moonvex.rb
require "net/http"
require "json"

module Moonvex
  API = URI("https://api.moonvex.org")

  def self.create_payment(order_id:, amount:, attempt: 1)
    uri = URI.join(API, "/v1/payments")
    req = Net::HTTP::Post.new(uri,
      "Authorization" => "Bearer #{ENV.fetch('MOONVEX_SECRET_KEY')}",
      "Idempotency-Key" => "order-#{order_id}-#{attempt}",
      "Content-Type" => "application/json")
    req.body = { orderId: order_id.to_s, amount: amount, currency: "USDT", network: "TRON" }.to_json

    res = Net::HTTP.start(uri.host, uri.port, use_ssl: true, read_timeout: 15) { |http| http.request(req) }
    body = JSON.parse(res.body)
    raise "Moonvex #{body.dig('error', 'code')}: #{body.dig('error', 'message')}" unless res.is_a?(Net::HTTPSuccess)

    body
  end
end

# app/controllers/orders_controller.rb
class OrdersController < ApplicationController
  def pay
    order = current_user.orders.find(params[:id])
    # BigDecimal → a "25.0" string, no Float
    payment = Moonvex.create_payment(order_id: order.id, amount: order.total.to_s("F"))
    order.update!(moonvex_payment_id: payment["id"])
    # Rails 7+: an external redirect must be allowed explicitly
    redirect_to payment["paymentUrl"], allow_other_host: true, status: :see_other
  end
end
```

## 3. Send the customer to paymentUrl

paymentUrl is a hosted payment page: the exact amount including the fee, the address, a QR code, the official token contract and a timer, with a status that updates by itself. Open it with a redirect or in a new tab; it cannot be embedded in an iframe. A customer returning to your site is not proof of payment: mark the order paid only from a webhook or the status from GET /v1/payments/:id.

## 4. Receive the webhook and verify the signature

Moonvex sends a POST with a Moonvex-Signature header: t=<unix time>,v1=<signature>. The signature is a hex HMAC-SHA256 of the string “t.raw_body” keyed with the webhook secret. Compute it over the body bytes before parsing JSON, compare in constant time and reject events older than 5 minutes. For 24 hours after a secret rotation the header carries two v1 values; either one is valid. skip_forgery_protection turns CSRF off for this controller only; the raw body is request.raw_post. Signatures are compared with ActiveSupport::SecurityUtils.secure_compare.

File: [`04-receive-the-webhook-and-verify-the.rb`](./04-receive-the-webhook-and-verify-the.rb)

```ruby
# app/controllers/moonvex_webhooks_controller.rb
class MoonvexWebhooksController < ApplicationController
  skip_forgery_protection # Moonvex sends no CSRF token; the signature protects the endpoint
  skip_before_action :authenticate_user!, raise: false

  def create
    raw = request.raw_post # raw body, not params
    return head :bad_request unless verify(raw, request.headers["Moonvex-Signature"], ENV.fetch("MOONVEX_WEBHOOK_SECRET"))

    event = JSON.parse(raw)
    if %w[payment.confirmed payment.overpaid].include?(event["type"])
      Order.mark_paid_once!(event["id"], event.dig("data", "orderId"))
    end
    head :ok
  end

  private

  def verify(raw, header, secret, tolerance: 300)
    parts = header.to_s.split(",").filter_map { |p| p.split("=", 2) if p.include?("=") }
    ts = parts.find { |k, _| k == "t" }&.last
    return false unless ts&.match?(/\A\d+\z/) && (Time.now.to_i - ts.to_i).abs <= tolerance

    expected = OpenSSL::HMAC.hexdigest("SHA256", secret, "#{ts}.#{raw}")
    # secure_compare is a constant-time comparison
    parts.any? { |k, v| k == "v1" && ActiveSupport::SecurityUtils.secure_compare(expected, v) }
  end
end

# config/routes.rb
post "/moonvex/webhook", to: "moonvex_webhooks#create"
post "/orders/:id/pay", to: "orders#pay", as: :pay_order
```

## 5. Mark the order paid exactly once

A redelivered event keeps the same id, so store it in a table with a unique key in the same transaction as the order update: a duplicate then changes nothing. Fulfil on payment.confirmed and payment.overpaid, never on payment.detected. A unique index on event_id: a repeat raises ActiveRecord::RecordNotUnique, the transaction rolls back and the order stays untouched.

File: [`05-mark-the-order-paid-exactly-once.rb`](./05-mark-the-order-paid-exactly-once.rb)

```ruby
# app/models/order.rb
class Order < ApplicationRecord
  def self.mark_paid_once!(event_id, order_id)
    transaction do
      ProcessedEvent.create!(event_id: event_id) # the unique index rejects a duplicate
      order = lock.find(order_id)
      order.update!(status: "paid") unless order.status == "paid"
    end
  rescue ActiveRecord::RecordNotUnique
    # already processed, which is fine
  end
end
```

## 6. Test the integration

Moonvex has no test network: everything runs on mainnets. The “Send test” button under “Integration” sends a webhook.test event, which is how you check the signature. Then pay a small invoice, for example 1 USDT on TRON: it is a regular payment and the money lands on your balance. The delivery log with response codes and a “Retry” button is on the same page.

## Pitfalls

- Without skip_forgery_protection Rails answers every webhook with 422 InvalidAuthenticityToken.
- Do not use params for signature checks: that is already parsed data.
- Without allow_other_host: true, Rails 7 raises UnsafeRedirectError when redirecting to pay.moonvex.org.
- Send heavy work to Active Job after responding with head :ok.

## FAQ

**Can I use Faraday or HTTParty?**

Yes. All you need is POST /v1/payments with JSON and the Authorization: Bearer and Idempotency-Key headers. The example uses Net::HTTP to avoid adding gems.

**Why is amount in the response higher than the order price?**

The customer pays the Moonvex fee on top, so amount is the total due. Your price stays in pricing.amount, and what you receive on a full payment is in merchantAmount. Reconcile orders by orderId and pricing.amount, and show the customer amount.

**Is there a test mode or a sandbox?**

No, there is no test network: Moonvex runs on mainnets only. Check the signature with the “Send test” button (a webhook.test event) and the whole payment flow with a real payment of a small amount, for example 1 USDT on TRON.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=ruby-rails
