import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { ORIGIN, PLAYER_STEAM, loginAs, makeCtx } from './helpers.js';

/**
 * Runs against stripe-mock (github.com/stripe/stripe-mock), which validates request
 * parameters against Stripe's OpenAPI spec. Start it and set STRIPE_MOCK_PORT to enable.
 */
const port = process.env.STRIPE_MOCK_PORT;

describe.skipIf(!port)('Stripe API contract (stripe-mock)', () => {
  it('accepts the Checkout Session we create, including tax and promo options', async () => {
    const client = new Stripe('sk_test_123', { host: 'localhost', port: Number(port), protocol: 'http', maxNetworkRetries: 0 });
    const { app, ctx } = makeCtx({ env: { DEV_FORCE_COUNTRY: 'US' }, stripeClient: client });
    const content = ctx.content();
    content.payments.stripe.allowPromotionCodes = true;
    content.payments.stripe.automaticTax = true;
    const agent = await loginAs(app, PLAYER_STEAM);
    for (const kitId of ['scrapper', 'overlord']) {
      const res = await agent.post('/api/checkout').set(ORIGIN).send({ kitId, durationId: 'lifetime', provider: 'stripe', acceptTerms: true });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(typeof res.body.redirectUrl).toBe('string');
    }
    // Retrieve also goes through the real SDK path.
    const order = ctx.db.prepare(`SELECT * FROM orders WHERE provider_ref IS NOT NULL LIMIT 1`).get() as { id: string };
    const refreshed = await agent.post(`/api/orders/${order.id}/refresh`).set(ORIGIN).send({});
    expect(refreshed.status).toBe(200);
  });
});
