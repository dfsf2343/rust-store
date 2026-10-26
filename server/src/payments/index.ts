import Stripe from 'stripe';
import type { Logger } from 'pino';
import type { AppConfig, ProviderId } from '../config.js';
import type { Content } from '../content.js';
import type { OrderService } from '../store/orders.js';
import { MercadoPagoProvider, sdkMercadoPagoApi, type MercadoPagoApi } from './mercadopago.js';
import { PayPalProvider } from './paypal.js';
import { StripeProvider } from './stripe.js';
import type { PaymentProvider } from './types.js';

export interface Providers {
  stripe: StripeProvider | null;
  paypal: PayPalProvider | null;
  mercadopago: MercadoPagoProvider | null;
  enabled: ReadonlySet<ProviderId>;
  get(id: ProviderId): PaymentProvider | null;
}

export interface ProviderOverrides {
  stripeClient?: Stripe;
  fetchFn?: typeof fetch;
  mercadoPagoApi?: MercadoPagoApi;
}

function createStripeClient(secretKey: string, apiBase: URL | null): Stripe {
  if (!apiBase) return new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
  return new Stripe(secretKey, {
    host: apiBase.hostname,
    port: apiBase.port || (apiBase.protocol === 'https:' ? 443 : 80),
    protocol: apiBase.protocol === 'https:' ? 'https' : 'http',
    maxNetworkRetries: 0,
  });
}

export function createProviders(
  config: AppConfig,
  content: () => Content,
  orders: OrderService,
  log: Logger,
  now: () => number,
  overrides: ProviderOverrides = {},
): Providers {
  const stripe = config.stripe
    ? new StripeProvider(
        overrides.stripeClient ?? createStripeClient(config.stripe.secretKey, config.stripe.apiBase),
        config.stripe.webhookSecret,
        config,
        content,
        orders,
        log.child({ provider: 'stripe' }),
        now,
      )
    : null;
  const paypal = config.paypal
    ? new PayPalProvider(config.paypal, config, content, orders, log.child({ provider: 'paypal' }), overrides.fetchFn ?? fetch)
    : null;
  const mercadopago = config.mercadopago
    ? new MercadoPagoProvider(
        config.mercadopago,
        overrides.mercadoPagoApi ?? sdkMercadoPagoApi(config.mercadopago.accessToken),
        config,
        content,
        orders,
        log.child({ provider: 'mercadopago' }),
      )
    : null;

  const enabled = new Set<ProviderId>();
  if (stripe) enabled.add('stripe');
  if (paypal) enabled.add('paypal');
  if (mercadopago) enabled.add('mercadopago');

  return {
    stripe,
    paypal,
    mercadopago,
    enabled,
    get(id) {
      if (id === 'stripe') return stripe;
      if (id === 'paypal') return paypal;
      if (id === 'mercadopago') return mercadopago;
      return null;
    },
  };
}
