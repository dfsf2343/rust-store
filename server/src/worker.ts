/**
 * Cloudflare Workers entry. Static files are served by Workers Static Assets; every /api/*
 * request is forwarded to one Durable Object that runs the same Express app as the Node
 * build, with its SQLite database stored inside the object.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleAsNodeRequest } from 'cloudflare:node';
import { DurableObject } from 'cloudflare:workers';
import catalog from '../../config/catalog.json' with { type: 'json' };
import payments from '../../config/payments.json' with { type: 'json' };
import site from '../../config/site.json' with { type: 'json' };
import { gate, ipAllowed, ipRefusal, isOpenPath } from './access.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { parseContent } from './content.js';
import { createContext, type AppContext } from './context.js';
import { getMeta, migrate, setMeta } from './db.js';
import { noGeoLookup } from './geo/routing.js';
import { housekeeping, reconcilePending } from './maintenance.js';
import { consoleLogger, type LogLevel } from './worker/logger.js';
import { DurableSqlDb } from './worker/sql.js';

/** Set by the Worker on every forwarded request; client-supplied values are overwritten. */
const ORIGIN_HEADER = 'x-store-origin';
const COUNTRY_HEADER = 'x-store-country';
const STORE_NAME = 'main';

// Validated at upload time: a broken config file fails the deploy instead of the live site.
const content = parseContent({ site, catalog, payments });

interface Env {
  STORE: DurableObjectNamespace<StoreObject>;
  ASSETS: Fetcher;
  BASE_URL?: string;
  LOG_LEVEL?: string;
  NODE_ENV?: string;
  ACCESS_PASSWORD?: string;
  ALLOWED_IPS?: string;
}

function stringVars(env: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  return out;
}

function logLevel(env: Env): LogLevel {
  const level = env.LOG_LEVEL?.trim().toLowerCase();
  return level === 'trace' || level === 'debug' || level === 'warn' || level === 'error' || level === 'fatal' || level === 'silent'
    ? level
    : 'info';
}

export class StoreObject extends DurableObject<Env> {
  private readonly db: DurableSqlDb;
  private appCtx: AppContext | null = null;
  private port: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new DurableSqlDb(ctx.storage);
    migrate(this.db);
  }

  /**
   * Wires the store once per object lifetime. The public address is BASE_URL when set;
   * otherwise the address of the first request ever served (the workers.dev subdomain),
   * remembered in the database so restarts and cron runs use the same one.
   */
  private context(requestOrigin: string | null): AppContext | null {
    if (this.appCtx) return this.appCtx;
    const configured = this.env.BASE_URL?.trim().replace(/\/+$/, '') || null;
    let remembered = getMeta(this.db, 'origin');
    if (!configured && !remembered && requestOrigin) {
      setMeta(this.db, 'origin', requestOrigin);
      remembered = requestOrigin;
    }
    const baseUrl = configured ?? remembered;
    if (!baseUrl) return null;

    const config = loadConfig(
      {
        ...stringVars(this.env),
        BASE_URL: baseUrl,
        // The Worker replaces X-Forwarded-For with CF-Connecting-IP: trust exactly one hop.
        TRUST_PROXY: '1',
        GEOIP_HEADER: COUNTRY_HEADER,
        GEOIP_AUTO_UPDATE: 'false',
      },
      'cloudflare',
    );
    const log = consoleLogger(logLevel(this.env));
    for (const warning of config.warnings) log.warn(warning);
    this.appCtx = createContext(config, { db: this.db, logger: log, loadContent: () => content, geo: noGeoLookup });
    log.info({ baseUrl: config.baseUrl, providers: [...this.appCtx.providers.enabled] }, 'Store started');
    return this.appCtx;
  }

  override async fetch(request: Request): Promise<Response> {
    const appCtx = this.context(request.headers.get(ORIGIN_HEADER));
    if (!appCtx) return Response.json({ error: { code: 'not_ready', message: 'The store is starting. Try again.' } }, { status: 503 });
    if (this.port === null) {
      const server = http.createServer(createApp(appCtx));
      server.listen(0);
      this.port = (server.address() as AddressInfo).port;
    }
    return handleAsNodeRequest(this.port, request);
  }

  // Wrong access passwords per address: 10 within 15 minutes locks that address for 15 minutes.
  private readonly accessFailures = new Map<string, { count: number; since: number }>();

  async accessBlocked(ip: string): Promise<boolean> {
    const entry = this.accessFailures.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.since > 15 * 60_000) {
      this.accessFailures.delete(ip);
      return false;
    }
    return entry.count >= 10;
  }

  async accessFailed(ip: string): Promise<void> {
    const now = Date.now();
    const entry = this.accessFailures.get(ip);
    if (!entry || now - entry.since > 15 * 60_000) this.accessFailures.set(ip, { count: 1, since: now });
    else entry.count += 1;
    if (this.accessFailures.size > 10_000) this.accessFailures.clear();
  }

  /** Cron trigger: expire abandoned checkouts, prune old rows, re-check pending payments. */
  async housekeeping(): Promise<{ expired: number; checked: number }> {
    const appCtx = this.context(null);
    // No request has ever been served, so there are no orders yet.
    if (!appCtx) return { expired: 0, checked: 0 };
    const { expired } = housekeeping(appCtx);
    const checked = await reconcilePending(appCtx);
    return { expired, checked };
  }
}

function forward(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set(ORIGIN_HEADER, url.origin);
  // `wrangler dev` has no real edge location; X-Dev-Country simulates one, in development only.
  const devCountry = env.NODE_ENV === 'development' ? request.headers.get('x-dev-country') : null;
  const country = devCountry ?? request.cf?.country;
  headers.set(COUNTRY_HEADER, typeof country === 'string' ? country : '');
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set('x-forwarded-for', ip);
  else headers.delete('x-forwarded-for');
  const stub = env.STORE.get(env.STORE.idFromName(STORE_NAME));
  return stub.fetch(new Request(request, { headers }));
}

export default {
  async fetch(request, env) {
    // IP allowlist: other addresses get a bare 403 for everything. Webhooks and the game
    // plugin stay reachable because they come from the providers' and the game server's own
    // addresses and are authenticated by their signatures.
    const allowedIps = env.ALLOWED_IPS?.trim();
    if (allowedIps && !isOpenPath(new URL(request.url).pathname) && !ipAllowed(request.headers.get('cf-connecting-ip'), allowedIps)) {
      return ipRefusal();
    }
    // Members-only mode: nothing (pages, files or API) is served without the access cookie.
    const password = env.ACCESS_PASSWORD?.trim();
    if (password) {
      const store = env.STORE.get(env.STORE.idFromName(STORE_NAME));
      const limiter = { isBlocked: (ip: string) => store.accessBlocked(ip), recordFailure: (ip: string) => store.accessFailed(ip) };
      const blocked = await gate(request, password, content.site.name, Math.floor(Date.now() / 1000), limiter);
      if (blocked) return blocked;
    }
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) return forward(request, env);
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env) {
    await env.STORE.get(env.STORE.idFromName(STORE_NAME)).housekeeping();
  },
} satisfies ExportedHandler<Env>;
