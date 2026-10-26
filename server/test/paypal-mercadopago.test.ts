import crypto from 'node:crypto';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { MercadoPagoApi, MpPayment, MpPreferenceBody } from '../src/payments/mercadopago.js';
import { MP_WEBHOOK_SECRET, ORIGIN, PLAYER_STEAM, loginAs, makeCtx, scriptedFetch } from './helpers.js';

describe('PayPal', () => {
  function paypalFetch(state: { captured: boolean; refunded: boolean }) {
    return scriptedFetch([
      { method: 'POST', match: '/v1/oauth2/token', reply: () => ({ body: { access_token: 'A21', expires_in: 32000 } }) },
      {
        method: 'POST',
        match: /\/v2\/checkout\/orders$/,
        reply: (_url, init) => {
          const body = JSON.parse(String(init?.body));
          return {
            status: 200,
            body: {
              id: '5O190127TN364715T',
              status: 'PAYER_ACTION_REQUIRED',
              links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T' }],
              echo: body,
            },
          };
        },
      },
      {
        method: 'POST',
        match: '/v2/checkout/orders/5O190127TN364715T/capture',
        reply: (_url, init) => {
          state.captured = true;
          return {
            status: 201,
            body: {
              id: '5O190127TN364715T',
              status: 'COMPLETED',
              headers: init?.headers,
              purchase_units: [
                {
                  reference_id: 'x',
                  payments: { captures: [{ id: '9XA12345BC6789012', status: 'COMPLETED', amount: { currency_code: 'USD', value: '20.00' }, custom_id: state.orderId }] },
                },
              ],
            },
          };
        },
      },
      {
        method: 'GET',
        match: '/v2/payments/captures/9XA12345BC6789012',
        reply: () => ({ body: { id: '9XA12345BC6789012', status: state.refunded ? 'REFUNDED' : 'COMPLETED' } }),
      },
    ]);
  }

  it('creates an order, captures on return and revokes on refund', async () => {
    const state = { captured: false, refunded: false, orderId: '' } as { captured: boolean; refunded: boolean; orderId: string };
    const pf = paypalFetch(state);
    const { app } = makeCtx({ env: { DEV_FORCE_COUNTRY: 'DE' }, fetchFn: pf.fn });
    const agent = await loginAs(app, PLAYER_STEAM);

    const options = await agent.get('/api/checkout/options?kitId=builder&durationId=30d');
    expect(options.body.providers.map((p: { id: string }) => p.id)).toEqual(['stripe', 'paypal']);

    const res = await agent.post('/api/checkout').set(ORIGIN).send({ kitId: 'builder', durationId: '30d', provider: 'paypal', acceptTerms: true });
    expect(res.status).toBe(200);
    expect(res.body.redirectUrl).toContain('sandbox.paypal.com');
    state.orderId = res.body.orderId;

    const createCall = pf.calls.find((c) => c.url.endsWith('/v2/checkout/orders'))!;
    const sent = JSON.parse(String(createCall.init?.body));
    expect(sent.purchase_units[0].amount).toEqual({ currency_code: 'USD', value: '20.00' });
    expect(sent.purchase_units[0].custom_id).toBe(state.orderId);
    expect(sent.payment_source.paypal.experience_context.return_url).toContain(`/api/payments/paypal/return?order=${state.orderId}`);
    expect((createCall.init?.headers as Record<string, string>)['PayPal-Request-Id']).toBe(`create-${state.orderId}`);

    const back = await agent.get(`/api/payments/paypal/return?order=${state.orderId}&token=5O190127TN364715T&PayerID=X`);
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe(`/order/${state.orderId}`);
    expect(state.captured).toBe(true);
    expect((await agent.get(`/api/orders/${state.orderId}`)).body.status).toBe('paid');

    state.refunded = true;
    const hook = await supertest(app)
      .post('/api/webhooks/paypal')
      .send({
        id: 'WH-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: { id: 'REF-1', links: [{ rel: 'up', href: 'https://api.sandbox.paypal.com/v2/payments/captures/9XA12345BC6789012', method: 'GET' }] },
      });
    expect(hook.status).toBe(200);
    expect((await agent.get(`/api/orders/${state.orderId}`)).body.status).toBe('refunded');
  });

  it('ignores a return URL whose token does not match the order', async () => {
    const state = { captured: false, refunded: false, orderId: '' } as { captured: boolean; refunded: boolean; orderId: string };
    const pf = paypalFetch(state);
    const { app } = makeCtx({ env: { DEV_FORCE_COUNTRY: 'DE' }, fetchFn: pf.fn });
    const agent = await loginAs(app, PLAYER_STEAM);
    const res = await agent.post('/api/checkout').set(ORIGIN).send({ kitId: 'builder', durationId: '30d', provider: 'paypal', acceptTerms: true });
    await agent.get(`/api/payments/paypal/return?order=${res.body.orderId}&token=SOMEONE-ELSE`);
    expect(state.captured).toBe(false);
  });
});

describe('Mercado Pago', () => {
  function fakeApi(payments: Record<string, MpPayment>) {
    const created: MpPreferenceBody[] = [];
    const api: MercadoPagoApi = {
      createPreference: vi.fn(async (body: MpPreferenceBody) => {
        created.push(body);
        return { id: 'PREF-1', init_point: 'https://www.mercadopago.cl/checkout/v1/redirect?pref_id=PREF-1', sandbox_init_point: 'https://sandbox.mercadopago.cl/x' };
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

  function sign(dataId: string, requestId: string, ts = Math.floor(Date.now() / 1000)) {
    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const v1 = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
    return `ts=${ts},v1=${v1}`;
  }

  it('routes Chile to Mercado Pago and charges CLP', async () => {
    const payments: Record<string, MpPayment> = {};
    const { api, created } = fakeApi(payments);
    const { app } = makeCtx({ env: { DEV_FORCE_COUNTRY: 'CL' }, mercadoPagoApi: api });
    const agent = await loginAs(app, PLAYER_STEAM);
    const options = await agent.get('/api/checkout/options?kitId=scrapper&durationId=30d');
    expect(options.body.providers).toEqual([
      expect.objectContaining({ id: 'mercadopago', charge: { amount: 4750, currency: 'CLP', display: 'CLP 4,750' } }),
    ]);

    const res = await agent.post('/api/checkout').set(ORIGIN).send({ kitId: 'scrapper', durationId: '30d', provider: 'mercadopago', acceptTerms: true });
    expect(res.status).toBe(200);
    expect(res.body.redirectUrl).toContain('pref_id=PREF-1');
    const body = created[0]!;
    expect(body.items[0]).toMatchObject({ currency_id: 'CLP', unit_price: 4750, quantity: 1 });
    expect(body.external_reference).toBe(res.body.orderId);
    expect(body.notification_url).toBeUndefined(); // http base URL in tests
  });

  it('fulfills only from a correctly signed webhook and checks the amount', async () => {
    const payments: Record<string, MpPayment> = {};
    const { api } = fakeApi(payments);
    const { app } = makeCtx({ env: { DEV_FORCE_COUNTRY: 'CL' }, mercadoPagoApi: api });
    const agent = await loginAs(app, PLAYER_STEAM);
    const res = await agent.post('/api/checkout').set(ORIGIN).send({ kitId: 'scrapper', durationId: '30d', provider: 'mercadopago', acceptTerms: true });
    const orderId = res.body.orderId as string;
    payments['123456'] = { id: 123456, status: 'approved', external_reference: orderId, transaction_amount: 4750, currency_id: 'CLP' };

    const bad = await supertest(app)
      .post('/api/webhooks/mercadopago?data.id=123456&type=payment')
      .set('x-signature', 'ts=1,v1=00')
      .set('x-request-id', 'req-1')
      .send({ type: 'payment', data: { id: '123456' } });
    expect(bad.status).toBe(401);
    expect((await agent.get(`/api/orders/${orderId}`)).body.status).toBe('pending');

    const good = await supertest(app)
      .post('/api/webhooks/mercadopago?data.id=123456&type=payment')
      .set('x-signature', sign('123456', 'req-2'))
      .set('x-request-id', 'req-2')
      .send({ type: 'payment', action: 'payment.updated', data: { id: '123456' } });
    expect(good.status).toBe(200);
    expect((await agent.get(`/api/orders/${orderId}`)).body.status).toBe('paid');

    payments['123456'] = { ...payments['123456']!, status: 'refunded' };
    await supertest(app)
      .post('/api/webhooks/mercadopago?data.id=123456&type=payment')
      .set('x-signature', sign('123456', 'req-3'))
      .set('x-request-id', 'req-3')
      .send({ type: 'payment', data: { id: '123456' } });
    expect((await agent.get(`/api/orders/${orderId}`)).body.status).toBe('refunded');
  });

  it('puts underpaid orders in review', async () => {
    const payments: Record<string, MpPayment> = {};
    const { api } = fakeApi(payments);
    const { app } = makeCtx({ env: { DEV_FORCE_COUNTRY: 'AR' }, mercadoPagoApi: api });
    const agent = await loginAs(app, PLAYER_STEAM);
    const res = await agent.post('/api/checkout').set(ORIGIN).send({ kitId: 'scrapper', durationId: '30d', provider: 'mercadopago', acceptTerms: true });
    payments['999'] = { id: 999, status: 'approved', external_reference: res.body.orderId, transaction_amount: 10, currency_id: 'CLP' };
    const refreshed = await agent.post(`/api/orders/${res.body.orderId}/refresh`).set(ORIGIN).send({ paymentId: '999' });
    expect(refreshed.body.status).toBe('review');
  });
});
