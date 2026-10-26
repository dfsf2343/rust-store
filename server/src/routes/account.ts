import { Router } from 'express';
import { requireUser } from '../auth/sessions.js';
import type { AppContext } from '../context.js';
import type { OrderRow } from '../store/orders.js';
import { accountKitsView, orderView } from '../store/views.js';

export function accountRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/account', requireUser, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const user = req.user!;
    const content = ctx.content();
    const now = ctx.now();
    // Hide abandoned checkouts: pending ones older than an hour and ones that never reached the provider.
    const orders = ctx.db
      .prepare(
        `SELECT * FROM orders
         WHERE user_id = ?
           AND provider_ref IS NOT NULL
           AND NOT (status IN ('pending', 'expired', 'canceled') AND created_at < ?)
         ORDER BY created_at DESC LIMIT 50`,
      )
      .all(user.id, now - 3600) as OrderRow[];
    res.json({
      user: { steamId: user.steam_id, name: user.name, avatarUrl: user.avatar_url, banned: user.is_banned === 1 },
      kits: accountKitsView(ctx.db, content, user.steam_id, now),
      orders: orders.map((o) => orderView(o, content)),
    });
  });

  return router;
}
