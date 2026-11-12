# Accept crypto payments in Go

Accept USDT, BTC and other coins in a Go service using only the standard library: net/http creates the payment and receives the webhook, crypto/hmac verifies the signature, and database/sql with pgx marks the order paid exactly once.

Full guide with explanations: https://moonvex.org/en/guides/go?utm_source=github&utm_medium=repo&utm_campaign=go

## 1. Get an API key and a webhook secret

In the Moonvex dashboard go to “Integration” → “Create key” → type “Secret” (sk_live_…). The key is shown only once: store it on your server as MOONVEX_SECRET_KEY. On the same page add a webhook pointing to an https URL on your server and store its signing secret as MOONVEX_WEBHOOK_SECRET.

File: [`01-get-an-api-key-and-a-webhook-secret.sh`](./01-get-an-api-key-and-a-webhook-secret.sh)

```bash
go get github.com/jackc/pgx/v5

export MOONVEX_SECRET_KEY=sk_live_...
export MOONVEX_WEBHOOK_SECRET=whsec_...
export DATABASE_URL=postgres://user:pass@localhost:5432/shop
```

## 2. Create a payment

Moonvex amounts are strings, so the Amount field of the Payment struct is a string and PostgreSQL returns the total as total::text. Routes with a method and {id} come from net/http in Go 1.22+.

File: [`02-create-a-payment.go`](./02-create-a-payment.go)

```go
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

type Payment struct {
	ID         string `json:"id"`
	Status     string `json:"status"`
	OrderID    string `json:"orderId"`
	Amount     string `json:"amount"` // amounts are strings, not float64
	Asset      string `json:"asset"`
	Network    string `json:"network"`
	PaymentURL string `json:"paymentUrl"`
}

type apiError struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func createPayment(ctx context.Context, orderID, amount string, attempt int) (*Payment, error) {
	body, _ := json.Marshal(map[string]string{
		"orderId": orderID, "amount": amount, "currency": "USDT", "network": "TRON",
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
	var p Payment
	return &p, json.NewDecoder(res.Body).Decode(&p)
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
	p, err := createPayment(r.Context(), id, total, 1)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	http.Redirect(w, r, p.PaymentURL, http.StatusSeeOther)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /orders/{id}/pay", payHandler)
	mux.HandleFunc("POST /moonvex/webhook", webhookHandler)
	log.Fatal(http.ListenAndServe(":8080", mux))
}
```

## 3. Send the customer to paymentUrl

paymentUrl is a hosted payment page: the exact amount including the fee, the address, a QR code, the official token contract and a timer, with a status that updates by itself. Open it with a redirect or in a new tab; it cannot be embedded in an iframe. A customer returning to your site is not proof of payment: mark the order paid only from a webhook or the status from GET /v1/payments/:id. http.Redirect(w, r, url, http.StatusSeeOther).

## 4. Receive the webhook and verify the signature

Moonvex sends a POST with a Moonvex-Signature header: t=<unix time>,v1=<signature>. The signature is a hex HMAC-SHA256 of the string “t.raw_body” keyed with the webhook secret. Compute it over the body bytes before parsing JSON, compare in constant time and reject events older than 5 minutes. For 24 hours after a secret rotation the header carries two v1 values; either one is valid. The body is read with io.ReadAll behind http.MaxBytesReader, and signatures are compared with hmac.Equal. The HMAC uses t exactly as it arrived in the header.

File: [`04-receive-the-webhook-and-verify-the.go`](./04-receive-the-webhook-and-verify-the.go)

```go
// webhook.go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func verifyMoonvex(raw []byte, header, secret string, tolerance time.Duration) bool {
	var ts string
	var sigs []string
	for _, part := range strings.Split(header, ",") {
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		switch k {
		case "t":
			ts = v
		case "v1":
			sigs = append(sigs, v)
		}
	}
	t, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return false
	}
	if d := time.Since(time.Unix(t, 0)); d > tolerance || d < -tolerance {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "."))
	mac.Write(raw)
	expected := mac.Sum(nil)
	for _, s := range sigs {
		got, err := hex.DecodeString(s)
		// hmac.Equal is a constant-time comparison
		if err == nil && hmac.Equal(got, expected) {
			return true
		}
	}
	return false
}

func webhookHandler(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	if !verifyMoonvex(raw, r.Header.Get("Moonvex-Signature"), os.Getenv("MOONVEX_WEBHOOK_SECRET"), 5*time.Minute) {
		http.Error(w, "bad signature", http.StatusBadRequest)
		return
	}

	var event struct {
		ID   string `json:"id"`
		Type string `json:"type"`
		Data struct {
			OrderID string `json:"orderId"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &event); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if event.Type == "payment.confirmed" || event.Type == "payment.overpaid" {
		if err := markOrderPaidOnce(r.Context(), event.ID, event.Data.OrderID); err != nil {
			// a 5xx makes Moonvex retry
			http.Error(w, "retry later", http.StatusInternalServerError)
			return
		}
	}
	w.WriteHeader(http.StatusOK)
}
```

## 5. Mark the order paid exactly once

A redelivered event keeps the same id, so store it in a table with a unique key in the same transaction as the order update: a duplicate then changes nothing. Fulfil on payment.confirmed and payment.overpaid, never on payment.detected. RowsAffected() after INSERT … ON CONFLICT DO NOTHING: 0 means the event was seen before.

File: [`05-mark-the-order-paid-exactly-once.go`](./05-mark-the-order-paid-exactly-once.go)

```go
// store.go
package main

import "context"

// CREATE TABLE processed_events (event_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());

func markOrderPaidOnce(ctx context.Context, eventID, orderID string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(ctx, `INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`, eventID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 1 { // 0 means already processed
		if _, err := tx.ExecContext(ctx, `UPDATE orders SET status = 'paid' WHERE id = $1 AND status <> 'paid'`, orderID); err != nil {
			return err
		}
	}
	return tx.Commit()
}
```

## 6. Test the integration

Moonvex has no test network: everything runs on mainnets. The “Send test” button under “Integration” sends a webhook.test event, which is how you check the signature. Then pay a small invoice, for example 1 USDT on TRON: it is a regular payment and the money lands on your balance. The delivery log with response codes and a “Retry” button is on the same page.

## Pitfalls

- Do not decode the body with json.NewDecoder(r.Body) before verifying: the stream gets consumed and the bytes for the HMAC are gone.
- Use string or a decimal package for amounts, never float64.
- Give your http.Client a Timeout; the default client waits forever.
- Never log the webhook secret or the full Authorization header.

## FAQ

**Is there a Go SDK?**

The official SDK currently exists only for Node.js. In Go the standard library is enough: two HTTP calls and the signature check from this guide.

**What if the customer does not pay in time?**

The payment moves to EXPIRED and you receive payment.expired. You can create a new payment for the same orderId with a new Idempotency-Key (for example, bump the attempt number at the end of the key). The payment window is set with expiresInMinutes: 5 to 1440 minutes, 30 by default.

**Is there a test mode or a sandbox?**

No, there is no test network: Moonvex runs on mainnets only. Check the signature with the “Send test” button (a webhook.test event) and the whole payment flow with a real payment of a small amount, for example 1 USDT on TRON.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=go
