import { MercadoPagoConfig, Payment, Preference, WebhookSignatureValidator, InvalidWebhookSignatureError } from 'mercadopago';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { Content } from '../content.js';
import { majorToMinor, minorToMajor } from '../lib/util.js';
import type { OrderRow, OrderService } from '../store/orders.js';
import { ProviderError, type CheckoutInput, type CheckoutResult, type ChargeQuote, type PaymentProvider } from './types.js';

export interface MpPayment {
  id?: number | string;
  status?: string;
  status_detail?: string;
  external_reference?: string;
  transaction_amount?: number;
  transaction_amount_refunded?: number;
  currency_id?: string;
}

export interface MpPreferenceBody {
  items: { id: string; title: string; description?: string; quantity: number; currency_id: string; unit_price: number }[];
  external_reference: string;
  metadata?: Record<string, string>;
  back_urls: { success: string; pending: string; failure: string };
  auto_return?: string;
  statement_descriptor?: string;
  expires: boolean;
  expiration_date_from: string;
  expiration_date_to: string;
}

/** Checkout links stay valid for one hour, like Stripe sessions, so old CLP prices cannot be paid later. */
const PREFERENCE_TTL_SECONDS = 3600;

/** ISO 8601 with milliseconds and an explicit offset, the format Mercado Pago documents. */
function mpDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace('Z', '+00:00');
}

/** Thin wrapper over the official SDK so tests can substitute it. */
export interface MercadoPagoApi {
  createPreference(body: MpPreferenceBody, idempotencyKey: string): Promise<{ id?: string; init_point?: string; sandbox_init_point?: string }>;
  getPayment(id: string): Promise<MpPayment>;
  searchPayments(externalReference: string): Promise<MpPayment[]>;
}

export function sdkMercadoPagoApi(accessToken: string): MercadoPagoApi {
  // The SDK merges per-request options into the shared config object, so a fresh
  // config per call keeps idempotency keys from leaking into later requests.
  const config = (idempotencyKey?: string) =>
    new MercadoPagoConfig({ accessToken, options: { timeout: 15_000, ...(idempotencyKey ? { idempotencyKey } : {}) } });
  return {
    async createPreference(body, idempotencyKey) {
      return new Preference(config(idempotencyKey)).create({ body });
    },
    async getPayment(id) {
      return (await new Payment(config()).get({ id })) as MpPayment;
    },
    async searchPayments(externalReference) {
      const res = await new Payment(config()).search({
        options: { external_reference: externalReference, sort: 'date_created', criteria: 'desc' },
      });
      return (res.results ?? []) as MpPayment[];
    },
  };
}

export interface MercadoPagoCredentials {
  accessToken: string;
  webhookSecret: string | null;
  useSandboxUrl: boolean;
}

export class MercadoPagoProvider implements PaymentProvider {
  readonly id = 'mercadopago' as const;
  readonly label = 'Mercado Pago';
  readonly description = 'Cards, Mercado Pago balance and local payment methods.';

  constructor(
    private readonly creds: MercadoPagoCredentials,
    private readonly api: MercadoPagoApi,
    private readonly config: AppConfig,
    private readonly content: () => Content,
    private readonly orders: OrderService,
    private readonly log: Logger,
  ) {}

  quote(amountCents: number): ChargeQuote {
    const mp = this.content().payments.mercadopago;
    const local = (amountCents / 100) * mp.usdRate;
    const rounded = Math.ceil(local / mp.roundTo - 1e-9) * mp.roundTo;
    return { amount: majorToMinor(rounded, mp.currency), currency: mp.currency };
  }

  async createCheckout({ order, kit, duration }: CheckoutInput): Promise<CheckoutResult> {
    const mp = this.content().payments.mercadopago;
    const back = `${this.config.baseUrl}/order/${order.id}`;
    const body: MpPreferenceBody = {
      items: [
        {
          id: `${kit.id}:${duration.id}`,
          title: `${kit.name} Kit (${duration.label})`,
          ...(kit.tagline ? { description: kit.tagline } : {}),
          quantity: 1,
          currency_id: order.charge_currency,
          unit_price: minorToMajor(order.charge_amount, order.charge_currency),
        },
      ],
      external_reference: order.id,
      metadata: { order_id: order.id, steam_id: order.steam_id },
      back_urls: { success: back, pending: back, failure: back },
      auto_return: 'approved',
      ...(mp.statementDescriptor ? { statement_descriptor: mp.statementDescriptor } : {}),
      expires: true,
      expiration_date_from: mpDate(order.created_at - 60),
      expiration_date_to: mpDate(order.created_at + PREFERENCE_TTL_SECONDS),
    };
    // No notification_url: notifications come from the webhook configured in the Mercado Pago
    // panel, which signs them with MERCADOPAGO_WEBHOOK_SECRET. A per-preference URL would take
    // precedence and is not documented as signed.

    let pref: Awaited<ReturnType<MercadoPagoApi['createPreference']>>;
    try {
      pref = await this.api.createPreference(body, `pref-${order.id}`);
    } catch (err) {
      throw new ProviderError('mercadopago', `Mercado Pago preference failed: ${(err as Error).message}`);
    }
    const url = this.creds.useSandboxUrl ? pref.sandbox_init_point : pref.init_point;
    if (!pref.id || !url) throw new ProviderError('mercadopago', 'Mercado Pago did not return a checkout URL');
    return { providerRef: pref.id, redirectUrl: url };
  }

  async refresh(order: OrderRow, hint?: { paymentId?: string | null }): Promise<void> {
    if (hint?.paymentId && /^\d{1,20}$/.test(hint.paymentId)) {
      const payment = await this.api.getPayment(hint.paymentId);
      this.applyPayment(payment);
      return;
    }
    const payments = await this.api.searchPayments(order.id);
    // Oldest first so the final state wins.
    for (const p of [...payments].reverse()) this.applyPayment(p);
  }

  applyPayment(payment: MpPayment): void {
    const orderId = payment.external_reference;
    if (!orderId) return;
    const order = this.orders.get(orderId);
    if (!order || order.provider !== 'mercadopago') {
      this.log.warn({ orderId, payment: payment.id }, 'Mercado Pago payment for unknown order');
      return;
    }
    const paymentId = payment.id === undefined ? null : String(payment.id);
    const ownPayment = paymentId !== null && order.provider_payment_id === paymentId;
    switch (payment.status) {
      case 'approved': {
        const currency = (payment.currency_id ?? '').toUpperCase();
        if (order.status === 'paid') {
          if (paymentId && order.provider_payment_id && !ownPayment) {
            this.orders.flag(order.id, `Second Mercado Pago payment ${paymentId} for this order: refund it in Mercado Pago`);
          } else if (ownPayment && (payment.transaction_amount_refunded ?? 0) > 0) {
            this.orders.flag(order.id, `Partially refunded in Mercado Pago: ${payment.transaction_amount_refunded} ${currency}`);
          }
          return;
        }
        const paid = majorToMinor(Number(payment.transaction_amount ?? NaN), currency || order.charge_currency);
        if (currency !== order.charge_currency || paid !== order.charge_amount) {
          this.orders.markReview(order.id, `Mercado Pago amount mismatch: ${payment.transaction_amount} ${currency}`);
          return;
        }
        this.orders.fulfill(order.id, { providerPaymentId: paymentId, paidAmount: paid, paidCurrency: currency });
        return;
      }
      case 'pending':
      case 'in_process':
      case 'authorized':
        if (paymentId && !order.provider_payment_id) this.orders.setProviderPaymentId(order.id, paymentId);
        return;
      case 'rejected':
        this.orders.markUnpaid(order.id, 'failed', `Mercado Pago rejected (${payment.status_detail ?? 'no detail'})`);
        return;
      case 'cancelled':
        this.orders.markUnpaid(order.id, 'canceled', 'Mercado Pago payment cancelled');
        return;
      case 'refunded':
        if (ownPayment) this.orders.reverse(order.id, 'refunded', 'Refunded in Mercado Pago');
        return;
      case 'charged_back':
        if (ownPayment) this.orders.reverse(order.id, 'disputed', 'Mercado Pago chargeback');
        return;
      case 'in_mediation':
        // The buyer opened a dispute. Same policy as Stripe: access is removed while it is open.
        if (ownPayment) this.orders.reverse(order.id, 'disputed', 'Mercado Pago dispute opened');
        return;
      default:
        return;
    }
  }

  /** Validates the x-signature header. Throws InvalidWebhookSignatureError on failure. */
  verifySignature(headers: { xSignature: unknown; xRequestId: unknown }, dataId: unknown): void {
    if (!this.creds.webhookSecret) throw new Error('Mercado Pago webhook secret is not configured');
    WebhookSignatureValidator.validate({
      xSignature: headers.xSignature as string | undefined,
      xRequestId: headers.xRequestId as string | undefined,
      dataId: dataId as string | undefined,
      secret: this.creds.webhookSecret,
    });
  }

  async handleNotification(type: string | undefined, dataId: string | undefined): Promise<void> {
    if (type !== 'payment' || !dataId || !/^\d{1,20}$/.test(dataId)) return;
    const payment = await this.api.getPayment(dataId);
    this.applyPayment(payment);
  }
}

export { InvalidWebhookSignatureError };
