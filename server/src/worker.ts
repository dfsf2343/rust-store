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
import { deviceCookie, newDeviceId, readDeviceId, type SiteEvent, type Visitor } from './events.js';
import { firstLanguage, VISITOR_HEADER, type EdgeDetails } from './visitor.js';
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
  DISCORD_WEBHOOK_URL?: string;
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

  /** Activity log entries from the Worker (access gate and visits). */
  async logEvent(event: SiteEvent, origin: string): Promise<void> {
    await this.context(origin)?.events.emit(event);
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

function edgeDetails(request: Request): EdgeDetails {
  const cf = request.cf as Record<string, unknown> | undefined;
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    region: s(cf?.region),
    city: s(cf?.city),
    postalCode: s(cf?.postalCode),
    timezone: s(cf?.timezone),
    network: s(cf?.asOrganization),
    asn: typeof cf?.asn === 'number' ? cf.asn : null,
  };
}

function visitor(request: Request, deviceId: string, newDevice: boolean): Visitor {
  const country = request.cf?.country;
  const referrer = request.headers.get('referer');
  return {
    ip: request.headers.get('cf-connecting-ip'),
    country: typeof country === 'string' ? country : null,
    ...edgeDetails(request),
    userAgent: request.headers.get('user-agent')?.slice(0, 400) ?? null,
    language: firstLanguage(request.headers.get('accept-language')),
    // Our own pages send same-origin referrers only; anything else shows where the link was posted.
    referrer: referrer && !referrer.startsWith(new URL(request.url).origin) ? referrer.slice(0, 200) : null,
    deviceId,
    newDevice,
  };
}

/** A page load in a browser tab (not a script, image or API call). */
function isPageView(request: Request, pathname: string): boolean {
  if (request.method !== 'GET' || pathname.startsWith('/api/') || pathname.startsWith('/assets/')) return false;
  const dest = request.headers.get('sec-fetch-dest');
  return dest ? dest === 'document' : (request.headers.get('accept') ?? '').includes('text/html');
}

function forward(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set(ORIGIN_HEADER, url.origin);
  // `wrangler dev` has no real edge location; X-Dev-Country simulates one, in development only.
  const devCountry = env.NODE_ENV === 'development' ? request.headers.get('x-dev-country') : null;
  const country = devCountry ?? request.cf?.country;
  headers.set(COUNTRY_HEADER, typeof country === 'string' ? country : '');
  headers.set(VISITOR_HEADER, JSON.stringify(edgeDetails(request)));
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set('x-forwarded-for', ip);
  else headers.delete('x-forwarded-for');
  const stub = env.STORE.get(env.STORE.idFromName(STORE_NAME));
  return stub.fetch(new Request(request, { headers }));
}

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),

  async scheduled(_controller, env) {
    await env.STORE.get(env.STORE.idFromName(STORE_NAME)).housekeeping();
  },
} satisfies ExportedHandler<Env>;

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  // IP allowlist: other addresses get a bare 403 for everything. Webhooks and the game
  // plugin stay reachable because they come from the providers' and the game server's own
  // addresses and are authenticated by their signatures.
  const allowedIps = env.ALLOWED_IPS?.trim();
  if (allowedIps && !isOpenPath(pathname) && !ipAllowed(request.headers.get('cf-connecting-ip'), allowedIps)) {
    return ipRefusal();
  }
  const store = env.STORE.get(env.STORE.idFromName(STORE_NAME));
  // Random per-browser id, so the log shows whether a visit comes from a device seen before.
  const existingDevice = readDeviceId(request.headers.get('cookie'));
  const deviceId = existingDevice ?? newDeviceId();
  const logging = Boolean(env.DISCORD_WEBHOOK_URL) && !isOpenPath(pathname);
  const log = (event: SiteEvent) => {
    if (logging) ctx.waitUntil(store.logEvent(event, url.origin).catch((err: unknown) => console.error('Activity log failed', err)));
  };

  let response: Response | null = null;
  // Members-only mode: nothing (pages, files or API) is served without the access cookie.
  const password = env.ACCESS_PASSWORD?.trim();
  if (password) {
    const limiter = { isBlocked: (ip: string) => store.accessBlocked(ip), recordFailure: (ip: string) => store.accessFailed(ip) };
    response = await gate(request, password, content.site.name, Math.floor(Date.now() / 1000), limiter, (type) =>
      log({ type, visitor: visitor(request, deviceId, !existingDevice), path: pathname }),
    );
  }
  if (!response) {
    if (isPageView(request, pathname)) log({ type: 'member.visit', visitor: visitor(request, deviceId, !existingDevice), path: pathname });
    response = pathname === '/api' || pathname.startsWith('/api/') ? await forward(request, env) : await env.ASSETS.fetch(request);
  }
  if (existingDevice || isOpenPath(pathname)) return response;
  const withCookie = new Response(response.body, response);
  withCookie.headers.append('Set-Cookie', deviceCookie(deviceId, url.protocol === 'https:'));
  return withCookie;
}
