import type { AppContext } from './context.js';
import type { OrderRow } from './store/orders.js';

export type HousekeepingContext = Pick<AppContext, 'db' | 'orders' | 'now' | 'log'>;
export type ReconcileContext = HousekeepingContext & Pick<AppContext, 'providers'>;

/**
 * Asks the payment provider about orders still pending 10 minutes after checkout, in case
 * a webhook was lost and the buyer never came back to the site. Each order is checked at
 * most every 30 minutes until it expires after 24 hours. Returns how many were checked.
 */
export async function reconcilePending(ctx: ReconcileContext, limit = 10): Promise<number> {
  const now = ctx.now();
  const due = ctx.db
    .prepare(
      `SELECT * FROM orders
        WHERE status = 'pending' AND provider_ref IS NOT NULL
          AND created_at <= ? AND created_at > ? AND (checked_at IS NULL OR checked_at <= ?)
        ORDER BY COALESCE(checked_at, 0), created_at
        LIMIT ?`,
    )
    .all(now - 600, now - 86_400, now - 1_800, limit) as OrderRow[];
  let checked = 0;
  for (const order of due) {
    ctx.orders.markChecked(order.id);
    const provider = ctx.providers.get(order.provider);
    if (!provider) continue;
    try {
      await provider.refresh(order);
      checked += 1;
    } catch (err) {
      ctx.log.warn({ orderId: order.id, err: (err as Error).message }, 'Could not check a pending payment');
    }
  }
  if (checked > 0) ctx.log.info({ checked }, 'Checked pending payments with the providers');
  return checked;
}

/** Expires abandoned checkouts and prunes old rows. Node runs it on a timer, Cloudflare on a cron trigger. */
export function housekeeping(ctx: HousekeepingContext): { expired: number } {
  const now = ctx.now();
  const expired = ctx.orders.expireStalePending(24 * 3600);
  ctx.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  ctx.db.prepare('DELETE FROM notifications WHERE delivered_at IS NOT NULL AND delivered_at < ?').run(now - 30 * 86_400);
  ctx.db.prepare('DELETE FROM webhook_events WHERE received_at < ?').run(now - 30 * 86_400);
  if (expired > 0) ctx.log.info({ expired }, 'Expired stale checkouts');
  return { expired };
}
