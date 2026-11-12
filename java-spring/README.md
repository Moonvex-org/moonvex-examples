# Accept crypto payments in Spring Boot

How to connect Moonvex to a Spring Boot 3 app: RestClient creates a checkout and returns the link to the page where the customer picks the coin, and the webhook controller receives the body as byte[], verifies the signature with javax.crypto.Mac and marks the order in a transaction.

Full guide with explanations: https://moonvex.org/en/guides/java-spring?utm_source=github&utm_medium=repo&utm_campaign=java-spring

## 1. Get an API key and a webhook secret

In the Moonvex dashboard go to “Integration” → “Create key” → type “Secret” (sk_live_…). The key is shown only once: store it on your server as MOONVEX_SECRET_KEY. On the same page add a webhook pointing to an https URL on your server and store its signing secret as MOONVEX_WEBHOOK_SECRET. In Spring Boot inject them into application.properties from environment variables.

File: [`01-get-an-api-key-and-a-webhook-secret.properties`](./01-get-an-api-key-and-a-webhook-secret.properties)

```properties
# application.properties — values come from environment variables
moonvex.secret-key=${MOONVEX_SECRET_KEY}
moonvex.webhook-secret=${MOONVEX_WEBHOOK_SECRET}
```

## 2. Create a checkout with RestClient

A RestClient (Spring Framework 6.1+) with the base URL and the Authorization header is built once. The request has no network, so Moonvex creates a checkout where the customer picks the coin and network. description is shown as “You are paying for”, returnUrl (https only) is where the Back buttons lead. The amount is BigDecimal.toPlainString(), never a double. The controller responds 303 with Location set to paymentUrl.

File: [`02-create-a-checkout-with-restclient.java`](./02-create-a-checkout-with-restclient.java)

```java
// MoonvexClient.java
@Service
public class MoonvexClient {
    private final RestClient http;

    public MoonvexClient(@Value("${moonvex.secret-key}") String secretKey) {
        this.http = RestClient.builder()
                .baseUrl("https://api.moonvex.org")
                .defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + secretKey)
                .build();
    }

    public JsonNode createCheckout(long orderId, BigDecimal amount, int attempt) {
        return http.post()
                .uri("/v1/payments")
                .header("Idempotency-Key", "order-" + orderId + "-" + attempt)
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of(
                        "orderId", String.valueOf(orderId),
                        "amount", amount.toPlainString(), // BigDecimal → "25.00", not a double
                        "currency", "USD", // no network: the customer picks the coin on the checkout page
                        "description", "Order #" + orderId, // shown as “You are paying for”
                        "returnUrl", "https://shop.example.com/orders/" + orderId)) // the Back buttons
                .retrieve()
                .body(JsonNode.class); // {"object": "checkout", "id": "inv_…", "paymentUrl": …}
    }
}

// PayController.java
@RestController
public class PayController {
    private final MoonvexClient moonvex;
    private final OrderRepository orders;

    public PayController(MoonvexClient moonvex, OrderRepository orders) {
        this.moonvex = moonvex;
        this.orders = orders;
    }

    @PostMapping("/orders/{id}/pay")
    public ResponseEntity<Void> pay(@PathVariable long id) {
        Order order = orders.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        JsonNode checkout = moonvex.createCheckout(order.getId(), order.getTotal(), 1);
        return ResponseEntity.status(HttpStatus.SEE_OTHER)
                .location(URI.create(checkout.get("paymentUrl").asText()))
                .build();
    }
}
```

## 3. Send the customer to paymentUrl

paymentUrl is the Moonvex checkout page: the customer picks the coin and network, then sees the exact amount including the fee, the address, a QR code, the official token contract and a timer, with a status that updates by itself. Your description is shown as “You are paying for”, and the Back and “Back to the shop” buttons lead to returnUrl. If you know the customer's language, add ?lang=ru, ?lang=uk or ?lang=en to paymentUrl; otherwise the page picks the language itself. Open the page with a redirect or in a new tab; it cannot be embedded in an iframe. A customer returning to your site is not proof of payment: mark the order paid only from a webhook.

## 4. Receive the webhook and verify the signature

Moonvex sends a POST with a Moonvex-Signature header: t=<unix time>,v1=<signature>. The signature is a hex HMAC-SHA256 of the string “t.raw_body” keyed with the webhook secret. Compute it over the body bytes before parsing JSON, compare in constant time and reject events older than 5 minutes. For 24 hours after a secret rotation the header carries two v1 values; either one is valid. A @RequestBody byte[] parameter receives the body without Jackson getting involved, and those are exactly the signed bytes. Signatures are compared with MessageDigest.isEqual and hex is parsed with HexFormat (Java 17+).

File: [`04-receive-the-webhook-and-verify-the.java`](./04-receive-the-webhook-and-verify-the.java)

```java
// MoonvexWebhookController.java
@RestController
public class MoonvexWebhookController {
    private final ObjectMapper json;
    private final OrderService orders;
    private final byte[] secret;

    public MoonvexWebhookController(ObjectMapper json, OrderService orders,
                                    @Value("${moonvex.webhook-secret}") String secret) {
        this.json = json;
        this.orders = orders;
        this.secret = secret.getBytes(StandardCharsets.UTF_8);
    }

    // byte[] gives the body as is, without Jackson conversion
    @PostMapping("/moonvex/webhook")
    public ResponseEntity<String> webhook(@RequestBody byte[] raw,
                                          @RequestHeader(name = "Moonvex-Signature", required = false) String signature) throws Exception {
        if (!verify(raw, signature)) {
            return ResponseEntity.badRequest().body("bad signature");
        }
        JsonNode event = json.readTree(raw);
        String type = event.path("type").asText();
        if (type.equals("payment.confirmed") || type.equals("payment.overpaid")) {
            orders.markPaidOnce(event.path("id").asText(), event.path("data").path("orderId").asText());
        }
        // payment.cancelled also arrives when the customer switches coins: do not cancel the order on it
        return ResponseEntity.ok("ok");
    }

    private boolean verify(byte[] raw, String header) throws Exception {
        if (header == null) return false;
        String ts = null;
        List<String> sigs = new ArrayList<>();
        for (String part : header.split(",")) {
            String[] kv = part.split("=", 2);
            if (kv.length != 2) continue;
            if (kv[0].equals("t")) ts = kv[1];
            else if (kv[0].equals("v1")) sigs.add(kv[1]);
        }
        if (ts == null || !ts.matches("\\d+")) return false;
        if (Math.abs(Instant.now().getEpochSecond() - Long.parseLong(ts)) > 300) return false;

        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret, "HmacSHA256"));
        mac.update((ts + ".").getBytes(StandardCharsets.UTF_8));
        byte[] expected = mac.doFinal(raw);
        for (String s : sigs) {
            try {
                // MessageDigest.isEqual is a constant-time comparison
                if (MessageDigest.isEqual(expected, HexFormat.of().parseHex(s))) return true;
            } catch (IllegalArgumentException ignored) {
                // not hex, skip it
            }
        }
        return false;
    }
}
```

## 5. Mark the order paid exactly once

A redelivered event keeps the same id, so store it in a table with a unique key in the same transaction as the order update: a duplicate then changes nothing. Fulfil on payment.confirmed and payment.overpaid, never on payment.detected. Events arrive for the payment the customer starts: data.id is its pay_… id and data.orderId is your order number. If the customer switches coins, the previous payment gets payment.cancelled: do not cancel the order on it while the checkout is open. @Transactional plus INSERT … ON CONFLICT DO NOTHING: jdbc.update returns 0 on a redelivery.

File: [`05-mark-the-order-paid-exactly-once.java`](./05-mark-the-order-paid-exactly-once.java)

```java
// OrderService.java
// CREATE TABLE processed_events (event_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
@Service
public class OrderService {
    private final JdbcTemplate jdbc;

    public OrderService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Transactional
    public void markPaidOnce(String eventId, String orderId) {
        int fresh = jdbc.update("INSERT INTO processed_events (event_id) VALUES (?) ON CONFLICT DO NOTHING", eventId);
        if (fresh == 0) return; // a redelivery
        jdbc.update("UPDATE orders SET status = 'paid' WHERE id = ? AND status <> 'paid'", Long.parseLong(orderId));
    }
}
```

## 6. Test the integration

Moonvex has no test network: everything runs on mainnets. The “Send test” button under “Integration” sends a webhook.test event, which is how you check the signature. Then pay a small invoice, for example 1 USDT on TRON: it is a regular payment and the money lands on your balance. The delivery log with response codes and a “Retry” button is on the same page.

## Pitfalls

- With Spring Security, exclude /moonvex/webhook from CSRF (csrf.ignoringRequestMatchers) and allow it without authentication (permitAll).
- Do not bind the webhook body to a DTO or a Map: after Jackson the bytes differ and the signature will not match.
- Money is BigDecimal only; send toPlainString() in JSON so you never get 2.5E+1.
- Move heavy work to @Async or a queue: the webhook response must go out within 10 seconds.
- Need one fixed coin instead of the customer's choice? Add network (and asset when currency is USD) to the same request, for example "network", "TRON", "asset", "USDT" in Map.of: that is the classic payment in one coin. The checkout above is the recommended flow.

## FAQ

**Can I use WebClient or OkHttp instead of RestClient?**

Yes, the protocol is plain: POST /v1/payments with JSON and the Authorization: Bearer and Idempotency-Key headers. The example uses RestClient as Spring's own synchronous client.

**Why is amount in the webhook higher than the order price?**

The checkout returns your price as is in amount and currency. The payment the customer starts (data in webhooks) is in the chosen coin, and its amount is the total due including the Moonvex fee on top. Your price stays in pricing.amount, and what you receive on a full payment is in merchantAmount. Reconcile orders by orderId and pricing.amount.

**Is there a test mode or a sandbox?**

No, there is no test network: Moonvex runs on mainnets only. Check the signature with the “Send test” button (a webhook.test event) and the whole payment flow with a real payment of a small amount, for example 1 USDT on TRON.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=java-spring
