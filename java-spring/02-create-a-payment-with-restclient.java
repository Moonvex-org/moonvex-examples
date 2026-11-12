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

    public JsonNode createPayment(long orderId, BigDecimal amount, int attempt) {
        return http.post()
                .uri("/v1/payments")
                .header("Idempotency-Key", "order-" + orderId + "-" + attempt)
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of(
                        "orderId", String.valueOf(orderId),
                        "amount", amount.toPlainString(), // BigDecimal → "25.00", not a double
                        "currency", "USDT",
                        "network", "TRON"))
                .retrieve()
                .body(JsonNode.class);
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
        JsonNode payment = moonvex.createPayment(order.getId(), order.getTotal(), 1);
        return ResponseEntity.status(HttpStatus.SEE_OTHER)
                .location(URI.create(payment.get("paymentUrl").asText()))
                .build();
    }
}
