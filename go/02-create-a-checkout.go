// payment.go
package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

var (
	db, _      = sql.Open("pgx", os.Getenv("DATABASE_URL"))
	httpClient = &http.Client{Timeout: 15 * time.Second}
)

// Checkout is the response of POST /v1/payments without network
type Checkout struct {
	ID         string `json:"id"`     // inv_…
	Status     string `json:"status"` // AWAITING_SELECTION
	OrderID    string `json:"orderId"`
	Amount     string `json:"amount"` // amounts are strings, not float64
	Currency   string `json:"currency"`
	PaymentURL string `json:"paymentUrl"`
}

type apiError struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func createCheckout(ctx context.Context, orderID, amount string, attempt int) (*Checkout, error) {
	body, _ := json.Marshal(map[string]string{
		"orderId":     orderID,
		"amount":      amount,
		"currency":    "USD",                                        // no network: the customer picks the coin on the checkout page
		"description": "Order #" + orderID,                          // shown as “You are paying for”
		"returnUrl":   "https://shop.example.com/orders/" + orderID, // the Back buttons
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.moonvex.org/v1/payments", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("MOONVEX_SECRET_KEY"))
	req.Header.Set("Idempotency-Key", fmt.Sprintf("order-%s-%d", orderID, attempt))
	req.Header.Set("Content-Type", "application/json")

	res, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		var e apiError
		_ = json.NewDecoder(res.Body).Decode(&e)
		return nil, fmt.Errorf("moonvex: %s: %s", e.Error.Code, e.Error.Message)
	}
	var c Checkout
	return &c, json.NewDecoder(res.Body).Decode(&c)
}

func payHandler(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var total string
	// numeric → text keeps the exact amount
	err := db.QueryRowContext(r.Context(), `SELECT total::text FROM orders WHERE id = $1`, id).Scan(&total)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	c, err := createCheckout(r.Context(), id, total, 1)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	http.Redirect(w, r, c.PaymentURL, http.StatusSeeOther)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /orders/{id}/pay", payHandler)
	mux.HandleFunc("POST /moonvex/webhook", webhookHandler)
	log.Fatal(http.ListenAndServe(":8080", mux))
}
