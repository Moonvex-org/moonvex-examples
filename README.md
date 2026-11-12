# Moonvex examples: accept crypto payments in any stack

Working examples of accepting **USDT, USDC, BTC, ETH, TON, SOL, TRX and BNB** with [Moonvex](https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=readme): create a payment, send the customer to the hosted checkout page, receive a webhook, verify its HMAC signature and mark the order paid exactly once.

Networks: TRON (TRC-20), Ethereum (ERC-20), BNB Smart Chain (BEP-20), Solana, TON, Bitcoin. Sign-up by email.

## Examples

| Stack | What it shows | Guide |
|---|---|---|
| [Node.js](./nodejs) | Accept USDT, BTC and other coins in Node.js with the @moonvex/node SDK: create payments, use the hosted payment page, verify webhook signatures. | [guide](https://moonvex.org/en/guides/nodejs?utm_source=github&utm_medium=repo&utm_campaign=nodejs) · [на русском](https://moonvex.org/guides/nodejs?utm_source=github&utm_medium=repo&utm_campaign=nodejs) |
| [Express](./express) | Accept crypto in Express.js without an SDK: create payments with fetch, use express.raw for webhooks, verify HMAC-SHA256 with timingSafeEqual and dedupe events. | [guide](https://moonvex.org/en/guides/express?utm_source=github&utm_medium=repo&utm_campaign=express) · [на русском](https://moonvex.org/guides/express?utm_source=github&utm_medium=repo&utm_campaign=express) |
| [NestJS](./nestjs) | Moonvex in NestJS: a service around the @moonvex/node SDK, a payment controller, rawBody for webhook signatures and idempotent order updates in TypeORM. | [guide](https://moonvex.org/en/guides/nestjs?utm_source=github&utm_medium=repo&utm_campaign=nestjs) · [на русском](https://moonvex.org/guides/nestjs?utm_source=github&utm_medium=repo&utm_campaign=nestjs) |
| [Next.js](./nextjs) | Accept crypto in the Next.js App Router: a Route Handler creates the Moonvex payment, the webhook reads the raw body and verifies it with the @moonvex/node SDK. | [guide](https://moonvex.org/en/guides/nextjs?utm_source=github&utm_medium=repo&utm_campaign=nextjs) · [на русском](https://moonvex.org/guides/nextjs?utm_source=github&utm_medium=repo&utm_campaign=nextjs) |
| [Python](./python) | Accept USDT, BTC, ETH and TON in Python: create payments with requests, use the hosted payment page, verify webhooks with hmac.compare_digest, stay idempotent. | [guide](https://moonvex.org/en/guides/python?utm_source=github&utm_medium=repo&utm_campaign=python) · [на русском](https://moonvex.org/guides/python?utm_source=github&utm_medium=repo&utm_campaign=python) |
| [Django](./django) | Connect Moonvex to Django: a payment view with a redirect, a csrf_exempt webhook with HMAC verification and idempotent order updates in transaction.atomic. | [guide](https://moonvex.org/en/guides/django?utm_source=github&utm_medium=repo&utm_campaign=django) · [на русском](https://moonvex.org/guides/django?utm_source=github&utm_medium=repo&utm_campaign=django) |
| [FastAPI](./fastapi) | Async Moonvex integration for FastAPI: payments via httpx.AsyncClient, a webhook with await request.body(), HMAC-SHA256 checks, idempotency with asyncpg. | [guide](https://moonvex.org/en/guides/fastapi?utm_source=github&utm_medium=repo&utm_campaign=fastapi) · [на русском](https://moonvex.org/guides/fastapi?utm_source=github&utm_medium=repo&utm_campaign=fastapi) |
| [PHP](./php) | Accept crypto in plain PHP: create payments with cURL, redirect to the payment page, verify webhook signatures with hash_equals and update orders via PDO. | [guide](https://moonvex.org/en/guides/php?utm_source=github&utm_medium=repo&utm_campaign=php) · [на русском](https://moonvex.org/guides/php?utm_source=github&utm_medium=repo&utm_campaign=php) |
| [Laravel](./laravel) | Accept crypto in Laravel: payments with the Http client, a redirect to the payment page, a CSRF-exempt webhook, signature checks and insertOrIgnore. | [guide](https://moonvex.org/en/guides/laravel?utm_source=github&utm_medium=repo&utm_campaign=laravel) · [на русском](https://moonvex.org/guides/laravel?utm_source=github&utm_medium=repo&utm_campaign=laravel) |
| [WooCommerce](./wordpress-woocommerce) | No ready-made Moonvex plugin for WooCommerce exists yet. This guide builds your own gateway on the API: USDT checkout, a WordPress REST webhook, order updates. | [guide](https://moonvex.org/en/guides/wordpress-woocommerce?utm_source=github&utm_medium=repo&utm_campaign=wordpress-woocommerce) · [на русском](https://moonvex.org/guides/wordpress-woocommerce?utm_source=github&utm_medium=repo&utm_campaign=wordpress-woocommerce) |
| [Go](./go) | A Moonvex integration in Go: create payments with net/http, verify webhook signatures with crypto/hmac and hmac.Equal, mark orders paid once with database/sql. | [guide](https://moonvex.org/en/guides/go?utm_source=github&utm_medium=repo&utm_campaign=go) · [на русском](https://moonvex.org/guides/go?utm_source=github&utm_medium=repo&utm_campaign=go) |
| [Java Spring Boot](./java-spring) | Accept crypto in Spring Boot: payments with RestClient, the webhook as @RequestBody byte[], HMAC-SHA256 with MessageDigest.isEqual, dedupe in JdbcTemplate. | [guide](https://moonvex.org/en/guides/java-spring?utm_source=github&utm_medium=repo&utm_campaign=java-spring) · [на русском](https://moonvex.org/guides/java-spring?utm_source=github&utm_medium=repo&utm_campaign=java-spring) |
| [C# ASP.NET Core](./csharp-aspnet) | Accept crypto in C# and ASP.NET Core: create payments with HttpClient, a Minimal API webhook, HMACSHA256 and FixedTimeEquals, idempotent updates in EF Core. | [guide](https://moonvex.org/en/guides/csharp-aspnet?utm_source=github&utm_medium=repo&utm_campaign=csharp-aspnet) · [на русском](https://moonvex.org/guides/csharp-aspnet?utm_source=github&utm_medium=repo&utm_campaign=csharp-aspnet) |
| [Ruby on Rails](./ruby-rails) | Integrate Moonvex into Rails: create payments with Net::HTTP, redirect_to with allow_other_host, a skip_forgery_protection webhook, HMAC checks, a unique index. | [guide](https://moonvex.org/en/guides/ruby-rails?utm_source=github&utm_medium=repo&utm_campaign=ruby-rails) · [на русском](https://moonvex.org/guides/ruby-rails?utm_source=github&utm_medium=repo&utm_campaign=ruby-rails) |
| [aiogram](./telegram-aiogram) | Accept crypto in a Telegram bot with Python and aiogram 3: an invoice on command, a pay button, an aiohttp webhook with signature checks, and balance top-ups. | [guide](https://moonvex.org/en/guides/telegram-aiogram?utm_source=github&utm_medium=repo&utm_campaign=telegram-aiogram) · [на русском](https://moonvex.org/guides/telegram-aiogram?utm_source=github&utm_medium=repo&utm_campaign=telegram-aiogram) |
| [Telegraf](./telegram-telegraf) | Accept crypto in a Telegram bot with Node.js and Telegraf: invoices via the @moonvex/node SDK, a pay button, an Express webhook and balance top-ups. | [guide](https://moonvex.org/en/guides/telegram-telegraf?utm_source=github&utm_medium=repo&utm_campaign=telegram-telegraf) · [на русском](https://moonvex.org/guides/telegram-telegraf?utm_source=github&utm_medium=repo&utm_campaign=telegram-telegraf) |

## How it works

1. **Create a payment** — `POST https://api.moonvex.org/v1/payments` with your secret key and an `Idempotency-Key`. The response has the address, the exact amount and `paymentUrl`.
2. **Send the customer to `paymentUrl`** — a hosted page with QR code, token contract and live status.
3. **Receive a webhook** — Moonvex signs every event: header `Moonvex-Signature: t=<unix>,v1=<hex>`, where `v1 = HMAC-SHA256(webhook_secret, t + "." + raw_body)`. Compare in constant time and reject old timestamps.
4. **Mark the order paid once** — store the event id with a unique constraint; deliveries are retried for up to three days.

Node.js SDK: [`@moonvex/node`](https://www.npmjs.com/package/@moonvex/node).

## Links

- Website: https://moonvex.org/en?utm_source=github&utm_medium=repo&utm_campaign=readme
- API docs: https://moonvex.org/en/docs?utm_source=github&utm_medium=repo&utm_campaign=docs
- All guides: https://moonvex.org/en/guides?utm_source=github&utm_medium=repo&utm_campaign=readme
- Telegram channel (RU): https://t.me/moonvex_news
- Security: security@moonvex.org

---

**По-русски:** примеры приёма криптоплатежей через Moonvex для 16 стеков: Node.js, Python, PHP, Laravel, Django, FastAPI, Go, Java, C#, Ruby, WordPress, Telegram-боты (aiogram, telegraf). Подробные гайды на русском — по ссылкам «на русском» в таблице выше и на https://moonvex.org/guides?utm_source=github&utm_medium=repo&utm_campaign=readme.

Licensed under MIT.
