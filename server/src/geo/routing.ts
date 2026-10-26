import type { Request } from 'express';
import type { AppConfig, ProviderId } from '../config.js';
import type { PaymentsConfig } from '../content.js';
/** Country lookup by IP. Node uses the downloaded database (geoip.ts); Cloudflare passes the edge country in a header instead. */
export interface GeoLookup {
  readonly ready: boolean;
  lookup(ip: string | undefined | null): string | null;
}

export const noGeoLookup: GeoLookup = { ready: false, lookup: () => null };

export interface CountryResolution {
  country: string | null;
  source: 'header' | 'geoip' | 'dev' | 'unknown';
}

export interface RouteResult {
  country: string | null;
  region: string;
  providers: ProviderId[];
}

const INVALID_HEADER_VALUES = new Set(['XX', 'T1', 'A1', 'A2', 'O1', 'EU', 'AP']);

export function resolveCountry(req: Request, config: AppConfig, geo: GeoLookup): CountryResolution {
  if (config.dev.forceCountry) return { country: config.dev.forceCountry, source: 'dev' };
  if (config.geo.header) {
    const raw = req.get(config.geo.header);
    const value = raw?.trim().toUpperCase();
    if (value && /^[A-Z]{2}$/.test(value) && !INVALID_HEADER_VALUES.has(value)) {
      return { country: value, source: 'header' };
    }
  }
  const fromDb = geo.lookup(req.ip);
  if (fromDb) return { country: fromDb, source: 'geoip' };
  return { country: null, source: 'unknown' };
}

/**
 * Picks the payment providers offered to a buyer from a given country.
 * Region rules come first; providers that are not configured are skipped,
 * falling back to the default list and finally to any enabled provider.
 */
export function routeProviders(country: string | null, payments: PaymentsConfig, enabled: ReadonlySet<ProviderId>): RouteResult {
  const rule = country ? payments.routing.rules.find((r) => r.countries.includes(country)) : undefined;
  const pick = (list: ProviderId[]) => [...new Set(list)].filter((p) => enabled.has(p));

  if (rule) {
    const fromRule = pick(rule.providers);
    if (fromRule.length > 0) return { country, region: rule.name, providers: fromRule };
  }
  const fromDefault = pick(payments.routing.default);
  if (fromDefault.length > 0) return { country, region: 'International', providers: fromDefault };
  return { country, region: 'International', providers: [...enabled] };
}
