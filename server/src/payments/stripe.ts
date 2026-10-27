import Stripe from 'stripe';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { Content } from '../content.js';
import { isFulfillable, type OrderRow, type OrderService } from '../store/orders.js';
import { ProviderError, type CheckoutInput, type CheckoutResult, type ChargeQuote, type PaymentProvider } from './types.js';

type Session = Stripe.Checkout.Session;

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

export class StripeProvider implements PaymentProvider {
  readonly id = 'stripe' as const;
  readonly label = 'Card / Apple Pay / Google Pay';
  readonly description = 'Secure checkout powered by Stripe.';

  constructor(
    readonly client: Stripe,
    private readonly webhookSecret: string | null,
    private readonly config: AppConfig,
    private readonly content: () => Content,
    private readonly orders: OrderService,
    private readonly log: Logger,
    private readonly now: () => number,
  ) {}

  quote(amountCents: number): ChargeQuote {
    return { amount: amountCents, currency: 'USD' };
  }

  async createCheckout({ order, kit, duration }: CheckoutInput): Promise<CheckoutResult> {
    const opts = this.content().payments.stripe;
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      client_reference_id: order.id,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: order.charge_amount,
            product_data: {
              name: `${kit.name} Kit (${duration.label})`,
              ...(kit.tagline ? { description: kit.tagline } : {}),
              metadata: { kitId: kit.id, durationId: duration.id },
            },
          },
        },
      ],
      metadata: { orderId: order.id, steamId: order.steam_id, kitId: kit.id, durationId: duration.id },
      payment_intent_data: {
        description: `${kit.name} Kit (${duration.label}) for Steam ${order.steam_id}`,
        metadata: { orderId: order.id, steamId: order.steam_id },
      },
      success_url: `${this.config.baseUrl}/order/${order.id}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.config.baseUrl}/store/${kit.id}?canceled=1`,
      expires_at: this.now() + 60 * 60,
      submit_type: 'pay',
    };
    if (opts.allowPromotionCodes) params.allow_promotion_codes = true;
    if (opts.automaticTax) params.automatic_tax = { enabled: true };

    let session: Stripe.Checkout.Session;
    try {
      session = await this.client.checkout.sessions.create(params, { idempotencyKey: `checkout-${order.id}` });
    } catch (err) {
      // Surface Stripe's own reason (for example an account that cannot take payments yet) in the logs.
      const e = err as { message?: string; statusCode?: number; code?: string; type?: string };
      throw new ProviderError('stripe', `Stripe checkout failed: ${e.message ?? 'unknown error'}`, e.statusCode, { code: e.code, type: e.type });
    }
    if (!session.url) throw new Error('Stripe did not return a checkout URL');
    return { providerRef: session.id, redirectUrl: session.url };
  }

  async refresh(order: OrderRow): Promise<void> {
    if (!order.provider_ref) return;
    const session = await this.client.checkout.sessions.retrieve(order.provider_ref);
    await this.applySession(session);
  }

  /**
   * A Checkout Session keeps saying "paid" after a refund or dispute, so before delivering
   * we look at the payment's charge. Returns why the order must not be delivered, if so.
   */
  private async chargeProblem(paymentIntentId: string): Promise<{ status: 'refunded' | 'disputed' | 'review'; reason: string } | null> {
    const intent = await this.client.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    const charge = intent.latest_charge;
    if (!charge || typeof charge === 'string') return null;
    if (charge.disputed) return { status: 'disputed', reason: 'Stripe dispute opened before the kit was delivered' };
    if (charge.refunded) return { status: 'refunded', reason: 'Refunded in Stripe before the kit was delivered' };
    if (charge.amount_refunded > 0) return { status: 'review', reason: `Partially refunded in Stripe (${charge.amount_refunded} ${charge.currency.toUpperCase()}) before delivery` };
    return null;
  }

  /** Applies a Checkout Session (from a verified webhook or a direct API read) to its order. */
  async applySession(session: Session): Promise<void> {
    const orderId = session.client_reference_id ?? session.metadata?.orderId ?? null;
    if (!orderId) return;
    const order = this.orders.get(orderId);
    if (!order || order.provider !== 'stripe') {
      this.log.warn({ orderId, session: session.id }, 'Stripe session for unknown order');
      return;
    }
    if (order.provider_ref && order.provider_ref !== session.id) {
      this.log.warn({ orderId, expected: order.provider_ref, got: session.id }, 'Stripe session does not match order');
      return;
    }
    const paymentIntentId = idOf(session.payment_intent);

    if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
      // Delivered, refunded, disputed or held for review: nothing left to do here.
      if (!isFulfillable(order.status)) return;
      const currency = (session.currency ?? '').toUpperCase();
      if (currency !== order.charge_currency || session.amount_subtotal !== order.charge_amount) {
        this.orders.markReview(order.id, `Stripe amount mismatch: subtotal ${session.amount_subtotal} ${currency}, expected ${order.charge_amount} ${order.charge_currency}`);
        return;
      }
      const problem = paymentIntentId ? await this.chargeProblem(paymentIntentId) : null;
      if (problem?.status === 'review') {
        this.orders.markReview(order.id, problem.reason);
        return;
      }
      if (problem) {
        this.orders.reverse(order.id, problem.status, problem.reason);
        return;
      }
      this.orders.fulfill(order.id, {
        providerPaymentId: paymentIntentId,
        paidAmount: session.amount_total ?? session.amount_subtotal ?? 0,
        paidCurrency: currency,
      });
      return;
    }
    if (paymentIntentId && !order.provider_payment_id) this.orders.setProviderPaymentId(order.id, paymentIntentId);
    if (session.status === 'expired') this.orders.markUnpaid(order.id, 'expired', 'Stripe checkout expired');
  }

  get webhooksEnabled(): boolean {
    return this.webhookSecret !== null;
  }

  /**
   * Verifies the Stripe-Signature header. Rejects with a signature error when it does not match.
   * Async because the Workers build of the SDK verifies with Web Crypto.
   */
  async verifyEvent(rawBody: Buffer, signature: string | undefined): Promise<Stripe.Event> {
    if (!this.webhookSecret) throw new Error('Stripe webhook secret is not configured');
    return this.client.webhooks.constructEventAsync(rawBody, signature ?? '', this.webhookSecret);
  }

  /**
   * Finds the order behind a PaymentIntent. Delivered orders store the PaymentIntent ID;
   * for undelivered ones the order ID is read from the PaymentIntent's metadata.
   */
  private async orderForPaymentIntent(paymentIntentId: string): Promise<OrderRow | undefined> {
    const known = this.orders.findByProviderPayment('stripe', paymentIntentId);
    if (known) return known;
    const intent = await this.client.paymentIntents.retrieve(paymentIntentId);
    const orderId = intent.metadata?.['orderId'];
    const order = orderId ? this.orders.get(orderId) : undefined;
    return order?.provider === 'stripe' ? order : undefined;
  }

  async processEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await this.applySession(event.data.object);
        break;
      case 'checkout.session.async_payment_failed': {
        const orderId = event.data.object.client_reference_id;
        if (orderId) this.orders.markUnpaid(orderId, 'failed', 'Delayed payment failed');
        break;
      }
      case 'checkout.session.expired': {
        const orderId = event.data.object.client_reference_id;
        if (orderId) this.orders.markUnpaid(orderId, 'expired', 'Stripe checkout expired');
        break;
      }
      case 'charge.refunded': {
        const charge = event.data.object;
        const pi = idOf(charge.payment_intent);
        if (!pi) break;
        const order = await this.orderForPaymentIntent(pi);
        if (!order) break;
        if (charge.refunded) {
          this.orders.reverse(order.id, 'refunded', 'Refunded in Stripe');
        } else if (order.status === 'paid') {
          // Partial refunds keep access; staff decide what to do.
          this.orders.flag(order.id, `Partially refunded in Stripe: ${charge.amount_refunded} ${charge.currency.toUpperCase()} of ${charge.amount}`);
        }
        break;
      }
      case 'charge.dispute.created': {
        const dispute = event.data.object;
        const pi = idOf(dispute.payment_intent);
        if (!pi) break;
        const order = await this.orderForPaymentIntent(pi);
        if (order) this.orders.reverse(order.id, 'disputed', `Stripe dispute opened (${dispute.reason})`);
        break;
      }
      default:
        break;
    }
  }
}
