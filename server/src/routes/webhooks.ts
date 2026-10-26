import express, { Router } from 'express';
import Stripe from 'stripe';
import type { AppContext } from '../context.js';
import { InvalidWebhookSignatureError } from '../payments/mercadopago.js';
import { limiter } from './http.js';

/** Mounted before the JSON body parser: Stripe needs the raw bytes to verify signatures. */
export function webhookRoutes(ctx: AppContext): Router {
  const router = Router();
  const seen = ctx.db.prepare('SELECT 1 FROM webhook_events WHERE provider = ? AND event_id = ?');
  const remember = ctx.db.prepare('INSERT OR IGNORE INTO webhook_events (provider, event_id, received_at) VALUES (?, ?, ?)');

  router.post('/stripe', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const stripe = ctx.providers.stripe;
    if (!stripe || !stripe.webhooksEnabled) return res.status(404).json({ error: 'stripe webhooks not configured' });
    let event: Stripe.Event;
    try {
      event = await stripe.verifyEvent(req.body as Buffer, req.get('stripe-signature'));
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message }, 'Rejected Stripe webhook');
      return res.status(400).json({ error: 'invalid signature' });
    }
    if (seen.get('stripe', event.id)) return res.json({ received: true, duplicate: true });
    try {
      await stripe.processEvent(event);
      remember.run('stripe', event.id, ctx.now());
    } catch (err) {
      ctx.log.error({ err, eventId: event.id, type: event.type }, 'Stripe webhook processing failed');
      return res.status(500).json({ error: 'processing failed' });
    }
    res.json({ received: true });
  });

  router.post('/paypal', limiter(60, 120), express.json({ limit: '256kb' }), async (req, res) => {
    const paypal = ctx.providers.paypal;
    if (!paypal) return res.status(404).json({ error: 'paypal not configured' });
    const body = (req.body ?? {}) as { id?: string; event_type?: string; resource?: Record<string, unknown> };
    const eventId = typeof body.id === 'string' ? body.id.slice(0, 64) : null;
    if (eventId && seen.get('paypal', eventId)) return res.json({ received: true, duplicate: true });
    try {
      await paypal.handleWebhook(body);
      if (eventId) remember.run('paypal', eventId, ctx.now());
    } catch (err) {
      ctx.log.error({ err: (err as Error).message, eventId, type: body.event_type }, 'PayPal webhook processing failed');
      return res.status(500).json({ error: 'processing failed' });
    }
    res.json({ received: true });
  });

  router.post('/mercadopago', limiter(60, 120), express.json({ limit: '256kb' }), async (req, res) => {
    const mp = ctx.providers.mercadopago;
    if (!mp) return res.status(404).json({ error: 'mercadopago not configured' });
    const queryId = typeof req.query['data.id'] === 'string' ? (req.query['data.id'] as string) : undefined;
    try {
      mp.verifySignature({ xSignature: req.get('x-signature'), xRequestId: req.get('x-request-id') }, queryId);
    } catch (err) {
      const reason = err instanceof InvalidWebhookSignatureError ? err.reason : (err as Error).message;
      ctx.log.warn({ reason }, 'Rejected Mercado Pago webhook');
      return res.status(401).json({ error: 'invalid signature' });
    }
    const body = (req.body ?? {}) as { type?: string; data?: { id?: string | number } };
    const type = (typeof req.query.type === 'string' ? req.query.type : undefined) ?? body.type;
    // The signature covers the query-string id, so only that id is trusted.
    try {
      await mp.handleNotification(type, queryId);
    } catch (err) {
      ctx.log.error({ err: (err as Error).message, dataId: queryId }, 'Mercado Pago webhook processing failed');
      return res.status(500).json({ error: 'processing failed' });
    }
    res.json({ received: true });
  });

  return router;
}
