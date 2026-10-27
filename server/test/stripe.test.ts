import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { ORIGIN, PLAYER_STEAM, STRIPE_WEBHOOK_SECRET, loginAs, makeCtx } from './helpers.js';

function signed(stripe: Stripe, event: object) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_WEBHOOK_SECRET });
  return { payload, header };
}

function sessionEvent(type: string, id: string, session: Record<string, unknown>) {
  return { id, object: 'event', type, api_version: '2026-09-30.endive', created: 1, data: { object: { object: 'checkout.session', ...session } } };
}

async function startCheckout() {
  const env = { DEV_FORCE_COUNTRY: 'US' };
  const t = makeCtx({ env });
  const create = vi.fn(async (params: Stripe.Checkout.SessionCreateParams) => ({
    id: 'cs_test_123',
    url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    params,
  }));
  (t.stripeClient.checkout.sessions as unknown as { create: typeof create }).create = create;
  const agent = await loginAs(t.app, PLAYER_STEAM);
  const res = await agent.post('/api/checkout').set(ORIGIN).send({ kitId: 'warlord', durationId: '30d', provider: 'stripe', acceptTerms: true });
  return { ...t, agent, create, res };
}

describe('Stripe checkout', () => {
  it('works without Steam sign-in and only shows the order to the same browser', async () => {
    const t = makeCtx({ env: { DEV_FORCE_COUNTRY: 'US' } });
    (t.stripeClient.checkout.sessions as unknown as { create: unknown }).create = vi.fn(async () => ({ id: 'cs_guest', url: 'https://checkout.stripe.com/c/pay/cs_guest' }));
    const buyer = supertest.agent(t.app);
    const res = await buyer
      .post('/api/checkout')
      .set(ORIGIN)
      .send({ kitId: 'warlord', durationId: '30d', provider: 'stripe', acceptTerms: true, steamId: `https://steamcommunity.com/profiles/${PLAYER_STEAM}/` });
    expect(res.status).toBe(200);
    const order = t.ctx.orders.get(res.body.orderId)!;
    expect(order.steam_id).toBe(PLAYER_STEAM);
    expect((await buyer.get(`/api/orders/${order.id}`)).status).toBe(200);
    expect((await supertest(t.app).get(`/api/orders/${order.id}`)).status).toBe(404);
  });

  it('only offers Stripe to US buyers and quotes USD', async () => {
    const { app } = makeCtx({ env: { DEV_FORCE_COUNTRY: 'US' } });
    const res = await supertest(app).get('/api/checkout/options?kitId=warlord&durationId=30d');
    expect(res.status).toBe(200);
    expect(res.body.country).toBe('US');
    expect(res.body.providers.map((p: { id: string }) => p.id)).toEqual(['stripe']);
    expect(res.body.providers[0].charge).toEqual({ amount: 5000, currency: 'USD', display: '$50' });
  });

  it('rejects a provider that is not routed to the buyer region', async () => {
    const { app } = makeCtx({ env: { DEV_FORCE_COUNTRY: 'US' } });
    const agent = await loginAs(app, PLAYER_STEAM);
    const res = await agent.post('/api/checkout').set(ORIGIN).send({ kitId: 'warlord', durationId: '30d', provider: 'mercadopago', acceptTerms: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('provider_unavailable');
  });

  it('requires terms acceptance, login and same-origin requests', async () => {
    const { app } = makeCtx({ env: { DEV_FORCE_COUNTRY: 'US' } });
    // Without Steam sign-in the buyer has to name the Steam account.
    const guest = await supertest(app).post('/api/checkout').set(ORIGIN).send({ kitId: 'warlord', durationId: '30d', provider: 'stripe', acceptTerms: true });
    expect(guest.body.error.code).toBe('steam_id_required');
    const agent = await loginAs(app, PLAYER_STEAM);
    const noTerms = await agent.post('/api/checkout').set(ORIGIN).send({ kitId: 'warlord', durationId: '30d', provider: 'stripe' });
    expect(noTerms.status).toBe(400);
    const crossSite = await agent.post('/api/checkout').set('Origin', 'https://evil.example').send({ kitId: 'warlord', durationId: '30d', provider: 'stripe', acceptTerms: true });
    expect(crossSite.status).toBe(403);
  });

  it('creates a session with server-side prices and fulfills from a signed webhook', async () => {
    const { ctx, app, agent, create, res, stripeClient } = await startCheckout();
    expect(res.status).toBe(200);
    expect(res.body.redirectUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_123');
    const params = create.mock.calls[0]![0];
    expect(params.mode).toBe('payment');
    expect(params.line_items?.[0]?.price_data?.unit_amount).toBe(5000);
    expect(params.line_items?.[0]?.price_data?.currency).toBe('usd');
    expect(params.line_items?.[0]?.price_data?.product_data?.tax_code).toBe('txcd_10201001');
    expect(params.client_reference_id).toBe(res.body.orderId);
    expect(params.success_url).toContain(`/order/${res.body.orderId}?session_id={CHECKOUT_SESSION_ID}`);

    const orderId = res.body.orderId as string;
    const event = sessionEvent('checkout.session.completed', 'evt_1', {
      id: 'cs_test_123',
      client_reference_id: orderId,
      payment_status: 'paid',
      status: 'complete',
      currency: 'usd',
      amount_subtotal: 5000,
      amount_total: 5000,
      payment_intent: 'pi_123',
      metadata: { orderId },
    });
    const { payload, header } = signed(stripeClient, event);
    const hook = await supertest(app).post('/api/webhooks/stripe').set('Stripe-Signature', header).set('Content-Type', 'application/json').send(payload);
    expect(hook.status).toBe(200);

    const order = await agent.get(`/api/orders/${orderId}`);
    expect(order.body.status).toBe('paid');
    const account = await agent.get('/api/account');
    expect(account.body.kits).toHaveLength(1);
    expect(account.body.kits[0]).toMatchObject({ kitId: 'warlord', lifetime: false });
    const expiresAt = account.body.kits[0].expiresAt as number;
    expect(expiresAt - ctx.now()).toBeGreaterThan(29 * 86_400);

    // Same event again is a no-op.
    const again = await supertest(app).post('/api/webhooks/stripe').set('Stripe-Signature', header).set('Content-Type', 'application/json').send(payload);
    expect(again.body.duplicate).toBe(true);
    const grants = ctx.db.prepare('SELECT COUNT(*) AS n FROM grants').get() as { n: number };
    expect(grants.n).toBe(1);
    const notes = ctx.db.prepare('SELECT message FROM notifications').all() as { message: string }[];
    expect(notes[0]!.message).toContain('/claim warlord');

    // A full refund revokes access.
    const refund = signed(stripeClient, {
      id: 'evt_2', object: 'event', type: 'charge.refunded', api_version: '2026-09-30.endive', created: 2,
      data: { object: { object: 'charge', id: 'ch_1', payment_intent: 'pi_123', refunded: true, amount_refunded: 5000 } },
    });
    await supertest(app).post('/api/webhooks/stripe').set('Stripe-Signature', refund.header).set('Content-Type', 'application/json').send(refund.payload);
    expect((await agent.get(`/api/orders/${orderId}`)).body.status).toBe('refunded');
    expect((await agent.get('/api/account')).body.kits).toHaveLength(0);
  });

  it('rejects forged webhooks', async () => {
    const { app, res } = await startCheckout();
    const forged = JSON.stringify(sessionEvent('checkout.session.completed', 'evt_x', { id: 'cs_test_123', client_reference_id: res.body.orderId, payment_status: 'paid' }));
    const hook = await supertest(app)
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', 't=1,v1=deadbeef')
      .set('Content-Type', 'application/json')
      .send(forged);
    expect(hook.status).toBe(400);
  });

  it('holds orders for review when the paid amount does not match', async () => {
    const { app, agent, res, stripeClient } = await startCheckout();
    const orderId = res.body.orderId as string;
    const { payload, header } = signed(
      stripeClient,
      sessionEvent('checkout.session.completed', 'evt_m', {
        id: 'cs_test_123', client_reference_id: orderId, payment_status: 'paid', currency: 'usd', amount_subtotal: 100, amount_total: 100, payment_intent: 'pi_9',
      }),
    );
    await supertest(app).post('/api/webhooks/stripe').set('Stripe-Signature', header).set('Content-Type', 'application/json').send(payload);
    expect((await agent.get(`/api/orders/${orderId}`)).body.status).toBe('review');
    expect((await agent.get('/api/account')).body.kits).toHaveLength(0);
  });

  it('confirms payment on the landing page when the webhook is late', async () => {
    const { agent, res, stripeClient } = await startCheckout();
    const orderId = res.body.orderId as string;
    const retrieve = vi.fn(async () => ({
      id: 'cs_test_123', object: 'checkout.session', client_reference_id: orderId, payment_status: 'paid', status: 'complete',
      currency: 'usd', amount_subtotal: 5000, amount_total: 5000, payment_intent: 'pi_7', metadata: {},
    }));
    (stripeClient.checkout.sessions as unknown as { retrieve: typeof retrieve }).retrieve = retrieve;
    const refreshed = await agent.post(`/api/orders/${orderId}/refresh`).set(ORIGIN).send({});
    expect(retrieve).toHaveBeenCalledWith('cs_test_123');
    expect(refreshed.body.status).toBe('paid');
  });

  it('blocks buying a kit already owned for life', async () => {
    const { app, stripeClient } = makeCtx({ env: { DEV_FORCE_COUNTRY: 'US' } });
    (stripeClient.checkout.sessions as unknown as { create: () => unknown }).create = async () => ({ id: 'cs_l', url: 'https://checkout.stripe.com/x' });
    const agent = await loginAs(app, PLAYER_STEAM);
    const first = await agent.post('/api/checkout').set(ORIGIN).send({ kitId: 'scrapper', durationId: 'lifetime', provider: 'stripe', acceptTerms: true });
    const { payload, header } = signed(
      stripeClient,
      sessionEvent('checkout.session.completed', 'evt_l', {
        id: 'cs_l', client_reference_id: first.body.orderId, payment_status: 'paid', currency: 'usd', amount_subtotal: 2500, amount_total: 2500, payment_intent: 'pi_l',
      }),
    );
    await supertest(app).post('/api/webhooks/stripe').set('Stripe-Signature', header).set('Content-Type', 'application/json').send(payload);
    const second = await agent.post('/api/checkout').set(ORIGIN).send({ kitId: 'scrapper', durationId: '30d', provider: 'stripe', acceptTerms: true });
    expect(second.status).toBe(409);
  });
});
