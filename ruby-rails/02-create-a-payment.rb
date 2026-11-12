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
