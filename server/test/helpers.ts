import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import Stripe from 'stripe';
import supertest from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createNodeContext, type NodeAppContext } from '../src/context-node.js';
import type { MercadoPagoApi } from '../src/payments/mercadopago.js';

export const BASE = 'http://localhost:3000';
export const ORIGIN = { Origin: BASE };
export const PLUGIN_SECRET = 'test-plugin-secret-0123456789abcdef0123';
export const STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
export const MP_WEBHOOK_SECRET = 'mp-test-webhook-secret';
export const ADMIN_STEAM = '76561198000000001';
export const PLAYER_STEAM = '76561198000000002';

export interface TestOptions {
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  mercadoPagoApi?: MercadoPagoApi;
  stripeClient?: Stripe;
  now?: () => number;
}

export function makeCtx(opts: TestOptions = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    BASE_URL: BASE,
    CONFIG_DIR: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config'),
    DATA_DIR: dataDir,
    WEB_DIST_DIR: path.join(dataDir, 'no-web'),
    PLUGIN_SECRET,
    ADMIN_STEAM_IDS: ADMIN_STEAM,
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    STRIPE_WEBHOOK_SECRET,
    PAYPAL_CLIENT_ID: 'pp-client',
    PAYPAL_CLIENT_SECRET: 'pp-secret',
    PAYPAL_ENV: 'sandbox',
    MERCADOPAGO_ACCESS_TOKEN: 'TEST-mp-token',
    MERCADOPAGO_WEBHOOK_SECRET: MP_WEBHOOK_SECRET,
    GEOIP_AUTO_UPDATE: 'false',
    DEV_LOGIN: 'true',
    LOG_LEVEL: 'silent',
    ...opts.env,
  });
  const stripeClient = opts.stripeClient ?? new Stripe('sk_test_dummy');
  // PaymentIntents the fake Stripe client knows; unknown IDs come back as a clean, unrefunded payment.
  const paymentIntents = new Map<string, PaymentIntentFixture>();
  if (!opts.stripeClient) {
    (stripeClient.paymentIntents as unknown as { retrieve: (id: string) => Promise<unknown> }).retrieve = async (id: string) => {
      const fx = paymentIntents.get(id) ?? {};
      return {
        id,
        object: 'payment_intent',
        metadata: fx.metadata ?? {},
        latest_charge: {
          id: `ch_${id}`,
          object: 'charge',
          amount: fx.amount ?? 5000,
          currency: 'usd',
          refunded: fx.refunded ?? false,
          disputed: fx.disputed ?? false,
          amount_refunded: fx.amountRefunded ?? 0,
        },
      };
    };
  }
  const ctx: NodeAppContext = createNodeContext(config, {
    dbFile: ':memory:',
    logger: pino({ level: 'silent' }),
    stripeClient,
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    ...(opts.mercadoPagoApi ? { mercadoPagoApi: opts.mercadoPagoApi } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const app = createApp(ctx);
  return { ctx, app, stripeClient, dataDir, paymentIntents };
}

export interface PaymentIntentFixture {
  metadata?: Record<string, string>;
  amount?: number;
  refunded?: boolean;
  disputed?: boolean;
  amountRefunded?: number;
}

export async function loginAs(app: ReturnType<typeof createApp>, steamId: string) {
  const agent = supertest.agent(app);
  const res = await agent.post('/api/auth/dev-login').set(ORIGIN).send({ steamId });
  if (res.status !== 200) throw new Error(`dev login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

/** A tiny scripted fetch: matches requests in order of registration by method + URL substring. */
export function scriptedFetch(routes: { method: string; match: string | RegExp; reply: (url: string, init: RequestInit | undefined) => { status?: number; body: unknown } }[]) {
  const calls: { method: string; url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, init });
    const route = routes.find((r) => r.method === method && (typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url)));
    if (!route) return new Response(JSON.stringify({ error: 'no route', url }), { status: 599 });
    const { status = 200, body } = route.reply(url, init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' },
    });
  }) as typeof fetch;
  return { fn, calls };
}
