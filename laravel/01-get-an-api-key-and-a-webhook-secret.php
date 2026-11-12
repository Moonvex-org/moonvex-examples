# .env
MOONVEX_SECRET_KEY=sk_live_...
MOONVEX_WEBHOOK_SECRET=whsec_...

// config/services.php
'moonvex' => [
    'secret' => env('MOONVEX_SECRET_KEY'),
    'webhook_secret' => env('MOONVEX_WEBHOOK_SECRET'),
],
