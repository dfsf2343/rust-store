import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const flag = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  BASE_URL: optionalString,
  DATA_DIR: optionalString,
  CONFIG_DIR: optionalString,
  WEB_DIST_DIR: optionalString,
  TRUST_PROXY: z.string().default('loopback,linklocal,uniquelocal'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  STEAM_API_KEY: optionalString,
  ADMIN_STEAM_IDS: optionalString,
  PLUGIN_SECRET: optionalString,
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  STRIPE_API_BASE: optionalString,
  PAYPAL_CLIENT_ID: optionalString,
  PAYPAL_CLIENT_SECRET: optionalString,
  // Unset means live in production and sandbox everywhere else.
  PAYPAL_ENV: z.enum(['sandbox', 'live']).optional(),
  MERCADOPAGO_ACCESS_TOKEN: optionalString,
  MERCADOPAGO_WEBHOOK_SECRET: optionalString,
  MERCADOPAGO_USE_SANDBOX_URL: flag(false),
  GEOIP_HEADER: optionalString,
  GEOIP_AUTO_UPDATE: flag(true),
  GEOIP_BASE_URL: z.string().default('https://github.com/sapics/ip-location-db/releases/download'),
  DEV_LOGIN: flag(false),
  DEV_FORCE_COUNTRY: optionalString,
});

export type ProviderId = 'stripe' | 'paypal' | 'mercadopago';

export type Runtime = 'node' | 'cloudflare';

export interface AppConfig {
  runtime: Runtime;
  env: 'development' | 'production' | 'test';
  isProd: boolean;
  port: number;
  host: string;
  baseUrl: string;
  baseOrigin: string;
  dataDir: string;
  configDir: string;
  webDistDir: string | null;
  trustProxy: string;
  logLevel: z.infer<typeof EnvSchema>['LOG_LEVEL'];
  steamApiKey: string | null;
  adminSteamIds: Set<string>;
  pluginSecret: string | null;
  stripe: { secretKey: string; webhookSecret: string | null; apiBase: URL | null } | null;
  paypal: { clientId: string; clientSecret: string; env: 'sandbox' | 'live' } | null;
  mercadopago: { accessToken: string; webhookSecret: string | null; useSandboxUrl: boolean } | null;
  geo: { header: string | null; autoUpdate: boolean; baseUrl: string };
  dev: { login: boolean; forceCountry: string | null };
  warnings: string[];
}

const STEAM_ID_RE = /^7656119\d{10}$/;

function firstExistingDir(candidates: string[]): string | null {
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
  }
  return null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env, runtime: Runtime = 'node'): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === 'production';
  const warnings: string[] = [];

  if (isProd && !e.BASE_URL) {
    throw new Error('BASE_URL is required in production (for example https://store.example.com).');
  }
  const baseUrl = (e.BASE_URL ?? `http://localhost:${e.PORT}`).replace(/\/+$/, '');
  let baseOrigin: string;
  try {
    baseOrigin = new URL(baseUrl).origin;
  } catch {
    throw new Error(`BASE_URL is not a valid URL: ${baseUrl}`);
  }
  if (isProd && !baseUrl.startsWith('https://')) {
    warnings.push('BASE_URL does not use https. Payment providers and Steam login require HTTPS in production.');
  }

  // On Cloudflare the config files are bundled, the database lives in a Durable Object
  // and static files are served by Workers Static Assets, so no paths are needed.
  let configDir = '';
  let dataDir = '';
  let webDistDir: string | null = null;
  if (runtime === 'node') {
    const cwd = process.cwd();
    const foundConfig = e.CONFIG_DIR
      ? path.resolve(e.CONFIG_DIR)
      : firstExistingDir([path.resolve(cwd, 'config'), path.resolve(cwd, '../config')]);
    if (!foundConfig) throw new Error('Could not find the config directory. Set CONFIG_DIR.');
    configDir = foundConfig;
    dataDir = path.resolve(e.DATA_DIR ?? path.resolve(cwd, 'data'));
    webDistDir = e.WEB_DIST_DIR
      ? path.resolve(e.WEB_DIST_DIR)
      : firstExistingDir([path.resolve(cwd, 'web/dist'), path.resolve(cwd, '../web/dist')]);
  }

  const adminSteamIds = new Set(
    (e.ADMIN_STEAM_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const id of adminSteamIds) {
    if (!STEAM_ID_RE.test(id)) throw new Error(`ADMIN_STEAM_IDS contains an invalid SteamID64: ${id}`);
  }

  if (e.PLUGIN_SECRET && e.PLUGIN_SECRET.length < 32) {
    throw new Error('PLUGIN_SECRET must be at least 32 characters long.');
  }
  if (!e.PLUGIN_SECRET) warnings.push('PLUGIN_SECRET is not set: the game server plugin cannot connect.');

  let stripeApiBase: URL | null = null;
  if (e.STRIPE_API_BASE) {
    // Only for local testing against a mock Stripe API.
    if (isProd) warnings.push('STRIPE_API_BASE is ignored in production.');
    else stripeApiBase = new URL(e.STRIPE_API_BASE);
  }
  // Without the webhook, refunds and disputes would never remove access, so production
  // keeps Stripe switched off until both values are set.
  let stripe: AppConfig['stripe'] = e.STRIPE_SECRET_KEY
    ? { secretKey: e.STRIPE_SECRET_KEY, webhookSecret: e.STRIPE_WEBHOOK_SECRET ?? null, apiBase: stripeApiBase }
    : null;
  if (stripe && !stripe.webhookSecret) {
    if (isProd) {
      warnings.push('Stripe is disabled: set STRIPE_WEBHOOK_SECRET as well as STRIPE_SECRET_KEY.');
      stripe = null;
    } else {
      warnings.push('STRIPE_WEBHOOK_SECRET is not set: refunds and disputes will not remove access.');
    }
  }

  const paypal =
    e.PAYPAL_CLIENT_ID && e.PAYPAL_CLIENT_SECRET
      ? { clientId: e.PAYPAL_CLIENT_ID, clientSecret: e.PAYPAL_CLIENT_SECRET, env: e.PAYPAL_ENV ?? (isProd ? 'live' : 'sandbox') }
      : null;
  if (!paypal && (e.PAYPAL_CLIENT_ID || e.PAYPAL_CLIENT_SECRET)) {
    warnings.push('PayPal is disabled: both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required.');
  }

  let mercadopago: AppConfig['mercadopago'] = e.MERCADOPAGO_ACCESS_TOKEN
    ? {
        accessToken: e.MERCADOPAGO_ACCESS_TOKEN,
        webhookSecret: e.MERCADOPAGO_WEBHOOK_SECRET ?? null,
        useSandboxUrl: e.MERCADOPAGO_USE_SANDBOX_URL,
      }
    : null;
  if (mercadopago && !mercadopago.webhookSecret) {
    if (isProd) {
      warnings.push('Mercado Pago is disabled: set MERCADOPAGO_WEBHOOK_SECRET as well as MERCADOPAGO_ACCESS_TOKEN.');
      mercadopago = null;
    } else {
      warnings.push('MERCADOPAGO_WEBHOOK_SECRET is not set: refunds and chargebacks will not remove access.');
    }
  }

  let devLogin = e.DEV_LOGIN;
  let forceCountry = e.DEV_FORCE_COUNTRY ? e.DEV_FORCE_COUNTRY.toUpperCase() : null;
  if (isProd && (devLogin || forceCountry)) {
    warnings.push('DEV_LOGIN and DEV_FORCE_COUNTRY are ignored in production.');
    devLogin = false;
    forceCountry = null;
  }
  if (forceCountry && !/^[A-Z]{2}$/.test(forceCountry)) {
    throw new Error('DEV_FORCE_COUNTRY must be a two-letter country code.');
  }

  return {
    runtime,
    env: e.NODE_ENV,
    isProd,
    port: e.PORT,
    host: e.HOST,
    baseUrl,
    baseOrigin,
    dataDir,
    configDir,
    webDistDir,
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL,
    steamApiKey: e.STEAM_API_KEY ?? null,
    adminSteamIds,
    pluginSecret: e.PLUGIN_SECRET ?? null,
    stripe,
    paypal,
    mercadopago,
    geo: {
      header: e.GEOIP_HEADER ? e.GEOIP_HEADER.toLowerCase() : null,
      autoUpdate: e.GEOIP_AUTO_UPDATE,
      baseUrl: e.GEOIP_BASE_URL.replace(/\/+$/, ''),
    },
    dev: { login: devLogin, forceCountry },
    warnings,
  };
}
