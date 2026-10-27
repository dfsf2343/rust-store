import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth/sessions.js';
import type { AppContext } from '../context.js';
import { findDuration, findKit } from '../content.js';
import { audit } from '../db.js';
import { formatMoney, HttpError, isSteamId } from '../lib/util.js';
import { computeAccess, insertGrant, recomputeEntitlement, type GrantRow } from '../store/entitlements.js';
import type { OrderRow } from '../store/orders.js';
import { accountKitsView, orderView, statusView } from '../store/views.js';
import { parseBody } from './http.js';

const ORDER_STATUSES = ['pending', 'paid', 'failed', 'canceled', 'expired', 'refunded', 'disputed', 'review'] as const;

export function adminRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use('/admin', requireAdmin);

  const sum = (since: number) =>
    ctx.db
      .prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(amount_cents), 0) AS cents FROM orders WHERE status = 'paid' AND paid_at >= ?`)
      .get(since) as { orders: number; cents: number };

  router.get('/admin/overview', (_req, res) => {
    const now = ctx.now();
    const content = ctx.content();
    const windows = { day: now - 86_400, week: now - 7 * 86_400, month: now - 30 * 86_400, all: 0 };
    const revenue = Object.fromEntries(
      Object.entries(windows).map(([k, since]) => {
        const r = sum(since);
        return [k, { orders: r.orders, cents: r.cents, display: formatMoney(r.cents, 'USD') }];
      }),
    );
    const byKit = ctx.db
      .prepare(`SELECT kit_id AS kitId, kit_name AS kitName, COUNT(*) AS orders, SUM(amount_cents) AS cents FROM orders WHERE status = 'paid' AND paid_at >= ? GROUP BY kit_id ORDER BY cents DESC`)
      .all(windows.month) as { kitId: string; kitName: string; orders: number; cents: number }[];
    const byProvider = ctx.db
      .prepare(`SELECT provider, COUNT(*) AS orders, SUM(amount_cents) AS cents FROM orders WHERE status = 'paid' AND paid_at >= ? GROUP BY provider ORDER BY cents DESC`)
      .all(windows.month) as { provider: string; orders: number; cents: number }[];
    const attention = ctx.db
      .prepare(
        `SELECT * FROM orders WHERE status IN ('review', 'disputed') OR (status = 'paid' AND status_detail IS NOT NULL)
         ORDER BY updated_at DESC LIMIT 20`,
      )
      .all() as OrderRow[];
    const recent = ctx.db.prepare(`SELECT * FROM orders WHERE provider_ref IS NOT NULL ORDER BY created_at DESC LIMIT 15`).all() as OrderRow[];
    const activeKits = ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM entitlements WHERE lifetime = 1 OR expires_at > ?`)
      .get(now) as { n: number };
    res.json({
      revenue,
      byKit: byKit.map((r) => ({ ...r, display: formatMoney(r.cents, 'USD') })),
      byProvider: byProvider.map((r) => ({ ...r, display: formatMoney(r.cents, 'USD') })),
      activeEntitlements: activeKits.n,
      attention: attention.map((o) => ({ ...orderView(o, content), steamId: o.steam_id })),
      recent: recent.map((o) => ({ ...orderView(o, content), steamId: o.steam_id })),
      server: statusView(ctx.db, content, now),
      system: {
        runtime: ctx.config.runtime,
        providers: [...ctx.providers.enabled],
        stripeWebhooks: ctx.providers.stripe?.webhooksEnabled ?? false,
        geoipReady: ctx.geo.ready,
        geoHeader: ctx.config.geo.header,
        pluginConfigured: ctx.config.pluginSecret !== null,
        warnings: ctx.config.warnings,
        catalogVersion: content.catalogVersion,
      },
    });
  });

  router.get('/admin/orders', (req, res) => {
    const q = parseBody(
      z.object({
        status: z.enum(ORDER_STATUSES).optional(),
        q: z.string().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.status) {
      where.push('status = ?');
      params.push(q.status);
    }
    if (q.q) {
      where.push('(id = ? OR steam_id = ? OR provider_ref = ? OR provider_payment_id = ?)');
      params.push(q.q, q.q, q.q, q.q);
    }
    const sql = `SELECT * FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const rows = ctx.db.prepare(sql).all(...params, q.limit, q.offset) as OrderRow[];
    const content = ctx.content();
    res.json({ orders: rows.map((o) => ({ ...orderView(o, content), steamId: o.steam_id, country: o.country, providerRef: o.provider_ref })) });
  });

  router.post('/admin/orders/:id/refresh', async (req, res) => {
    const order = ctx.orders.get(String(req.params.id));
    if (!order) throw new HttpError(404, 'Order not found.', 'not_found');
    const provider = ctx.providers.get(order.provider);
    if (!provider) throw new HttpError(400, `${order.provider} is not configured.`, 'provider_unavailable');
    await provider.refresh(order);
    audit(ctx.db, req.user!.steam_id, 'admin.order.refresh', order.id, undefined, ctx.now());
    res.json(orderView(ctx.orders.get(order.id)!, ctx.content()));
  });

  // Delivers an order held for review (amount mismatch) after staff checked the payment in the provider dashboard.
  router.post('/admin/orders/:id/approve', (req, res) => {
    const order = ctx.orders.get(String(req.params.id));
    if (!order) throw new HttpError(404, 'Order not found.', 'not_found');
    if (order.status !== 'review') throw new HttpError(409, 'Only orders held for review can be approved.', 'not_in_review');
    const result = ctx.orders.fulfill(
      order.id,
      {
        providerPaymentId: order.provider_payment_id,
        paidAmount: order.paid_amount ?? order.charge_amount,
        paidCurrency: order.paid_currency ?? order.charge_currency,
      },
      req.user!.steam_id,
      { allowReview: true },
    );
    if (!result.fulfilled) throw new HttpError(409, 'The order could not be approved.', 'not_approved');
    res.json(orderView(ctx.orders.get(order.id)!, ctx.content()));
  });

  router.get('/admin/players/:steamId', (req, res) => {
    const steamId = String(req.params.steamId);
    if (!isSteamId(steamId)) throw new HttpError(400, 'Invalid SteamID64.', 'invalid_request');
    const content = ctx.content();
    const user = ctx.db.prepare('SELECT * FROM users WHERE steam_id = ?').get(steamId) as Record<string, unknown> | undefined;
    const grants = ctx.db.prepare('SELECT * FROM grants WHERE steam_id = ? ORDER BY granted_at DESC').all(steamId) as GrantRow[];
    const orders = ctx.db.prepare('SELECT * FROM orders WHERE steam_id = ? ORDER BY created_at DESC LIMIT 50').all(steamId) as OrderRow[];
    const claims = ctx.db.prepare('SELECT kit_id AS kitId, claimed_at AS claimedAt, server_id AS serverId FROM claims WHERE steam_id = ? ORDER BY claimed_at DESC LIMIT 30').all(steamId);
    res.json({
      steamId,
      user: user ? { name: user.name, avatarUrl: user.avatar_url, banned: user.is_banned === 1, createdAt: user.created_at, lastLoginAt: user.last_login_at } : null,
      kits: accountKitsView(ctx.db, content, steamId, ctx.now()),
      grants: grants.map((g) => ({
        id: g.id,
        kitId: g.kit_id,
        days: g.days,
        grantedAt: g.granted_at,
        source: g.source,
        orderId: g.order_id,
        note: g.note,
        createdBy: g.created_by,
        revokedAt: g.revoked_at,
        revokedReason: g.revoked_reason,
      })),
      orders: orders.map((o) => orderView(o, content)),
      claims,
    });
  });

  router.post('/admin/grants', (req, res) => {
    const body = parseBody(
      z.object({
        steamId: z.string().refine(isSteamId, 'Invalid SteamID64'),
        kitId: z.string(),
        durationId: z.string(),
        note: z.string().max(200).optional(),
      }),
      req.body,
    );
    const content = ctx.content();
    const kit = findKit(content, body.kitId);
    const duration = findDuration(content, body.durationId);
    if (!kit || !duration) throw new HttpError(404, 'Unknown kit or duration.', 'not_found');
    const now = ctx.now();
    const admin = req.user!.steam_id;
    const id = ctx.db.transaction(() => {
      const grantId = insertGrant(ctx.db, {
        steamId: body.steamId,
        kitId: kit.id,
        days: duration.days,
        grantedAt: now,
        source: 'admin',
        note: body.note ?? null,
        createdBy: admin,
      });
      recomputeEntitlement(ctx.db, body.steamId, kit.id, now);
      ctx.orders.notify(body.steamId, `An admin granted you the ${kit.name} kit (${duration.label}). Type /${content.site.store.inGameCommand} ${kit.id} to claim it.`);
      audit(ctx.db, admin, 'admin.grant', body.steamId, { grantId, kit: kit.id, duration: duration.id, note: body.note }, now);
      return grantId;
    })();
    void ctx.events.emit({ type: 'admin.grant', admin, steamId: body.steamId, detail: `${kit.name} (${duration.label})${body.note ? `: ${body.note}` : ''}` });
    res.json({ ok: true, grantId: id });
  });

  router.post('/admin/grants/:id/revoke', (req, res) => {
    const id = Number(req.params.id);
    const body = parseBody(z.object({ reason: z.string().min(1).max(200) }), req.body);
    const grant = ctx.db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as GrantRow | undefined;
    if (!grant) throw new HttpError(404, 'Grant not found.', 'not_found');
    if (grant.revoked_at !== null) throw new HttpError(409, 'Grant is already revoked.', 'conflict');
    const now = ctx.now();
    const admin = req.user!.steam_id;
    ctx.db.transaction(() => {
      ctx.db.prepare('UPDATE grants SET revoked_at = ?, revoked_reason = ? WHERE id = ?').run(now, body.reason, id);
      recomputeEntitlement(ctx.db, grant.steam_id, grant.kit_id, now);
      audit(ctx.db, admin, 'admin.revoke', grant.steam_id, { grantId: id, reason: body.reason }, now);
    })();
    void ctx.events.emit({ type: 'admin.revoke', admin, steamId: grant.steam_id, detail: `${grant.kit_id}: ${body.reason}` });
    const remaining = computeAccess(
      ctx.db.prepare('SELECT days, granted_at, revoked_at FROM grants WHERE steam_id = ? AND kit_id = ?').all(grant.steam_id, grant.kit_id) as GrantRow[],
    );
    res.json({ ok: true, access: remaining });
  });

  router.post('/admin/players/:steamId/ban', (req, res) => {
    const steamId = String(req.params.steamId);
    if (!isSteamId(steamId)) throw new HttpError(400, 'Invalid SteamID64.', 'invalid_request');
    const { banned } = parseBody(z.object({ banned: z.boolean() }), req.body);
    const now = ctx.now();
    ctx.db
      .prepare(
        `INSERT INTO users (steam_id, created_at, last_login_at, is_banned) VALUES (?, ?, ?, ?)
         ON CONFLICT(steam_id) DO UPDATE SET is_banned = excluded.is_banned`,
      )
      .run(steamId, now, now, banned ? 1 : 0);
    audit(ctx.db, req.user!.steam_id, banned ? 'admin.ban' : 'admin.unban', steamId, undefined, now);
    res.json({ ok: true });
  });

  router.post('/admin/reload', (req, res) => {
    if (ctx.config.runtime === 'cloudflare') {
      throw new HttpError(409, 'On Cloudflare the config files are part of the deploy. Edit them in the GitHub repository and the site redeploys.', 'config_bundled');
    }
    try {
      const content = ctx.reloadContent();
      audit(ctx.db, req.user!.steam_id, 'admin.reload', null, { catalogVersion: content.catalogVersion }, ctx.now());
      res.json({ ok: true, catalogVersion: content.catalogVersion });
    } catch (err) {
      throw new HttpError(400, (err as Error).message, 'invalid_config');
    }
  });

  router.get('/admin/audit', (_req, res) => {
    const rows = ctx.db.prepare('SELECT at, actor, action, subject, details FROM audit_log ORDER BY id DESC LIMIT 100').all();
    res.json({ entries: rows });
  });

  return router;
}
