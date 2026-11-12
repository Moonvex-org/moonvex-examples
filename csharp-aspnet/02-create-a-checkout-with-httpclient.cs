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
            currency = "USD", // no network: the customer picks the coin on the checkout page
            description = "Order #" + id, // shown as “You are paying for”
            returnUrl = "https://shop.example.com/orders/" + id, // the Back buttons
        }),
    };
    request.Headers.Add("Idempotency-Key", "order-" + id + "-1");

    using var response = await http.CreateClient("moonvex").SendAsync(request);
    var checkout = await response.Content.ReadFromJsonAsync<JsonElement>();
    if (!response.IsSuccessStatusCode)
        return Results.Problem(checkout.GetProperty("error").GetProperty("code").GetString(), statusCode: 502);

    return Results.Redirect(checkout.GetProperty("paymentUrl").GetString()!);
});
