import { Router } from 'express';
import type { AppContext } from '../context.js';
import { catalogView, siteView, statusView } from '../store/views.js';

/** Changed with each release, so /api/health shows which version is live. */
const BUILD = '2026-10-29.1';

export function publicRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/site', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json(siteView(ctx.content()));
  });

  router.get('/catalog', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json(catalogView(ctx.content()));
  });

  router.get('/status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(statusView(ctx.db, ctx.content(), ctx.now()));
  });

  router.get('/health', (_req, res) => {
    ctx.db.prepare('SELECT 1').get();
    res.json({ ok: true, build: BUILD });
  });

  return router;
}
