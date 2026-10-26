import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { loadContent, priceCents } from '../src/content.js';
import { GeoIp, ipv6ToBigInt } from '../src/geo/geoip.js';
import { routeProviders } from '../src/geo/routing.js';
import { formatMoney, majorToMinor } from '../src/lib/util.js';
import { nextWipe, zonedParts } from '../src/lib/wipe.js';
import { computeAccess, isActive } from '../src/store/entitlements.js';
import type { ProviderId } from '../src/config.js';

const configDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../config');
const content = loadContent(configDir);

describe('catalog pricing', () => {
  it('uses 5/20/30/50/100 as the 30-day prices', () => {
    const d30 = content.catalog.durations.find((d) => d.id === '30d')!;
    expect(content.catalog.kits.map((k) => priceCents(k, d30))).toEqual([500, 2000, 3000, 5000, 10000]);
  });

  it('scales prices by duration', () => {
    const table = Object.fromEntries(
      content.catalog.kits.map((k) => [k.id, content.catalog.durations.map((d) => priceCents(k, d))]),
    );
    expect(table).toEqual({
      scrapper: [200, 500, 1200, 2500],
      builder: [800, 2000, 4800, 10000],
      ranger: [1200, 3000, 7200, 15000],
      warlord: [2000, 5000, 12000, 25000],
      overlord: [4000, 10000, 24000, 50000],
    });
  });

  it('formats money', () => {
    expect(formatMoney(500, 'USD')).toBe('$5');
    expect(formatMoney(1250, 'USD')).toBe('$12.50');
    expect(formatMoney(4750, 'CLP')).toBe('CLP 4,750');
    expect(majorToMinor(4750, 'CLP')).toBe(4750);
    expect(majorToMinor(5, 'USD')).toBe(500);
  });
});

describe('wipe schedule', () => {
  const slots = [{ weekday: 4, time: '14:00' }];

  it('finds the next Thursday 2 PM in New York during daylight time', () => {
    // Monday 2026-10-26 12:00 UTC
    const now = Date.UTC(2026, 9, 26, 12, 0);
    expect(new Date(nextWipe(now, 'America/New_York', slots)!).toISOString()).toBe('2026-10-29T18:00:00.000Z');
  });

  it('handles the switch back to standard time', () => {
    // Friday 2026-10-30, the following Thursday is after the Nov 1 DST change (UTC-5).
    const now = Date.UTC(2026, 9, 30, 12, 0);
    expect(new Date(nextWipe(now, 'America/New_York', slots)!).toISOString()).toBe('2026-11-05T19:00:00.000Z');
  });

  it('skips a wipe that already happened today', () => {
    const now = Date.UTC(2026, 9, 29, 18, 0, 1);
    expect(new Date(nextWipe(now, 'America/New_York', slots)!).toISOString()).toBe('2026-11-05T19:00:00.000Z');
  });

  it('reports local weekday', () => {
    expect(zonedParts(Date.UTC(2026, 9, 29, 18, 0), 'America/New_York').weekday).toBe(4);
  });
});

describe('entitlement replay', () => {
  const day = 86_400;

  it('stacks timed purchases', () => {
    const access = computeAccess([
      { granted_at: 1000, days: 30, revoked_at: null },
      { granted_at: 2000, days: 7, revoked_at: null },
    ]);
    expect(access).toEqual({ lifetime: false, expiresAt: 1000 + 37 * day });
  });

  it('starts a new grant at purchase time after a gap', () => {
    const access = computeAccess([
      { granted_at: 0, days: 7, revoked_at: null },
      { granted_at: 30 * day, days: 7, revoked_at: null },
    ]);
    expect(access).toEqual({ lifetime: false, expiresAt: 37 * day });
  });

  it('drops revoked grants from the replay', () => {
    const access = computeAccess([
      { granted_at: 1000, days: 30, revoked_at: 5000 },
      { granted_at: 2000, days: 30, revoked_at: null },
    ]);
    expect(access).toEqual({ lifetime: false, expiresAt: 2000 + 30 * day });
  });

  it('treats lifetime as permanent and handles empty input', () => {
    expect(computeAccess([{ granted_at: 1, days: null, revoked_at: null }])).toEqual({ lifetime: true, expiresAt: null });
    expect(computeAccess([])).toBeNull();
    expect(isActive({ lifetime: false, expiresAt: 10 }, 11)).toBe(false);
    expect(isActive({ lifetime: true, expiresAt: null }, 10 ** 12)).toBe(true);
  });
});

describe('geo routing', () => {
  const all = new Set<ProviderId>(['stripe', 'paypal', 'mercadopago']);

  it('routes US to Stripe and South America to Mercado Pago', () => {
    expect(routeProviders('US', content.payments, all)).toMatchObject({ region: 'United States', providers: ['stripe'] });
    for (const cc of ['CL', 'AR', 'BR', 'PE', 'CO', 'UY']) {
      expect(routeProviders(cc, content.payments, all).providers).toEqual(['mercadopago']);
    }
    expect(routeProviders('DE', content.payments, all)).toMatchObject({ region: 'International', providers: ['stripe', 'paypal'] });
    expect(routeProviders(null, content.payments, all).providers).toEqual(['stripe', 'paypal']);
  });

  it('falls back when a region provider is not configured', () => {
    const onlyPaypal = new Set<ProviderId>(['paypal']);
    expect(routeProviders('US', content.payments, onlyPaypal).providers).toEqual(['paypal']);
    expect(routeProviders('CL', content.payments, onlyPaypal).providers).toEqual(['paypal']);
    const onlyMp = new Set<ProviderId>(['mercadopago']);
    expect(routeProviders('US', content.payments, onlyMp).providers).toEqual(['mercadopago']);
  });

  it('parses IPv6 including embedded IPv4 and compression', () => {
    expect(ipv6ToBigInt('::1')).toBe(1n);
    expect(ipv6ToBigInt('2001:db8::1')).toBe(0x20010db8000000000000000000000001n);
    expect(ipv6ToBigInt('::ffff:1.2.3.4')).toBe(0xffff01020304n);
    expect(ipv6ToBigInt('not-an-ip')).toBeNull();
  });

  it('looks up ranges from numeric CSV', () => {
    const geo = new GeoIp('/nonexistent', pino({ level: 'silent' }));
    geo.loadFromText(
      ['16777216,16777471,AU', '134744064,134744319,US', '3355443200,3355443455,CL'].join('\n'),
      ['42541956101370907050197289607612071936,42541956180599069564461627201156022271,US'].join('\n'),
    );
    expect(geo.lookup('1.0.0.1')).toBe('AU');
    expect(geo.lookup('8.8.8.8')).toBe('US');
    expect(geo.lookup('::ffff:8.8.8.8')).toBe('US');
    expect(geo.lookup('200.0.0.10')).toBe('CL');
    expect(geo.lookup('9.9.9.9')).toBeNull();
    expect(geo.lookup('192.168.1.10')).toBeNull();
    expect(geo.lookup('2001:4860::8888')).toBe('US');
  });

  const realDb = process.env.GEOIP_TEST_DIR;
  it.skipIf(!realDb || !fs.existsSync(path.join(realDb ?? '', 'user-country-ipv4-num.csv')))('resolves real addresses with the downloaded database', () => {
    const geo = new GeoIp(realDb!, pino({ level: 'silent' }));
    expect(geo.loadFromDisk()).toBe(true);
    expect(geo.lookup('8.8.8.8')).toBe('US');
    expect(geo.lookup('2001:4860:4860::8888')).toBe('US');
  });
});
