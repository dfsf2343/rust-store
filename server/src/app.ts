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
