import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { Content } from '../content.js';
import { majorToMinor, randomToken } from '../lib/util.js';
import type { OrderRow, OrderService } from '../store/orders.js';
import { ProviderError, type CheckoutInput, type CheckoutResult, type ChargeQuote, type PaymentProvider } from './types.js';

const CAPTURE_LINK_RE = /\/v2\/payments\/captures\/([A-Za-z0-9-]+)/;
const PAYPAL_URL_RE = /^https:\/\/(www\.)?(sandbox\.)?paypal\.com\//;

/** Refunds and reversals point at their capture through the `up` link. */
function captureIdFromLinks(links: PayPalLink[] | undefined): string | undefined {
  const up = links?.find((l) => l.rel === 'up' && CAPTURE_LINK_RE.test(l.href));
  return up ? CAPTURE_LINK_RE.exec(up.href)?.[1] : undefined;
}

interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}
interface PayPalMoney {
  currency_code: string;
  value: string;
}
interface PayPalCapture {
  id: string;
  status: string;
  amount?: PayPalMoney;
  custom_id?: string;
  links?: PayPalLink[];
  supplementary_data?: { related_ids?: { order_id?: string } };
}
interface PayPalOrder {
  id: string;
  status: string;
  links?: PayPalLink[];
  purchase_units?: {
    reference_id?: string;
    custom_id?: string;
    payments?: { captures?: PayPalCapture[] };
  }[];
}
interface PayPalRefund {
  id: string;
  status: string;
  links?: PayPalLink[];
}
interface PayPalErrorBody {
  name?: string;
  details?: { issue?: string; description?: string }[];
  links?: PayPalLink[];
}

export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
  env: 'sandbox' | 'live';
}

export class PayPalProvider implements PaymentProvider {
  readonly id = 'paypal' as const;
  readonly label = 'PayPal';
  readonly description = 'Pay with your PayPal balance or a linked card.';
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly creds: PayPalCredentials,
    private readonly config: AppConfig,
    private readonly content: () => Content,
    private readonly orders: OrderService,
    private readonly log: Logger,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get apiBase(): string {
    return this.creds.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  }

  quote(amountCents: number): ChargeQuote {
    return { amount: amountCents, currency: 'USD' };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString('base64');
    const res = await this.fetchFn(`${this.apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new ProviderError('paypal', `PayPal authentication failed (${res.status})`, res.status, await res.text().catch(() => ''));
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new ProviderError('paypal', 'PayPal did not return an access token');
    this.token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 300) * 1000 };
    return data.access_token;
  }

  private async api<T>(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T }> {
    const token = await this.accessToken();
    const res = await this.fetchFn(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    return { status: res.status, data: data as T };
  }

  async createCheckout({ order, kit, duration }: CheckoutInput): Promise<CheckoutResult> {
    const content = this.content();
    const brand = (content.payments.paypal.brandName ?? content.site.name).slice(0, 127);
    const { status, data } = await this.api<PayPalOrder>(
      'POST',
      '/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: order.id,
            custom_id: order.id,
            description: `${kit.name} Kit (${duration.label})`.slice(0, 127),
            amount: { currency_code: 'USD', value: (order.charge_amount / 100).toFixed(2) },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: brand,
              shipping_preference: 'NO_SHIPPING',
              user_action: 'PAY_NOW',
              return_url: `${this.config.baseUrl}/api/payments/paypal/return?order=${encodeURIComponent(order.id)}`,
              cancel_url: `${this.config.baseUrl}/store/${kit.id}?canceled=1`,
            },
          },
        },
      },
      { 'PayPal-Request-Id': `create-${order.id}` },
    );
    if (status >= 300 || !data.id) throw new ProviderError('paypal', `PayPal order creation failed (${status})`, status, data);
    const link = data.links?.find((l) => l.rel === 'payer-action') ?? data.links?.find((l) => l.rel === 'approve');
    if (!link) throw new ProviderError('paypal', 'PayPal did not return an approval link', status, data);
    return { providerRef: data.id, redirectUrl: link.href };
  }

  /**
   * Captures an approved order. Safe to repeat: PayPal never captures an order twice and
   * answers ORDER_ALREADY_CAPTURED, after which we read the order instead. Each attempt
   * gets its own PayPal-Request-Id because PayPal replays the stored result for a reused
   * ID, which would repeat a decline after the buyer picked another card.
   * Returns a PayPal URL when the buyer has to choose another way to pay.
   */
  async capture(order: OrderRow): Promise<{ retryUrl: string | null }> {
    if (!order.provider_ref) return { retryUrl: null };
    const { status, data } = await this.api<PayPalOrder & PayPalErrorBody>(
      'POST',
      `/v2/checkout/orders/${encodeURIComponent(order.provider_ref)}/capture`,
      undefined,
      { 'PayPal-Request-Id': `capture-${order.id}-${randomToken(9)}`, Prefer: 'return=representation' },
    );
    if (status === 422 && data.details?.some((d) => d.issue === 'INSTRUMENT_DECLINED')) {
      this.log.info({ orderId: order.id }, 'PayPal declined the funding source; sending the buyer back to PayPal');
      return { retryUrl: await this.retryLink(order, data.links) };
    }
    if (status === 422 || status === 409) {
      // Typically already captured or not yet approved: read the order instead.
      await this.sync(order, false);
      return { retryUrl: null };
    }
    if (status >= 300) throw new ProviderError('paypal', `PayPal capture failed (${status})`, status, data);
    this.applyOrder(order, data);
    return { retryUrl: null };
  }

  /** Where to send a buyer whose card was declined: the link in the error, else the order's approval link. */
  private async retryLink(order: OrderRow, errorLinks: PayPalLink[] | undefined): Promise<string | null> {
    const pick = (links: PayPalLink[] | undefined) =>
      links?.find((l) => (l.rel === 'redirect' || l.rel === 'payer-action' || l.rel === 'approve') && PAYPAL_URL_RE.test(l.href))?.href ?? null;
    const fromError = pick(errorLinks);
    if (fromError || !order.provider_ref) return fromError;
    const { status, data } = await this.api<PayPalOrder>('GET', `/v2/checkout/orders/${encodeURIComponent(order.provider_ref)}`);
    return status < 300 ? pick(data.links) : null;
  }

  /** Reads the PayPal order and applies its state, capturing it if it is approved. */
  async sync(order: OrderRow, captureIfApproved = true): Promise<void> {
    if (!order.provider_ref) return;
    const { status, data } = await this.api<PayPalOrder>('GET', `/v2/checkout/orders/${encodeURIComponent(order.provider_ref)}`);
    if (status === 404) return;
    if (status >= 300) throw new ProviderError('paypal', `PayPal order lookup failed (${status})`, status, data);
    if (data.status === 'APPROVED' && captureIfApproved) {
      await this.capture(order);
      return;
    }
    this.applyOrder(order, data);
  }

  async refresh(order: OrderRow): Promise<void> {
    await this.sync(order, true);
  }

  private applyOrder(order: OrderRow, ppOrder: PayPalOrder): void {
    if (ppOrder.id !== order.provider_ref) {
      this.log.warn({ orderId: order.id, paypalOrder: ppOrder.id }, 'PayPal order does not match');
      return;
    }
    const unit = ppOrder.purchase_units?.find((u) => u.reference_id === order.id || u.custom_id === order.id) ?? ppOrder.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    if (ppOrder.status === 'VOIDED') {
      this.orders.markUnpaid(order.id, 'canceled', 'PayPal order voided');
      return;
    }
    if (!capture) return;

    switch (capture.status) {
      case 'COMPLETED': {
        const amount = capture.amount;
        const paid = amount ? majorToMinor(Number(amount.value), amount.currency_code) : NaN;
        const customId = capture.custom_id ?? unit?.custom_id;
        if (!amount || amount.currency_code !== order.charge_currency || paid !== order.charge_amount || (customId && customId !== order.id)) {
          this.orders.markReview(order.id, `PayPal amount mismatch: ${amount?.value} ${amount?.currency_code}`);
          return;
        }
        this.orders.fulfill(order.id, { providerPaymentId: capture.id, paidAmount: paid, paidCurrency: amount.currency_code });
        return;
      }
      case 'PENDING':
        if (!order.provider_payment_id) this.orders.setProviderPaymentId(order.id, capture.id);
        return;
      case 'DECLINED':
      case 'FAILED':
        this.orders.markUnpaid(order.id, 'failed', `PayPal capture ${capture.status.toLowerCase()}`);
        return;
      case 'REFUNDED':
        this.orders.reverse(order.id, 'refunded', 'Refunded in PayPal');
        return;
      default:
        return;
    }
  }

  private async getCapture(captureId: string): Promise<PayPalCapture | null> {
    const { status, data } = await this.api<PayPalCapture>('GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`);
    if (status === 404) return null;
    if (status >= 300) throw new ProviderError('paypal', `PayPal capture lookup failed (${status})`, status, data);
    return data;
  }

  /**
   * Finds the order a capture belongs to. Delivered orders store the capture ID; for an
   * order whose confirmation was missed, the capture names its PayPal order instead.
   */
  private orderForCapture(captureId: string, capture: PayPalCapture | null): OrderRow | undefined {
    const known = this.orders.findByProviderPayment('paypal', captureId);
    if (known) return known;
    const ppOrderId = capture?.supplementary_data?.related_ids?.order_id;
    return ppOrderId ? this.orders.findByProviderRef('paypal', ppOrderId) : undefined;
  }

  /** Re-reads a capture after a refund notification and revokes access when it was fully refunded. */
  async checkCapture(captureId: string): Promise<void> {
    const capture = await this.getCapture(captureId);
    const order = this.orderForCapture(captureId, capture);
    if (!capture || !order) return;
    if (capture.status === 'REFUNDED') {
      this.orders.reverse(order.id, 'refunded', 'Refunded in PayPal');
    } else if (capture.status === 'PARTIALLY_REFUNDED' && order.status === 'paid') {
      // Partial refunds keep access; staff decide what to do.
      this.orders.flag(order.id, 'Partially refunded in PayPal');
    }
  }

  /**
   * A reversal (chargeback) arrives as a refund resource that points at its capture.
   * Read it back with our credentials, then revoke the order behind that capture.
   */
  async checkReversal(refundId: string): Promise<void> {
    const { status, data } = await this.api<PayPalRefund>('GET', `/v2/payments/refunds/${encodeURIComponent(refundId)}`);
    if (status === 404) {
      this.log.warn({ refundId }, 'PayPal reversal not found');
      return;
    }
    if (status >= 300) throw new ProviderError('paypal', `PayPal refund lookup failed (${status})`, status, data);
    if (data.status === 'CANCELLED' || data.status === 'FAILED') return;
    const captureId = captureIdFromLinks(data.links);
    if (!captureId) {
      this.log.warn({ refundId }, 'PayPal reversal without a capture link');
      return;
    }
    const order = this.orderForCapture(captureId, await this.getCapture(captureId));
    if (!order) {
      this.log.warn({ refundId, captureId }, 'PayPal reversal for an unknown capture');
      return;
    }
    this.orders.reverse(order.id, 'disputed', 'PayPal reversed the payment (chargeback)');
  }

  /**
   * Webhook payloads are treated as hints only: every state change is confirmed
   * by reading the resource back from the PayPal API with our own credentials.
   */
  async handleWebhook(event: { event_type?: string; resource?: Record<string, unknown> }): Promise<void> {
    const type = event.event_type ?? '';
    const resource = (event.resource ?? {}) as Record<string, any>;
    switch (type) {
      case 'CHECKOUT.ORDER.APPROVED': {
        const order = typeof resource.id === 'string' ? this.orders.findByProviderRef('paypal', resource.id) : undefined;
        if (order) await this.capture(order);
        return;
      }
      case 'PAYMENT.CAPTURE.COMPLETED':
      case 'PAYMENT.CAPTURE.PENDING':
      case 'PAYMENT.CAPTURE.DECLINED':
      case 'PAYMENT.CAPTURE.DENIED': {
        const ppOrderId = resource.supplementary_data?.related_ids?.order_id;
        const order = typeof ppOrderId === 'string' ? this.orders.findByProviderRef('paypal', ppOrderId) : undefined;
        if (order) await this.sync(order, false);
        return;
      }
      case 'PAYMENT.CAPTURE.REFUNDED': {
        // The resource is the refund; its `up` link names the capture.
        const captureId = captureIdFromLinks(resource.links as PayPalLink[] | undefined);
        if (captureId) await this.checkCapture(captureId);
        return;
      }
      case 'PAYMENT.CAPTURE.REVERSED': {
        if (typeof resource.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(resource.id)) await this.checkReversal(resource.id);
        return;
      }
      default:
        return;
    }
  }
}
