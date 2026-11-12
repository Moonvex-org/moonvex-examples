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
