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
