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
