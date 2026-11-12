// server.js
import express from 'express';
import { verifyWebhook } from '@moonvex/node';
import { bot } from './bot.js';
import { claimEvent } from './db.js';

const app = express();

// express.raw: the signature covers the raw body
app.post('/moonvex/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = verifyWebhook(req.body, req.get('Moonvex-Signature'), process.env.MOONVEX_WEBHOOK_SECRET);
  } catch {
    return res.status(400).send('bad signature');
  }

  if ((event.type === 'payment.confirmed' || event.type === 'payment.overpaid') && (await claimEvent(event.id))) {
    await bot.telegram.sendMessage(
      event.data.metadata.chatId,
      'Payment received, thank you! Order ' + event.data.orderId,
    );
  }
  // payment.cancelled also arrives when the customer switches coins: ignore it, the checkout stays open
  res.sendStatus(200);
});

app.listen(3000); // behind nginx with https
bot.launch();
