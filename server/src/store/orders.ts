import type { ProviderId } from '../config.js';
import type { Content, Duration, Kit } from '../content.js';
import { audit, type DB } from '../db.js';
import type { Logger } from 'pino';
import { formatMoney, randomId } from '../lib/util.js';
import { insertGrant, recomputeEntitlement } from './entitlements.js';

export type OrderStatus = 'pending' | 'paid' | 'failed' | 'canceled' | 'expired' | 'refunded' | 'disputed' | 'review';

export interface OrderRow {
  id: string;
  user_id: number;
  steam_id: string;
  kit_id: string;
  kit_name: string;
  duration_id: string;
  duration_label: string;
  duration_days: number | null;
  amount_cents: number;
  currency: string;
  charge_amount: number;
  charge_currency: string;
  provider: ProviderId;
  provider_ref: string | null;
  provider_payment_id: string | null;
  status: OrderStatus;
  status_detail: string | null;
  country: string | null;
  ip: string | null;
  terms_accepted_at: number;
  created_at: number;
  updated_at: number;
  paid_at: number | null;
  paid_amount: number | null;
  paid_currency: string | null;
  checked_at: number | null;
}

/** States from which a confirmed payment still fulfills the order. */
const FULFILLABLE: ReadonlySet<OrderStatus> = new Set(['pending', 'failed', 'canceled', 'expired']);

export function isFulfillable(status: OrderStatus): boolean {
  return FULFILLABLE.has(status);
}

export interface PaymentConfirmation {
  providerPaymentId: string | null;
  paidAmount: number;
  paidCurrency: string;
}

export class OrderService {
  constructor(
    private readonly db: DB,
    private readonly content: () => Content,
    private readonly log: Logger,
    private readonly now: () => number,
  ) {}

  get(id: string): OrderRow | undefined {
    return this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
  }

  findByProviderRef(provider: ProviderId, ref: string): OrderRow | undefined {
    return this.db.prepare('SELECT * FROM orders WHERE provider = ? AND provider_ref = ?').get(provider, ref) as OrderRow | undefined;
  }

  findByProviderPayment(provider: ProviderId, paymentId: string): OrderRow | undefined {
    return this.db
      .prepare('SELECT * FROM orders WHERE provider = ? AND provider_payment_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(provider, paymentId) as OrderRow | undefined;
  }

  create(input: {
    userId: number;
    steamId: string;
    kit: Kit;
    duration: Duration;
    amountCents: number;
    chargeAmount: number;
    chargeCurrency: string;
    provider: ProviderId;
    country: string | null;
    ip: string | null;
  }): OrderRow {
    const now = this.now();
    const id = randomId('ord');
    this.db
      .prepare(
        `INSERT INTO orders (id, user_id, steam_id, kit_id, kit_name, duration_id, duration_label, duration_days,
          amount_cents, currency, charge_amount, charge_currency, provider, status, country, ip,
          terms_accepted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.steamId,
        input.kit.id,
        input.kit.name,
        input.duration.id,
        input.duration.label,
        input.duration.days,
        input.amountCents,
        input.chargeAmount,
        input.chargeCurrency,
        input.provider,
        input.country,
        input.ip,
        now,
        now,
        now,
      );
    return this.get(id)!;
  }

  setProviderRef(orderId: string, ref: string): void {
    this.db.prepare('UPDATE orders SET provider_ref = ?, updated_at = ? WHERE id = ?').run(ref, this.now(), orderId);
  }

  setProviderPaymentId(orderId: string, paymentId: string): void {
    this.db.prepare('UPDATE orders SET provider_payment_id = ?, updated_at = ? WHERE id = ?').run(paymentId, this.now(), orderId);
  }

  /** Moves a pending order to a terminal non-paid state. Paid orders are never touched. */
  markUnpaid(orderId: string, status: 'failed' | 'canceled' | 'expired', detail?: string): void {
    const res = this.db
      .prepare(`UPDATE orders SET status = ?, status_detail = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
      .run(status, detail ?? null, this.now(), orderId);
    if (res.changes > 0) this.log.info({ orderId, status, detail }, 'Order closed without payment');
  }

  /**
   * Leaves a note for staff on an order without changing its status, for example a partial
   * refund or a second payment. Paid orders with a note show under "Needs attention".
   */
  flag(orderId: string, detail: string): void {
    const now = this.now();
    const note = detail.slice(0, 300);
    const res = this.db
      .prepare('UPDATE orders SET status_detail = ?, updated_at = ? WHERE id = ? AND (status_detail IS NULL OR status_detail <> ?)')
      .run(note, now, orderId, note);
    if (res.changes === 0) return;
    audit(this.db, 'system', 'order.flagged', orderId, { detail: note }, now);
    this.log.warn({ orderId, detail: note }, 'Order flagged for staff');
  }

  /** Records that the background reconciliation looked at this order. */
  markChecked(orderId: string): void {
    this.db.prepare('UPDATE orders SET checked_at = ? WHERE id = ?').run(this.now(), orderId);
  }

  markReview(orderId: string, detail: string): void {
    this.db
      .prepare(`UPDATE orders SET status = 'review', status_detail = ?, updated_at = ? WHERE id = ? AND status IN ('pending','failed','canceled','expired')`)
      .run(detail, this.now(), orderId);
    audit(this.db, 'system', 'order.review', orderId, { detail }, this.now());
    this.log.error({ orderId, detail }, 'Order needs manual review');
  }

  /**
   * Idempotent fulfillment: marks the order paid, records the grant, refreshes the
   * cached entitlement and queues an in-game notification. Safe to call repeatedly.
   */
  fulfill(
    orderId: string,
    payment: PaymentConfirmation,
    actor = 'system',
    opts: { allowReview?: boolean } = {},
  ): { fulfilled: boolean; order: OrderRow | undefined } {
    const run = this.db.transaction(() => {
      const order = this.get(orderId);
      if (!order) return { fulfilled: false, order };
      // Orders held for review are only delivered when staff approve them.
      if (!FULFILLABLE.has(order.status) && !(opts.allowReview && order.status === 'review')) return { fulfilled: false, order };
      const now = this.now();
      this.db
        .prepare(
          `UPDATE orders SET status = 'paid', status_detail = NULL, paid_at = ?, paid_amount = ?, paid_currency = ?,
             provider_payment_id = COALESCE(?, provider_payment_id), updated_at = ? WHERE id = ?`,
        )
        .run(now, payment.paidAmount, payment.paidCurrency, payment.providerPaymentId, now, orderId);
      insertGrant(this.db, {
        steamId: order.steam_id,
        kitId: order.kit_id,
        days: order.duration_days,
        grantedAt: now,
        source: 'order',
        orderId: order.id,
      });
      const access = recomputeEntitlement(this.db, order.steam_id, order.kit_id, now);
      const command = this.content().site.store.inGameCommand;
      const until = access?.lifetime ? 'for life' : `for ${order.duration_label}`;
      this.notify(order.steam_id, `Purchase confirmed: ${order.kit_name} kit ${until}. Type /${command} ${order.kit_id} to claim it.`);
      audit(this.db, actor, 'order.paid', order.id, {
        provider: order.provider,
        paid: formatMoney(payment.paidAmount, payment.paidCurrency),
        providerPaymentId: payment.providerPaymentId,
      }, now);
      return { fulfilled: true, order: this.get(orderId) };
    });
    const result = run.immediate();
    if (result.fulfilled) this.log.info({ orderId }, 'Order fulfilled');
    return result;
  }

  /**
   * Handles a refund or dispute. A delivered order loses its grant and access is recomputed.
   * An order that was never delivered (or is held for review) is closed with the same status,
   * so a late payment confirmation can no longer deliver it. Returns true when access changed.
   */
  reverse(orderId: string, status: 'refunded' | 'disputed', reason: string, actor = 'system'): boolean {
    const run = this.db.transaction(() => {
      const order = this.get(orderId);
      if (!order) return false;
      const now = this.now();
      if (FULFILLABLE.has(order.status) || order.status === 'review') {
        this.db.prepare('UPDATE orders SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?').run(status, reason, now, orderId);
        audit(this.db, actor, `order.${status}`, orderId, { reason, delivered: false }, now);
        return false;
      }
      if (order.status !== 'paid' && order.status !== 'refunded' && order.status !== 'disputed') return false;
      this.db.prepare('UPDATE orders SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?').run(status, reason, now, orderId);
      const revoked = this.db
        .prepare('UPDATE grants SET revoked_at = ?, revoked_reason = ? WHERE order_id = ? AND revoked_at IS NULL')
        .run(now, reason, orderId);
      recomputeEntitlement(this.db, order.steam_id, order.kit_id, now);
      if (revoked.changes > 0) audit(this.db, actor, `order.${status}`, orderId, { reason }, now);
      return revoked.changes > 0;
    });
    const changed = run.immediate();
    if (changed) this.log.warn({ orderId, status, reason }, 'Order reversed and access revoked');
    return changed;
  }

  notify(steamId: string, message: string): void {
    this.db.prepare('INSERT INTO notifications (steam_id, message, created_at) VALUES (?, ?, ?)').run(steamId, message, this.now());
  }

  expireStalePending(maxAgeSeconds: number): number {
    const cutoff = this.now() - maxAgeSeconds;
    const res = this.db
      .prepare(`UPDATE orders SET status = 'expired', status_detail = 'Checkout not completed', updated_at = ? WHERE status = 'pending' AND created_at < ?`)
      .run(this.now(), cutoff);
    return res.changes;
  }
}
