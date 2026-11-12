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
    // payment.cancelled also arrives when the customer switches coins: do not cancel the order on it
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
