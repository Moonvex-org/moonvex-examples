# app/services/moonvex.rb
require "net/http"
require "json"

module Moonvex
  API = URI("https://api.moonvex.org")

  def self.create_checkout(order_id:, amount:, description:, return_url:, attempt: 1)
    uri = URI.join(API, "/v1/payments")
    req = Net::HTTP::Post.new(uri,
      "Authorization" => "Bearer #{ENV.fetch('MOONVEX_SECRET_KEY')}",
      "Idempotency-Key" => "order-#{order_id}-#{attempt}",
      "Content-Type" => "application/json")
    # no network: the customer picks the coin and network on the checkout page
    req.body = {
      orderId: order_id.to_s, amount: amount, currency: "USD",
      description: description, returnUrl: return_url
    }.to_json

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
    checkout = Moonvex.create_checkout(
      order_id: order.id,
      amount: order.total.to_s("F"), # BigDecimal → a "25.0" string, no Float
      description: "Order ##{order.id}", # shown as “You are paying for”
      return_url: order_url(order, protocol: "https") # the Back buttons
    )
    order.update!(moonvex_checkout_id: checkout["id"]) # inv_…
    # Rails 7+: an external redirect must be allowed explicitly
    redirect_to checkout["paymentUrl"], allow_other_host: true, status: :see_other
  end
end
