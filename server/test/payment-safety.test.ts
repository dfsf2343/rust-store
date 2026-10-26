import crypto from 'node:crypto';
import supertest from 'supertest';
import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { upsertUser } from '../src/auth/sessions.js';
import { loadConfig } from '../src/config.js';
import { findDuration, findKit, priceCents } from '../src/content.js';
import { reconcilePending } from '../src/maintenance.js';
import type { MercadoPagoApi, MpPayment, MpPreferenceBody } from '../src/payments/mercadopago.js';
import { ADMIN_STEAM, BASE, MP_WEBHOOK_SECRET, ORIGIN, PLAYER_STEAM, STRIPE_WEBHOOK_SECRET, loginAs, makeCtx, scriptedFetch } from './helpers.js';

function stripeEvent(stripe: Stripe, id: string, type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id, object: 'event', type, api_version: '2026-09-30.endive', created: 1, data: { object } });
  return { payload, header: stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_WEBHOOK_SECRET }) };
}

async function stripeOrder(kitId = 'warlord', durationId = '30d') {
  const t = makeCtx({ env: { DEV_FORCE_COUNTRY: 'US' } });
  (t.stripeClient.checkout.sessions as unknown as { create: () => unknown }).create = async () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
  const agent = await loginAs(t.app, PLAYER_STEAM);
  const res = await agent.post('/api/checkout').set(ORIGIN).send({ kitId, durationId, provider: 'stripe', acceptTerms: true });
  expect(res.status).toBe(200);
  const orderId = res.body.orderId as string;
  const paidSession = { object: 'checkout.session', id: 'cs_test_1', client_reference_id: orderId, payment_status: 'paid', status: 'complete', currency: 'usd', amount_subtotal: 5000, amount_total: 5000, payment_intent: 'pi_1', metadata: { orderId } };
  const post = (e: { payload: string; header: string }) =>
    supertest(t.app).post('/api/webhooks/stripe').set('Stripe-Signature', e.header).set('Content-Type', 'application/json').send(e.payload);
  return { ...t, agent, orderId, paidSession, post };
}

describe('Stripe refunds and disputes', () => {
  it('does not deliver an order that was refunded before its confirmation arrived', async () => {
    const t = await stripeOrder();
    t.paymentIntents.set('pi_1', { metadata: { orderId: t.orderId }, refunded: true, amountRefunded: 5000 });
    // checkout.session.completed was missed; the refund webhook finds the order through the PaymentIntent.
    const refund = stripeEvent(t.stripeClient, 'evt_r', 'charge.refunded', { object: 'charge', id: 'ch_1', payment_intent: 'pi_1', refunded: true, amount_refunded: 5000, amount: 5000, currency: 'usd' });
    expect((await t.post(refund)).status).toBe(200);
    expect((await t.agent.get(`/api/orders/${t.orderId}`)).body.status).toBe('refunded');

    // The late confirmation and a manual refresh must not deliver it now.
    expect((await t.post(stripeEvent(t.stripeClient, 'evt_c', 'checkout.session.completed', t.paidSession))).status).toBe(200);
    (t.stripeClient.checkout.sessions as unknown as { retrieve: () => unknown }).retrieve = async () => t.paidSession;
    await t.agent.post(`/api/orders/${t.orderId}/refresh`).set(ORIGIN).send({});
    expect((await t.agent.get(`/api/orders/${t.orderId}`)).body.status).toBe('refunded');
    expect((await t.agent.get('/api/account')).body.kits).toHaveLength(0);
  });

  it('checks the charge before delivering on the landing page', async () => {
    const t = await stripeOrder();
    t.paymentIntents.set('pi_1', { disputed: true });
    (t.stripeClient.checkout.sessions as unknown as { retrieve: () => unknown }).retrieve = async () => t.paidSession;
    const refreshed = await t.agent.post(`/api/orders/${t.orderId}/refresh`).set(ORIGIN).send({});
    expect(refreshed.body.status).toBe('disputed');
    expect((await t.agent.get('/api/account')).body.kits).toHaveLength(0);
  });

  it('keeps access on a partial refund but flags the order for staff', async () => {
    const t = await stripeOrder();
    await t.post(stripeEvent(t.stripeClient, 'evt_c', 'checkout.session.completed', t.paidSession));
    expect((await t.agent.get(`/api/orders/${t.orderId}`)).body.status).toBe('paid');
    const partial = stripeEvent(t.stripeClient, 'evt_p', 'charge.refunded', { object: 'charge', id: 'ch_1', payment_intent: 'pi_1', refunded: false, amount_refunded: 1000, amount: 5000, currency: 'usd' });
    await t.post(partial);
    expect((await t.agent.get('/api/account')).body.kits).toHaveLength(1);
    const admin = await loginAs(t.app, ADMIN_STEAM);
    const overview = await admin.get('/api/admin/overview');
    expect(overview.body.attention.map((o: { id: string }) => o.id)).toContain(t.orderId);
    expect(overview.body.attention[0].statusDetail).toContain('Partially refunded');
  });

  it('closes an undelivered order when a dispute opens', async () => {
    const t = await stripeOrder();
    t.paymentIntents.set('pi_1', { metadata: { orderId: t.orderId } });
    await t.post(stripeEvent(t.stripeClient, 'evt_d', 'charge.dispute.created', { object: 'dispute', id: 'dp_1', payment_intent: 'pi_1', reason: 'fraudulent' }));
    expect((await t.agent.get(`/api/orders/${t.orderId}`)).body.status).toBe('disputed');
  });

  it('switches Stripe off in production when the webhook secret is missing', () => {
    const config = loadConfig({ NODE_ENV: 'production', BASE_URL: 'https://store.example.com', CONFIG_DIR: '../config', STRIPE_SECRET_KEY: 'sk_live_x' });
    expect(config.stripe).toBeNull();
    expect(config.warnings.join(' ')).toContain('STRIPE_WEBHOOK_SECRET');
  });
});

describe('Pending payment reconciliation', () => {
  it('confirms a paid order whose webhook never arrived', async () => {
    let clock = Math.floor(Date.now() / 1000);
    const t = makeCtx({ env: { DEV_FORCE_COUNTRY: 'US' }, now: () => clock });
    (t.stripeClient.checkout.sessions as unknown as { create: () => unknown }).create = async () => ({ id: 'cs_test_9', url: 'https://checkout.stripe.com/c/pay/cs_test_9' });
    const agent = await loginAs(t.app, PLAYER_STEAM);
    const res = await agent.post('/api/checkout').set(ORIGIN).send({ kitId: 'warlord', durationId: '30d', provider: 'stripe', acceptTerms: true });
    const orderId = res.body.orderId as string;
    const retrieve = vi.fn(async () => ({ object: 'checkout.session', id: 'cs_test_9', client_reference_id: orderId, payment_status: 'paid', status: 'complete', currency: 'usd', amount_subtotal: 5000, amount_total: 5000, payment_intent: 'pi_9', metadata: {} }));
    (t.stripeClient.checkout.sessions as unknown as { retrieve: typeof retrieve }).retrieve = retrieve;

    expect(await reconcilePending(t.ctx)).toBe(0); // too recent
    clock += 11 * 60;
    expect(await reconcilePending(t.ctx)).toBe(1);
    expect(t.ctx.orders.get(orderId)!.status).toBe('paid');
    expect(await reconcilePending(t.ctx)).toBe(0); // no longer pending
  });
});

describe('PayPal reversals and declines', () => {
  function paypalFetch(state: { orderId: string; declineFirst: boolean; reversed: boolean; captureRequestIds: string[] }) {
    return scriptedFetch([
      { method: 'POST', match: '/v1/oauth2/token', reply: () => ({ body: { access_token: 'A21', expires_in: 32000 } }) },
      {
        method: 'POST',
        match: /\/v2\/checkout\/orders$/,
        reply: () => ({ body: { id: '5O190127TN364715T', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T' }] } }),
      },
      {
        method: 'POST',
        match: '/v2/checkout/orders/5O190127TN364715T/capture',
        reply: (_url, init) => {
          state.captureRequestIds.push((init?.headers as Record<string, string>)['PayPal-Request-Id']!);
          if (state.declineFirst) {
            state.declineFirst = false;
            return {
              status: 422,
              body: {
                name: 'UNPROCESSABLE_ENTITY',
                details: [{ issue: 'INSTRUMENT_DECLINED', description: 'The instrument presented was either declined by the processor or bank.' }],
                links: [{ rel: 'redirect', href: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T', method: 'GET' }],
              },
            };
          }
          return {
            status: 201,
            body: {
              id: '5O190127TN364715T',
              status: 'COMPLETED',
              purchase_units: [{ reference_id: state.orderId, payments: { captures: [{ id: '9XA12345BC6789012', status: 'COMPLETED', amount: { currency_code: 'USD', value: '20.00' }, custom_id: state.orderId }] } }],
            },
          };
        },
      },
      {
        method: 'GET',
        match: '/v2/payments/refunds/7NW87381K3762402X',
        reply: () =>
          state.reversed
            ? {
                body: {
                  id: '7NW87381K3762402X',
                  status: 'COMPLETED',
                  links: [
                    { rel: 'self', href: 'https://api.sandbox.paypal.com/v2/payments/refunds/7NW87381K3762402X', method: 'GET' },
                    { rel: 'up', href: 'https://api.sandbox.paypal.com/v2/payments/captures/9XA12345BC6789012', method: 'GET' },
                  ],
                },
              }
            : { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } },
      },
      {
        method: 'GET',
        match: '/v2/payments/captures/9XA12345BC6789012',
        reply: () => ({ body: { id: '9XA12345BC6789012', status: 'COMPLETED', supplementary_data: { related_ids: { order_id: '5O190127TN364715T' } } } }),
      },
    ]);
  }

  it('sends the buyer back to PayPal after a declined card, then captures with a new request ID', async () => {
    const state = { orderId: '', declineFirst: true, reversed: false, captureRequestIds: [] as string[] };
    const { app } = makeCtx({ env: { DEV_FORCE_COUNTRY: 'DE' }, fetchFn: paypalFetch(state).fn });
    const agent = await loginAs(app, PLAYER_STEAM);
    const res = await agent.post('/api/checkout').set(ORIGIN).send({ kitId: 'builder', durationId: '30d', provider: 'paypal', acceptTerms: true });
    state.orderId = res.body.orderId;

    const first = await agent.get(`/api/payments/paypal/return?order=${state.orderId}&token=5O190127TN364715T`);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T');
    expect((await agent.get(`/api/orders/${state.orderId}`)).body.status).toBe('pending');

    const second = await agent.get(`/api/payments/paypal/return?order=${state.orderId}&token=5O190127TN364715T`);
    expect(second.headers.location).toBe(`/order/${state.orderId}`);
    expect((await agent.get(`/api/orders/${state.orderId}`)).body.status).toBe('paid');
    expect(new Set(state.captureRequestIds).size).toBe(2);
  });

  it('revokes access on a chargeback, which PayPal reports as a refund resource', async () => {
    const state = { orderId: '', declineFirst: false, reversed: false, captureRequestIds: [] as string[] };
    const { app } = makeCtx({ env: { DEV_FORCE_COUNTRY: 'DE' }, fetchFn: paypalFetch(state).fn });
    const agent = await loginAs(app, PLAYER_STEAM);
    const res = await agent.post('/api/checkout').set(ORIGIN).send({ kitId: 'builder', durationId: '30d', provider: 'paypal', acceptTerms: true });
    state.orderId = res.body.orderId;
    await agent.get(`/api/payments/paypal/return?order=${state.orderId}&token=5O190127TN364715T`);
    expect((await agent.get('/api/account')).body.kits).toHaveLength(1);

    const reversal = {
      id: 'WH-REV-1',
      event_type: 'PAYMENT.CAPTURE.REVERSED',
      resource: {
        id: '7NW87381K3762402X',
        status: 'COMPLETED',
        links: [{ rel: 'up', href: 'https://api.sandbox.paypal.com/v2/payments/captures/9XA12345BC6789012', method: 'GET' }],
      },
    };
    // Not confirmed by the API yet: a forged or premature event changes nothing.
    await supertest(app).post('/api/webhooks/paypal').send({ ...reversal, id: 'WH-REV-0' });
    expect((await agent.get(`/api/orders/${state.orderId}`)).body.status).toBe('paid');

    state.reversed = true;
    expect((await supertest(app).post('/api/webhooks/paypal').send(reversal)).status).toBe(200);
    expect((await agent.get(`/api/orders/${state.orderId}`)).body.status).toBe('disputed');
    expect((await agent.get('/api/account')).body.kits).toHaveLength(0);
  });
});

describe('Mercado Pago safety', () => {
  function fakeApi(payments: Record<string, MpPayment>) {
    const created: MpPreferenceBody[] = [];
    const api: MercadoPagoApi = {
      createPreference: vi.fn(async (body: MpPreferenceBody) => {
        created.push(body);
        return { id: 'PREF-1', init_point: 'https://www.mercadopago.cl/checkout/v1/redirect?pref_id=PREF-1' };
      }),
      getPayment: vi.fn(async (id: string) => {
        const p = payments[id];
        if (!p) throw new Error('not found');
        return p;
      }),
      searchPayments: vi.fn(async () => Object.values(payments)),
    };
    return { api, created };
  }

  function notify(app: Parameters<typeof supertest>[0], dataId: string, requestId: string) {
    const ts = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex');
    return supertest(app)
      .post(`/api/webhooks/mercadopago?data.id=${dataId}&type=payment`)
      .set('x-signature', `ts=${ts},v1=${v1}`)
      .set('x-request-id', requestId)
      .send({ type: 'payment', data: { id: dataId } });
  }

  it('creates checkout links that expire and relies on the signed panel webhook', async () => {
    const { api, created } = fakeApi({});
    // An https address is what used to switch notification_url on.
    const { ctx } = makeCtx({ env: { BASE_URL: 'https://store.example.com' }, mercadoPagoApi: api });
    const content = ctx.content();
    const kit = findKit(content, 'scrapper')!;
    const duration = findDuration(content, '30d')!;
    const user = upsertUser(ctx.db, PLAYER_STEAM, null, ctx.now());
    const quote = ctx.providers.mercadopago!.quote(priceCents(kit, duration));
    const order = ctx.orders.create({
      userId: user.id, steamId: PLAYER_STEAM, kit, duration, amountCents: priceCents(kit, duration),
      chargeAmount: quote.amount, chargeCurrency: quote.currency, provider: 'mercadopago', country: 'CL', ip: null,
    });
    await ctx.providers.mercadopago!.createCheckout({ order, kit, duration });
    const body = created[0]! as MpPreferenceBody & { notification_url?: string };
    expect(body.notification_url).toBeUndefined();
    expect(body.expires).toBe(true);
    expect(body.expiration_date_to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/);
    const ttl = Date.parse(body.expiration_date_to) - Date.parse(body.expiration_date_from);
    expect(ttl).toBe(3660 * 1000);
  });

  it('removes access while a dispute is open and flags a second payment', async () => {
    const payments: Record<string, MpPayment> = {};
    const { api } = fakeApi(payments);
    const { app } = makeCtx({ env: { DEV_FORCE_COUNTRY: 'CL' }, mercadoPagoApi: api });
    const agent = await loginAs(app, PLAYER_STEAM);
    const res = await agent.post('/api/checkout').set(ORIGIN).send({ kitId: 'scrapper', durationId: '30d', provider: 'mercadopago', acceptTerms: true });
    const orderId = res.body.orderId as string;
    payments['111'] = { id: 111, status: 'approved', external_reference: orderId, transaction_amount: 4750, currency_id: 'CLP' };
    await notify(app, '111', 'r1');
    expect((await agent.get(`/api/orders/${orderId}`)).body.status).toBe('paid');

    payments['222'] = { id: 222, status: 'approved', external_reference: orderId, transaction_amount: 4750, currency_id: 'CLP' };
    await notify(app, '222', 'r2');
    const order = await agent.get(`/api/orders/${orderId}`);
    expect(order.body.status).toBe('paid');
    expect(order.body.statusDetail).toContain('Second Mercado Pago payment 222');

    payments['111'] = { ...payments['111']!, status: 'in_mediation' };
    await notify(app, '111', 'r3');
    expect((await agent.get(`/api/orders/${orderId}`)).body.status).toBe('disputed');
    expect((await agent.get('/api/account')).body.kits).toHaveLength(0);
  });
});

describe('Orders held for review', () => {
  it('can be approved by an admin, which delivers the kit', async () => {
    const t = await stripeOrder();
    const underpaid = { ...t.paidSession, amount_subtotal: 100, amount_total: 100 };
    await t.post(stripeEvent(t.stripeClient, 'evt_u', 'checkout.session.completed', underpaid));
    expect((await t.agent.get(`/api/orders/${t.orderId}`)).body.status).toBe('review');

    expect((await t.agent.post(`/api/admin/orders/${t.orderId}/approve`).set(ORIGIN).send({})).status).toBe(403);
    const admin = await loginAs(t.app, ADMIN_STEAM);
    const approved = await admin.post(`/api/admin/orders/${t.orderId}/approve`).set(ORIGIN).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('paid');
    expect((await t.agent.get('/api/account')).body.kits).toHaveLength(1);
    expect((await admin.post(`/api/admin/orders/${t.orderId}/approve`).set(ORIGIN).send({})).status).toBe(409);
  });
});

describe('Steam login errors', () => {
  it('only ever puts a fixed code in the redirect', async () => {
    const { app } = makeCtx();
    const res = await supertest(app).get('/api/auth/steam/callback?openid.mode=cancel&state=x');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/\?login_error=(cancelled|expired|failed)$/);
    expect(BASE).toBe('http://localhost:3000');
  });
});
