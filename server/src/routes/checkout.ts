import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireUser } from '../auth/sessions.js';
import type { ProviderId } from '../config.js';
import type { AppContext } from '../context.js';
import { findDuration, findKit, priceCents } from '../content.js';
import { resolveCountry, routeProviders } from '../geo/routing.js';
import { formatMoney, HttpError } from '../lib/util.js';
import type { OrderRow } from '../store/orders.js';
import { orderView } from '../store/views.js';
import { limiter, parseBody } from './http.js';
import { visitorFromRequest } from '../visitor.js';

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

function countryName(code: string | null): string | null {
  if (!code) return null;
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

const CheckoutBody = z.object({
  kitId: z.string().min(1).max(32),
  durationId: z.string().min(1).max(32),
  provider: z.enum(['stripe', 'paypal', 'mercadopago']),
  acceptTerms: z.literal(true, 'You must accept the terms and refund policy'),
});

export function checkoutRoutes(ctx: AppContext): Router {
  const router = Router();

  function routeFor(req: Request) {
    const resolved = resolveCountry(req, ctx.config, ctx.geo);
    const route = routeProviders(resolved.country, ctx.content().payments, ctx.providers.enabled);
    return { resolved, route };
  }

  function loadOwnOrder(req: Request): OrderRow {
    const id = String(req.params.id ?? '');
    const order = /^ord_[A-Za-z0-9_-]{8,40}$/.test(id) ? ctx.orders.get(id) : undefined;
    if (!order || !req.user || (order.user_id !== req.user.id && !req.user.isAdmin)) {
      throw new HttpError(404, 'Order not found.', 'not_found');
    }
    return order;
  }

  router.get('/checkout/options', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const content = ctx.content();
    const kit = typeof req.query.kitId === 'string' ? findKit(content, req.query.kitId) : undefined;
    const duration = typeof req.query.durationId === 'string' ? findDuration(content, req.query.durationId) : undefined;
    const amountCents = kit && duration ? priceCents(kit, duration) : null;
    const { resolved, route } = routeFor(req);
    res.json({
      country: resolved.country,
      countryName: countryName(resolved.country),
      region: route.region,
      providers: route.providers.map((id) => {
        const p = ctx.providers.get(id)!;
        const quote = amountCents !== null ? p.quote(amountCents) : null;
        return {
          id,
          label: p.label,
          description: p.description,
          charge: quote ? { amount: quote.amount, currency: quote.currency, display: formatMoney(quote.amount, quote.currency) } : null,
        };
      }),
    });
  });

  router.post('/checkout', requireUser, limiter(600, 15, true), async (req, res) => {
    const user = req.user!;
    if (user.is_banned) throw new HttpError(403, 'This account cannot make purchases.', 'banned');
    const body = parseBody(CheckoutBody, req.body);
    const content = ctx.content();
    const kit = findKit(content, body.kitId);
    const duration = findDuration(content, body.durationId);
    if (!kit || kit.hidden || !duration) throw new HttpError(404, 'That kit or duration is not available.', 'not_found');

    const { resolved, route } = routeFor(req);
    if (!route.providers.includes(body.provider as ProviderId)) {
      throw new HttpError(400, 'That payment method is not available in your region.', 'provider_unavailable');
    }
    const provider = ctx.providers.get(body.provider)!;

    const now = ctx.now();
    const owned = ctx.db
      .prepare('SELECT lifetime FROM entitlements WHERE steam_id = ? AND kit_id = ?')
      .get(user.steam_id, kit.id) as { lifetime: number } | undefined;
    if (owned?.lifetime === 1) throw new HttpError(409, `You already own the ${kit.name} kit for life.`, 'already_owned');

    const recent = ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND status = 'pending' AND created_at > ?`)
      .get(user.id, now - 600) as { n: number };
    if (recent.n >= 5) throw new HttpError(429, 'You have several unfinished checkouts. Finish or wait a few minutes.', 'too_many_pending');

    const amountCents = priceCents(kit, duration);
    const quote = provider.quote(amountCents);
    const order = ctx.orders.create({
      userId: user.id,
      steamId: user.steam_id,
      kit,
      duration,
      amountCents,
      chargeAmount: quote.amount,
      chargeCurrency: quote.currency,
      provider: provider.id,
      country: resolved.country,
      ip: req.ip ?? null,
    });

    let result: Awaited<ReturnType<typeof provider.createCheckout>>;
    try {
      result = await provider.createCheckout({ order, kit, duration });
    } catch (err) {
      ctx.orders.markUnpaid(order.id, 'failed', 'Checkout could not be started');
      throw err;
    }
    ctx.orders.setProviderRef(order.id, result.providerRef);
    ctx.log.info({ orderId: order.id, provider: provider.id, kit: kit.id, duration: duration.id, country: resolved.country }, 'Checkout started');
    void ctx.events.emit({ type: 'checkout.started', visitor: visitorFromRequest(req, ctx), order: ctx.orders.summary(order) });
    res.json({ orderId: order.id, redirectUrl: result.redirectUrl });
  });

  router.get('/orders/:id', requireUser, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(orderView(loadOwnOrder(req), ctx.content()));
  });

  router.post('/orders/:id/refresh', requireUser, limiter(60, 20, true), async (req, res) => {
    const order = loadOwnOrder(req);
    const body = parseBody(z.object({ paymentId: z.string().max(40).nullish() }), req.body ?? {});
    if (order.status === 'pending' || order.status === 'failed' || order.status === 'canceled' || order.status === 'expired') {
      const provider = ctx.providers.get(order.provider);
      if (provider) {
        try {
          await provider.refresh(order, { paymentId: body.paymentId ?? null });
        } catch (err) {
          ctx.log.warn({ err: (err as Error).message, orderId: order.id }, 'Order refresh failed');
        }
      }
    }
    res.json(orderView(ctx.orders.get(order.id)!, ctx.content()));
  });

  // PayPal sends the buyer here after approval; we capture server-side, then show the order page.
  router.get('/payments/paypal/return', limiter(60, 30), async (req, res) => {
    const orderId = typeof req.query.order === 'string' ? req.query.order : '';
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const order = /^ord_[A-Za-z0-9_-]{8,40}$/.test(orderId) ? ctx.orders.get(orderId) : undefined;
    if (!order || order.provider !== 'paypal' || !ctx.providers.paypal) return res.redirect(302, '/store');
    if (token && order.provider_ref !== token) return res.redirect(302, `/order/${order.id}`);
    try {
      if (order.status !== 'paid') {
        const { retryUrl } = await ctx.providers.paypal.capture(order);
        // The card was declined: let the buyer pick another funding source on PayPal.
        if (retryUrl) return res.redirect(302, retryUrl);
      }
    } catch (err) {
      ctx.log.error({ err: (err as Error).message, orderId: order.id }, 'PayPal capture on return failed');
      return res.redirect(302, `/order/${order.id}?error=capture`);
    }
    res.redirect(302, `/order/${order.id}`);
  });

  return router;
}
