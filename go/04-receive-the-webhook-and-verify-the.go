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
