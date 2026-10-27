import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { ipKeyGenerator, rateLimit, type ClientRateLimitInfo, type Options, type Store } from 'express-rate-limit';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { HttpError } from '../lib/util.js';
import { ProviderError } from '../payments/types.js';

/**
 * Blocks cross-site state-changing requests: every non-GET API call must come
 * from our own origin. Combined with SameSite=Lax cookies this covers CSRF.
 */
export function originGuard(config: AppConfig) {
  const allowed = new Set([config.baseOrigin]);
  if (!config.isProd) {
    allowed.add('http://localhost:5173');
    allowed.add('http://127.0.0.1:5173');
  }
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.get('origin');
    if (!origin || !allowed.has(origin)) return next(new HttpError(403, 'Cross-site request blocked.', 'bad_origin'));
    next();
  };
}

/**
 * In-memory hit counter that expires entries lazily. The library's MemoryStore runs a
 * setInterval per limiter, which would keep a Cloudflare Durable Object awake (and billed) forever.
 */
export class LazyMemoryStore implements Store {
  localKeys = true;
  private windowMs = 60_000;
  private lastSweep = 0;
  private readonly hits = new Map<string, { totalHits: number; resetTime: Date }>();

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  get(key: string): ClientRateLimitInfo | undefined {
    const entry = this.current(key, Date.now());
    return entry ? { totalHits: entry.totalHits, resetTime: entry.resetTime } : undefined;
  }

  increment(key: string): ClientRateLimitInfo {
    const now = Date.now();
    this.sweep(now);
    let entry = this.current(key, now);
    if (!entry) {
      entry = { totalHits: 0, resetTime: new Date(now + this.windowMs) };
      this.hits.set(key, entry);
    }
    entry.totalHits += 1;
    return { totalHits: entry.totalHits, resetTime: entry.resetTime };
  }

  decrement(key: string): void {
    const entry = this.current(key, Date.now());
    if (entry && entry.totalHits > 0) entry.totalHits -= 1;
  }

  resetKey(key: string): void {
    this.hits.delete(key);
  }

  resetAll(): void {
    this.hits.clear();
  }

  private current(key: string, now: number) {
    const entry = this.hits.get(key);
    if (entry && entry.resetTime.getTime() <= now) {
      this.hits.delete(key);
      return undefined;
    }
    return entry;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, entry] of this.hits) {
      if (entry.resetTime.getTime() <= now) this.hits.delete(key);
    }
  }
}

export function limiter(windowSeconds: number, limit: number, keyByUser = false) {
  return rateLimit({
    windowMs: windowSeconds * 1000,
    limit,
    store: new LazyMemoryStore(),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(keyByUser ? { keyGenerator: (req: Request) => (req.user ? `user:${req.user.id}` : ipKeyGenerator(req.ip ?? '')) } : {}),
    handler: (_req, _res, next) => next(new HttpError(429, 'Too many requests. Slow down and try again shortly.', 'rate_limited')),
  });
}

export function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new HttpError(400, first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request', 'invalid_request');
  }
  return result.data;
}

export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (res.headersSent) return;
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'invalid_json', message: 'Malformed JSON body.' } });
      return;
    }
    if ((err as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'too_large', message: 'Request body too large.' } });
      return;
    }
    if (err instanceof ProviderError) {
      log.error({ err: { message: err.message, status: err.status, body: err.body }, provider: err.provider, path: req.path }, 'Payment provider error');
      // Admins see the provider's own reason, so setup problems can be fixed without reading logs.
      const message = req.user?.isAdmin
        ? `Payment provider error (shown to admins only): ${err.message}`
        : 'The payment provider is not responding. Please try again in a minute.';
      res.status(502).json({ error: { code: 'provider_error', message } });
      return;
    }
    log.error({ err, path: req.path, method: req.method }, 'Unhandled error');
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on our side.' } });
  };
}
