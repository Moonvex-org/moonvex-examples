# Accept crypto payments in ASP.NET Core

A Moonvex integration for ASP.NET Core (Minimal API, .NET 8): a named HttpClient creates the payment, and the webhook reads the whole body, verifies the HMACSHA256 signature and marks the order through EF Core exactly once.

Full guide with explanations: https://moonvex.org/en/guides/csharp-aspnet?utm_source=github&utm_medium=repo&utm_campaign=csharp-aspnet

## 1. Get an API key and a webhook secret

In the Moonvex dashboard go to “Integration” → “Create key” → type “Secret” (sk_live_…). The key is shown only once: store it on your server as MOONVEX_SECRET_KEY. On the same page add a webhook pointing to an https URL on your server and store its signing secret as MOONVEX_WEBHOOK_SECRET. In ASP.NET Core keep them in configuration: User Secrets in development, environment variables in production.

File: [`01-get-an-api-key-and-a-webhook-secret.json`](./01-get-an-api-key-and-a-webhook-secret.json)

```json
// appsettings.json (in production use the Moonvex__SecretKey and Moonvex__WebhookSecret environment variables)
{
  "Moonvex": {
    "SecretKey": "sk_live_...",
    "WebhookSecret": "whsec_..."
  }
}
```

## 2. Create a payment with HttpClient

The named moonvex client is registered with AddHttpClient, a base address and the Bearer key. The amount is formatted with CultureInfo.InvariantCulture; otherwise a server with a comma-decimal locale would send 25,00.

File: [`02-create-a-payment-with-httpclient.cs`](./02-create-a-payment-with-httpclient.cs)

```csharp
// Program.cs
using System.Globalization;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddHttpClient("moonvex", c =>
{
    c.BaseAddress = new Uri("https://api.moonvex.org");
    c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", builder.Configuration["Moonvex:SecretKey"]);
    c.Timeout = TimeSpan.FromSeconds(15);
});
builder.Services.AddDbContext<AppDb>();
var app = builder.Build();

app.MapPost("/orders/{id:long}/pay", async (long id, AppDb db, IHttpClientFactory http) =>
{
    var order = await db.Orders.FindAsync(id);
    if (order is null) return Results.NotFound();

    using var request = new HttpRequestMessage(HttpMethod.Post, "/v1/payments")
    {
        Content = JsonContent.Create(new
        {
            orderId = id.ToString(CultureInfo.InvariantCulture),
            // decimal → "25.00" with a dot in any culture
            amount = order.Total.ToString("0.00", CultureInfo.InvariantCulture),
            currency = "USDT",
            network = "TRON",
        }),
    };
    request.Headers.Add("Idempotency-Key", "order-" + id + "-1");

    using var response = await http.CreateClient("moonvex").SendAsync(request);
    var payment = await response.Content.ReadFromJsonAsync<JsonElement>();
    if (!response.IsSuccessStatusCode)
        return Results.Problem(payment.GetProperty("error").GetProperty("code").GetString(), statusCode: 502);

    return Results.Redirect(payment.GetProperty("paymentUrl").GetString()!);
});
```

## 3. Send the customer to paymentUrl

paymentUrl is a hosted payment page: the exact amount including the fee, the address, a QR code, the official token contract and a timer, with a status that updates by itself. Open it with a redirect or in a new tab; it cannot be embedded in an iframe. A customer returning to your site is not proof of payment: mark the order paid only from a webhook or the status from GET /v1/payments/:id. Results.Redirect(url) sends the customer to the payment page.

## 4. Receive the webhook and verify the signature

Moonvex sends a POST with a Moonvex-Signature header: t=<unix time>,v1=<signature>. The signature is a hex HMAC-SHA256 of the string “t.raw_body” keyed with the webhook secret. Compute it over the body bytes before parsing JSON, compare in constant time and reject events older than 5 minutes. For 24 hours after a secret rotation the header carries two v1 values; either one is valid. The body is copied from request.Body into a MemoryStream with no model binding. HMACSHA256.HashData and CryptographicOperations.FixedTimeEquals are built into .NET 6+.

File: [`04-receive-the-webhook-and-verify-the.cs`](./04-receive-the-webhook-and-verify-the.cs)

```csharp
// Program.cs (continued)
app.MapPost("/moonvex/webhook", async (HttpRequest request, AppDb db, IConfiguration config) =>
{
    // read the whole body without model binding: you need the original bytes
    using var ms = new MemoryStream();
    await request.Body.CopyToAsync(ms);
    var raw = ms.ToArray();

    if (!MoonvexSignature.Verify(raw, request.Headers["Moonvex-Signature"], config["Moonvex:WebhookSecret"]!))
        return Results.BadRequest("bad signature");

    using var doc = JsonDocument.Parse(raw);
    var ev = doc.RootElement;
    var type = ev.GetProperty("type").GetString();
    if (type is "payment.confirmed" or "payment.overpaid")
    {
        var orderId = long.Parse(ev.GetProperty("data").GetProperty("orderId").GetString()!, CultureInfo.InvariantCulture);
        await OrderPayments.MarkPaidOnceAsync(db, ev.GetProperty("id").GetString()!, orderId);
    }
    return Results.Ok();
});

app.Run();

static class MoonvexSignature
{
    public static bool Verify(byte[] raw, string? header, string secret, int toleranceSec = 300)
    {
        if (string.IsNullOrEmpty(header)) return false;
        string? ts = null;
        var sigs = new List<string>();
        foreach (var part in header.Split(','))
        {
            var kv = part.Split('=', 2);
            if (kv.Length != 2) continue;
            if (kv[0] == "t") ts = kv[1];
            else if (kv[0] == "v1") sigs.Add(kv[1]);
        }
        if (!long.TryParse(ts, NumberStyles.None, CultureInfo.InvariantCulture, out var t)) return false;
        if (Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - t) > toleranceSec) return false;

        var signed = Encoding.UTF8.GetBytes(ts + ".").Concat(raw).ToArray();
        var expected = HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), signed);
        foreach (var s in sigs)
        {
            byte[] got;
            try { got = Convert.FromHexString(s); } catch (FormatException) { continue; }
            // FixedTimeEquals is a constant-time comparison
            if (CryptographicOperations.FixedTimeEquals(got, expected)) return true;
        }
        return false;
    }
}
```

## 5. Mark the order paid exactly once

A redelivered event keeps the same id, so store it in a table with a unique key in the same transaction as the order update: a duplicate then changes nothing. Fulfil on payment.confirmed and payment.overpaid, never on payment.detected. ExecuteSqlAsync returns the number of affected rows and ExecuteUpdateAsync updates the order without loading it; both come from EF Core 7+.

File: [`05-mark-the-order-paid-exactly-once.cs`](./05-mark-the-order-paid-exactly-once.cs)

```csharp
// OrderPayments.cs (EF Core 7+, PostgreSQL)
// CREATE TABLE processed_events (event_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
using Microsoft.EntityFrameworkCore;

static class OrderPayments
{
    public static async Task MarkPaidOnceAsync(AppDb db, string eventId, long orderId)
    {
        await using var tx = await db.Database.BeginTransactionAsync();
        // EF Core turns interpolated values into SQL parameters, not text
        var fresh = await db.Database.ExecuteSqlAsync(
            $"INSERT INTO processed_events (event_id) VALUES ({eventId}) ON CONFLICT DO NOTHING");
        if (fresh == 1)
        {
            await db.Orders
                .Where(o => o.Id == orderId && o.Status != "paid")
                .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, "paid"));
        }
        await tx.CommitAsync();
    }
}
```

## 6. Test the integration

Moonvex has no test network: everything runs on mainnets. The “Send test” button under “Integration” sends a webhook.test event, which is how you check the signature. Then pay a small invoice, for example 1 USDT on TRON: it is a regular payment and the money lands on your balance. The delivery log with response codes and a “Retry” button is on the same page.

## Pitfalls

- Format amounts with CultureInfo.InvariantCulture: a decimal comma in amount fails validation.
- Do not declare a model parameter for the webhook body: after deserialisation the bytes no longer match what was signed.
- A global authorization policy (FallbackPolicy) will block the webhook; add .AllowAnonymous() to the route.
- Create HttpClient through IHttpClientFactory, not with new HttpClient() per request.

## FAQ

**Does this work with MVC controllers?**

Yes. In the controller action read Request.Body into a MemoryStream as in the example and do not use [FromBody]. For MVC with antiforgery add [IgnoreAntiforgeryToken].

**What if the customer does not pay in time?**

The payment moves to EXPIRED and you receive payment.expired. You can create a new payment for the same orderId with a new Idempotency-Key (for example, bump the attempt number at the end of the key). The payment window is set with expiresInMinutes: 5 to 1440 minutes, 30 by default.

**Is there a test mode or a sandbox?**

No, there is no test network: Moonvex runs on mainnets only. Check the signature with the “Send test” button (a webhook.test event) and the whole payment flow with a real payment of a small amount, for example 1 USDT on TRON.

---

API reference: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs · Sign up: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=csharp-aspnet
