import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { loadUser } from './auth/sessions.js';
import type { AppContext } from './context.js';
import { HttpError } from './lib/util.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { checkoutRoutes } from './routes/checkout.js';
import { errorHandler, originGuard } from './routes/http.js';
import { pluginRoutes } from './routes/plugin.js';
import { publicRoutes } from './routes/public.js';
import { webhookRoutes } from './routes/webhooks.js';
import { cspDirectives } from './security.js';
import { ACCESS_PATH, gatePage, hasAccess, isOpenPath, issueCookie, passwordMatches } from './access.js';

function parseTrustProxy(value: string): boolean | number | string[] {
  const v = value.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export function createApp(ctx: AppContext): Express {
  const app = express();
  const { config } = ctx;
  app.disable('x-powered-by');
  app.set('trust proxy', parseTrustProxy(config.trustProxy));

  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: cspDirectives(ctx.content().site, config.baseUrl) },
      crossOriginEmbedderPolicy: false,
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  // Members-only gate. On Cloudflare the Worker applies the same gate before files and the API; this covers Node.
  const accessPassword = config.accessPassword;
  if (accessPassword) {
    const secure = config.baseUrl.startsWith('https://');
    app.post(ACCESS_PATH, express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
      const origin = req.get('origin');
      if (origin && origin !== config.baseOrigin) return void res.status(403).send('Forbidden');
      const attempt = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
      if (await passwordMatches(accessPassword, attempt)) {
        res.set('Set-Cookie', await issueCookie(accessPassword, ctx.now(), secure)).set('Cache-Control', 'no-store').redirect(303, '/');
        return;
      }
      res.status(401).set('Cache-Control', 'no-store').type('html').send(gatePage(ctx.content().site.name, true));
    });
    app.use(async (req, res, next) => {
      if (isOpenPath(req.path) || (await hasAccess(accessPassword, req.get('cookie'), ctx.now()))) return next();
      res.set('Cache-Control', 'no-store');
      if (req.path.startsWith('/api/')) {
        res.status(401).json({ error: { code: 'access_required', message: 'Enter the access password first.' } });
        return;
      }
      res.status(401).type('html').send(gatePage(ctx.content().site.name, false));
    });
  }

  // Raw-body routes first.
  app.use('/api/webhooks', webhookRoutes(ctx));
  app.use('/api/plugin', pluginRoutes(ctx));

  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());
  app.use(loadUser(ctx.db, config, ctx.now));
  app.use('/api', originGuard(config));
  app.use('/api', publicRoutes(ctx));
  app.use('/api', authRoutes(ctx));
  app.use('/api', checkoutRoutes(ctx));
  app.use('/api', accountRoutes(ctx));
  app.use('/api', adminRoutes(ctx));
  app.use('/api', (_req: Request, _res: Response, next: NextFunction) => next(new HttpError(404, 'Not found', 'not_found')));

  if (config.webDistDir && fs.existsSync(path.join(config.webDistDir, 'index.html'))) {
    const indexFile = path.join(config.webDistDir, 'index.html');
    app.use(
      '/assets',
      express.static(path.join(config.webDistDir, 'assets'), { immutable: true, maxAge: '365d', index: false, fallthrough: false }),
    );
    app.use(express.static(config.webDistDir, { index: false, maxAge: '1h' }));
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.set('Cache-Control', 'no-cache');
      res.sendFile(indexFile);
    });
  }

  app.use(errorHandler(ctx.log));
  return app;
}
