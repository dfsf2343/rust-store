/**
 * Demo build only: an in-browser stand-in for the store API, so the site can be shown
 * without a backend. It reads the real config files, keeps a small world of sample
 * orders in sessionStorage and simulates payments. Nothing here ships in the real site.
 */
import rawCatalog from '../../../config/catalog.json';
import rawPayments from '../../../config/payments.json';
import rawSite from '../../../config/site.json';
import { nextWipe } from '../../../server/src/lib/wipe';
import { ApiError, type Catalog, type CheckoutOptions, type Me, type Order, type OrderStatus, type ProviderId, type ServerStatus, type Site } from '../api';

// ---------- Config, with the same defaults the server's schema applies ----------

interface RawDuration {
  id: string;
  label: string;
  days: number | null;
  multiplier: number;
  default?: boolean;
  badge?: string;
}
interface RawKit {
  id: string;
  name: string;
  tier: number;
  basePrice: number;
  cooldownHours: number;
  tagline?: string;
  prices?: Record<string, number>;
  hidden?: boolean;
  items: { shortname: string; name: string; amount: number; category?: string }[];
}
interface RawPayments {
  routing: { rules: { name: string; countries: string[]; providers: ProviderId[] }[]; default: ProviderId[] };
  mercadopago: { currency: string; usdRate: number; roundTo?: number };
}

const site = rawSite as unknown as Site;
const durations = (rawCatalog as unknown as { durations: RawDuration[] }).durations;
const kits = (rawCatalog as unknown as { kits: RawKit[] }).kits.filter((k) => !k.hidden);
const payments = rawPayments as unknown as RawPayments;
const COMMAND = site.store.inGameCommand;

const ZERO_DECIMAL = new Set(['CLP', 'JPY', 'KRW', 'PYG', 'VND', 'UGX', 'XAF', 'XOF']);

function formatMoney(amountMinor: number, currency: string): string {
  const decimals = ZERO_DECIMAL.has(currency) ? 0 : 2;
  const value = amountMinor / 10 ** decimals;
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals === 0 || Number.isInteger(value) ? 0 : decimals,
    maximumFractionDigits: decimals,
  }).format(value);
  return currency === 'USD' ? `$${formatted}` : `${currency} ${formatted}`;
}

function priceCents(kit: RawKit, duration: RawDuration): number {
  return Math.round((kit.prices?.[duration.id] ?? kit.basePrice * duration.multiplier) * 100);
}

const catalog: Catalog = {
  currency: 'USD',
  durations: durations.map((d) => ({ id: d.id, label: d.label, days: d.days, badge: d.badge ?? null, default: d.default ?? false })),
  kits: kits.map((k) => ({
    id: k.id,
    name: k.name,
    tier: k.tier,
    tagline: k.tagline ?? '',
    cooldownHours: k.cooldownHours,
    items: k.items.map((i) => ({ ...i, category: (i.category ?? 'misc') as Catalog['kits'][number]['items'][number]['category'] })),
    prices: Object.fromEntries(durations.map((d) => [d.id, { cents: priceCents(k, d), display: formatMoney(priceCents(k, d), 'USD') }])),
  })),
};

const PROVIDERS: Record<ProviderId, { label: string; description: string }> = {
  stripe: { label: 'Card / Apple Pay / Google Pay', description: 'Secure checkout powered by Stripe.' },
  paypal: { label: 'PayPal', description: 'Pay with your PayPal balance or a linked card.' },
  mercadopago: { label: 'Mercado Pago', description: 'Cards, Mercado Pago balance and local payment methods.' },
};

function quote(provider: ProviderId, amountCents: number): { amount: number; currency: string } {
  if (provider !== 'mercadopago') return { amount: amountCents, currency: 'USD' };
  const mp = payments.mercadopago;
  const roundTo = mp.roundTo ?? 1;
  const local = (amountCents / 100) * mp.usdRate;
  const rounded = Math.ceil(local / roundTo - 1e-9) * roundTo;
  return { amount: Math.round(rounded * (ZERO_DECIMAL.has(mp.currency) ? 1 : 100)), currency: mp.currency };
}

function route(country: string): { region: string; providers: ProviderId[] } {
  const rule = payments.routing.rules.find((r) => r.countries.includes(country));
  return rule ? { region: rule.name, providers: rule.providers } : { region: 'International', providers: payments.routing.default };
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

// ---------- Demo world ----------

type Role = 'player' | 'admin';

const PEOPLE: Record<Role, { steamId: string; name: string; isAdmin: boolean }> = {
  player: { steamId: '76561198000000042', name: 'You (demo)', isAdmin: false },
  admin: { steamId: '76561198000000001', name: 'Admin (demo)', isAdmin: true },
};

interface DemoOrder {
  id: string;
  steamId: string;
  kitId: string;
  durationId: string;
  provider: ProviderId;
  providerRef: string;
  status: OrderStatus;
  statusDetail: string | null;
  country: string | null;
  amountCents: number;
  chargeAmount: number;
  chargeCurrency: string;
  createdAt: number;
  paidAt: number | null;
  payAt: number | null;
}

interface DemoGrant {
  id: number;
  steamId: string;
  kitId: string;
  days: number | null;
  grantedAt: number;
  source: 'order' | 'admin';
  orderId: string | null;
  note: string | null;
  createdBy: string | null;
  revokedAt: number | null;
  revokedReason: string | null;
}

interface DemoState {
  version: 2;
  role: Role | null;
  country: string;
  orders: DemoOrder[];
  grants: DemoGrant[];
  claims: { steamId: string; kitId: string; claimedAt: number; serverId: string }[];
  names: Record<string, string>;
  banned: string[];
  nextGrant: number;
}

const STORAGE_KEY = 'rust-store-demo';
const now = () => Math.floor(Date.now() / 1000);

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** Sample orders from other players over the last month, so the admin page has something to show. */
function seed(): DemoState {
  const r = rng(7);
  const t = now();
  const names = ['Ironfist', 'nomad', 'Kestrel', 'rockhead', 'Vex', 'DrPipe', 'salt', 'Moth', 'Harbinger', 'bagel', 'Juno', 'Tarp', 'Quill', 'Ash'];
  const countries = ['US', 'US', 'US', 'CA', 'CL', 'AR', 'BR', 'DE', 'GB', 'PE', 'US', 'MX', 'CL', 'AU'];
  const state: DemoState = { version: 2, role: null, country: 'US', orders: [], grants: [], claims: [], names: {}, banned: [], nextGrant: 1 };
  names.forEach((n, i) => {
    state.names[`7656119800000${String(1100 + i)}`] = n;
  });
  const pick = <T,>(list: T[]) => list[Math.floor(r() * list.length)]!;
  const weightedKits = ['scrapper', 'scrapper', 'builder', 'builder', 'ranger', 'warlord', 'overlord'].filter((id) => kits.some((k) => k.id === id));
  const weightedDurations = ['7d', '30d', '30d', '30d', '90d', 'lifetime'].filter((id) => durations.some((d) => d.id === id));
  for (let i = 0; i < 26; i++) {
    const who = i % names.length;
    const steamId = `7656119800000${String(1100 + who)}`;
    const country = countries[who]!;
    const kit = kits.find((k) => k.id === pick(weightedKits)) ?? kits[0]!;
    const duration = durations.find((d) => d.id === pick(weightedDurations)) ?? durations[0]!;
    const { providers } = route(country);
    const provider = providers[Math.floor(r() * providers.length)]!;
    const amountCents = priceCents(kit, duration);
    const charge = quote(provider, amountCents);
    const createdAt = t - Math.floor(r() * 29 * 86_400) - 3600;
    state.orders.push({
      id: randomId('ord'),
      steamId,
      kitId: kit.id,
      durationId: duration.id,
      provider,
      providerRef: provider === 'stripe' ? randomId('cs_live') : provider === 'paypal' ? `${Math.floor(r() * 9e15)}` : `${Math.floor(r() * 9e10)}`,
      status: 'paid',
      statusDetail: null,
      country,
      amountCents,
      chargeAmount: charge.amount,
      chargeCurrency: charge.currency,
      createdAt,
      paidAt: createdAt + 20 + Math.floor(r() * 90),
      payAt: null,
    });
  }
  state.orders.sort((a, b) => b.createdAt - a.createdAt);
  // A few orders that need staff, as they would in real life.
  const mp = state.orders.find((o) => o.provider === 'mercadopago');
  if (mp) Object.assign(mp, { status: 'review', statusDetail: `Mercado Pago amount mismatch: ${mp.chargeAmount - 500} ${mp.chargeCurrency}`, paidAt: null });
  const stripe = state.orders.find((o) => o.provider === 'stripe' && o.status === 'paid');
  if (stripe) Object.assign(stripe, { status: 'disputed', statusDetail: 'Stripe dispute opened (fraudulent)' });
  const paypal = state.orders.find((o) => o.provider === 'paypal' && o.status === 'paid');
  if (paypal) paypal.statusDetail = 'Partially refunded in PayPal';
  const expired = state.orders.filter((o) => o.status === 'paid')[5];
  if (expired) Object.assign(expired, { status: 'expired', statusDetail: 'Checkout not completed', paidAt: null });

  for (const o of state.orders) {
    if (o.status !== 'paid' && o.status !== 'disputed') continue;
    const duration = durations.find((d) => d.id === o.durationId)!;
    state.grants.push({
      id: state.nextGrant++,
      steamId: o.steamId,
      kitId: o.kitId,
      days: duration.days,
      grantedAt: o.paidAt ?? o.createdAt,
      source: 'order',
      orderId: o.id,
      note: null,
      createdBy: null,
      revokedAt: o.status === 'disputed' ? (o.paidAt ?? o.createdAt) + 3 * 86_400 : null,
      revokedReason: o.status === 'disputed' ? o.statusDetail : null,
    });
    if (o.status === 'paid' && r() < 0.8) {
      state.claims.push({ steamId: o.steamId, kitId: o.kitId, claimedAt: Math.min(t - 600, (o.paidAt ?? o.createdAt) + Math.floor(r() * 2 * 86_400)), serverId: 'main' });
    }
  }
  return state;
}

function load(): DemoState {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DemoState;
      if (parsed.version === 2) return parsed;
    }
  } catch {
    // Storage blocked or corrupt: start a fresh world.
  }
  return seed();
}

let state = load();

function save(): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The demo keeps working in memory.
  }
}

export function demoCountry(): string {
  return state.country;
}

export function setDemoCountry(code: string): void {
  state.country = code;
  save();
}

export function resetDemo(): void {
  state = seed();
  save();
}

// ---------- Views (same shapes as the real API) ----------

function currentUser() {
  return state.role ? PEOPLE[state.role] : null;
}

function requireUser() {
  const user = currentUser();
  if (!user) throw new ApiError(401, 'Sign in through Steam first.', 'unauthorized');
  return user;
}

function requireAdmin() {
  const user = requireUser();
  if (!user.isAdmin) throw new ApiError(403, 'Admins only.', 'forbidden');
  return user;
}

function access(steamId: string, kitId: string): { lifetime: boolean; expiresAt: number | null } | null {
  const active = state.grants.filter((g) => g.steamId === steamId && g.kitId === kitId && g.revokedAt === null).sort((a, b) => a.grantedAt - b.grantedAt);
  if (active.length === 0) return null;
  let lifetime = false;
  let expiresAt: number | null = null;
  for (const g of active) {
    if (g.days === null) {
      lifetime = true;
      continue;
    }
    expiresAt = Math.max(g.grantedAt, expiresAt ?? 0) + g.days * 86_400;
  }
  if (lifetime) return { lifetime: true, expiresAt: null };
  return expiresAt === null ? null : { lifetime: false, expiresAt };
}

function kitsFor(steamId: string) {
  const t = now();
  return kits
    .map((kit) => {
      const a = access(steamId, kit.id);
      if (!a || (!a.lifetime && (a.expiresAt ?? 0) <= t)) return null;
      const last = state.claims.filter((c) => c.steamId === steamId && c.kitId === kit.id).reduce<number | null>((m, c) => (m === null || c.claimedAt > m ? c.claimedAt : m), null);
      const next = last !== null ? last + Math.round(kit.cooldownHours * 3600) : null;
      return {
        kitId: kit.id,
        kitName: kit.name,
        tier: kit.tier,
        lifetime: a.lifetime,
        expiresAt: a.expiresAt,
        lastClaimAt: last,
        nextClaimAt: next !== null && next > t ? next : null,
        command: `/${COMMAND} ${kit.id}`,
      };
    })
    .filter((k): k is NonNullable<typeof k> => k !== null);
}

function orderView(o: DemoOrder): Order {
  const kit = kits.find((k) => k.id === o.kitId);
  const duration = durations.find((d) => d.id === o.durationId);
  return {
    id: o.id,
    status: o.status,
    statusDetail: o.status === 'review' ? 'Payment received, waiting for staff review.' : o.statusDetail,
    kit: { id: o.kitId, name: kit?.name ?? o.kitId },
    duration: { id: o.durationId, label: duration?.label ?? o.durationId, days: duration?.days ?? null },
    amount: { cents: o.amountCents, currency: 'USD', display: formatMoney(o.amountCents, 'USD') },
    charge: { amount: o.chargeAmount, currency: o.chargeCurrency, display: formatMoney(o.chargeAmount, o.chargeCurrency) },
    provider: o.provider,
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    command: `/${COMMAND} ${o.kitId}`,
  };
}

function adminOrderView(o: DemoOrder) {
  return { ...orderView(o), steamId: o.steamId, country: o.country, providerRef: o.providerRef };
}

/** Delivers a kit for an order: what the payment webhook does on the real site. */
function fulfill(o: DemoOrder, actor: string | null = null): void {
  const t = now();
  o.status = 'paid';
  o.statusDetail = null;
  o.paidAt = t;
  o.payAt = null;
  const duration = durations.find((d) => d.id === o.durationId);
  state.grants.push({
    id: state.nextGrant++,
    steamId: o.steamId,
    kitId: o.kitId,
    days: duration?.days ?? null,
    grantedAt: t,
    source: 'order',
    orderId: o.id,
    note: null,
    createdBy: actor,
    revokedAt: null,
    revokedReason: null,
  });
}

/** The simulated payment clears a few seconds after checkout. */
function settle(o: DemoOrder): void {
  if (o.status === 'pending' && o.payAt !== null && now() >= o.payAt) fulfill(o);
}

function status(): ServerStatus & { wipedAt: number | null } {
  const t = Date.now();
  // A believable evening curve that changes slowly between page loads.
  const minute = Math.floor(t / 60_000);
  const players = 86 + Math.round(Math.sin(minute / 47) * 14) + (minute % 5);
  return {
    online: true,
    updatedAt: now() - 7,
    hostname: site.name,
    players,
    maxPlayers: 150,
    queued: players > 140 ? 3 : 0,
    joining: minute % 3,
    worldSize: 4000,
    seed: 1337,
    wipedAt: null,
    nextWipeAt: nextWipe(t, site.wipe.timezone, site.wipe.slots),
    wipeLabel: site.wipe.label,
    connect: site.connect.address,
    command: COMMAND,
  };
}

function findOrder(id: string): DemoOrder {
  const o = state.orders.find((x) => x.id === id);
  if (!o) throw new ApiError(404, 'Order not found.', 'not_found');
  return o;
}

// ---------- Router ----------

type Init = { method?: 'GET' | 'POST'; body?: unknown };
type Handler = (match: RegExpExecArray, query: URLSearchParams, body: Record<string, unknown>) => unknown;

const routes: { method: 'GET' | 'POST'; pattern: RegExp; handler: Handler }[] = [];
const on = (method: 'GET' | 'POST', pattern: RegExp, handler: Handler) => routes.push({ method, pattern, handler });

on('GET', /^\/site$/, () => site);
on('GET', /^\/catalog$/, () => catalog);
on('GET', /^\/status$/, () => status());
on('GET', /^\/me$/, (): Me => {
  const user = currentUser();
  return {
    user: user ? { steamId: user.steamId, name: user.name, avatarUrl: null, isAdmin: user.isAdmin, banned: state.banned.includes(user.steamId) } : null,
    devLogin: false,
  };
});

on('POST', /^\/auth\/demo-login$/, (_m, _q, body) => {
  state.role = body.role === 'admin' ? 'admin' : 'player';
  return { ok: true };
});
on('POST', /^\/auth\/logout$/, () => {
  state.role = null;
  return { ok: true };
});

on('GET', /^\/account$/, () => {
  const user = requireUser();
  const orders = state.orders.filter((o) => o.steamId === user.steamId).sort((a, b) => b.createdAt - a.createdAt);
  orders.forEach(settle);
  return {
    user: { steamId: user.steamId, name: user.name, avatarUrl: null, banned: state.banned.includes(user.steamId) },
    kits: kitsFor(user.steamId),
    orders: orders.map(orderView),
  };
});

on('GET', /^\/checkout\/options$/, (_m, query): CheckoutOptions => {
  const kit = kits.find((k) => k.id === query.get('kitId'));
  const duration = durations.find((d) => d.id === query.get('durationId'));
  const amountCents = kit && duration ? priceCents(kit, duration) : null;
  const { region, providers } = route(state.country);
  return {
    country: state.country,
    countryName: regionNames.of(state.country) ?? state.country,
    region,
    providers: providers.map((id) => {
      const q = amountCents !== null ? quote(id, amountCents) : null;
      return { id, ...PROVIDERS[id], charge: q ? { ...q, display: formatMoney(q.amount, q.currency) } : null };
    }),
  };
});

on('POST', /^\/checkout$/, (_m, _q, body) => {
  const user = requireUser();
  if (state.banned.includes(user.steamId)) throw new ApiError(403, 'This account cannot make purchases.', 'banned');
  if (body.acceptTerms !== true) throw new ApiError(400, 'acceptTerms: You must accept the terms and refund policy', 'invalid_request');
  const kit = kits.find((k) => k.id === body.kitId);
  const duration = durations.find((d) => d.id === body.durationId);
  if (!kit || !duration) throw new ApiError(404, 'That kit or duration is not available.', 'not_found');
  const provider = body.provider as ProviderId;
  if (!route(state.country).providers.includes(provider)) {
    throw new ApiError(400, 'That payment method is not available in your region.', 'provider_unavailable');
  }
  if (access(user.steamId, kit.id)?.lifetime) throw new ApiError(409, `You already own the ${kit.name} kit for life.`, 'already_owned');
  const amountCents = priceCents(kit, duration);
  const charge = quote(provider, amountCents);
  const t = now();
  const order: DemoOrder = {
    id: randomId('ord'),
    steamId: user.steamId,
    kitId: kit.id,
    durationId: duration.id,
    provider,
    providerRef: randomId('demo'),
    status: 'pending',
    statusDetail: null,
    country: state.country,
    amountCents,
    chargeAmount: charge.amount,
    chargeCurrency: charge.currency,
    createdAt: t,
    paidAt: null,
    payAt: t + 3,
  };
  state.orders.unshift(order);
  // The real site sends the buyer to the payment provider here.
  return { orderId: order.id, redirectUrl: `/order/${order.id}` };
});

const orderRoute = (_m: RegExpExecArray) => {
  const user = requireUser();
  const o = findOrder(_m[1]!);
  if (o.steamId !== user.steamId && !user.isAdmin) throw new ApiError(404, 'Order not found.', 'not_found');
  settle(o);
  return orderView(o);
};
on('GET', /^\/orders\/([\w-]+)$/, orderRoute);
on('POST', /^\/orders\/([\w-]+)\/refresh$/, orderRoute);

// Admin
on('GET', /^\/admin\/overview$/, () => {
  requireAdmin();
  state.orders.forEach(settle);
  const t = now();
  const paid = state.orders.filter((o) => o.status === 'paid' && o.paidAt !== null);
  const windows = { day: t - 86_400, week: t - 7 * 86_400, month: t - 30 * 86_400, all: 0 };
  const revenue = Object.fromEntries(
    Object.entries(windows).map(([k, since]) => {
      const rows = paid.filter((o) => o.paidAt! >= since);
      const cents = rows.reduce((s, o) => s + o.amountCents, 0);
      return [k, { orders: rows.length, cents, display: formatMoney(cents, 'USD') }];
    }),
  );
  const month = paid.filter((o) => o.paidAt! >= windows.month);
  const group = (key: (o: DemoOrder) => string) => {
    const m = new Map<string, { orders: number; cents: number }>();
    for (const o of month) {
      const g = m.get(key(o)) ?? { orders: 0, cents: 0 };
      g.orders += 1;
      g.cents += o.amountCents;
      m.set(key(o), g);
    }
    return [...m.entries()].sort((a, b) => b[1].cents - a[1].cents);
  };
  const steamIds = new Set(state.grants.map((g) => `${g.steamId}:${g.kitId}`));
  let active = 0;
  for (const pair of steamIds) {
    const [steamId, kitId] = pair.split(':') as [string, string];
    const a = access(steamId, kitId);
    if (a && (a.lifetime || (a.expiresAt ?? 0) > t)) active += 1;
  }
  return {
    revenue,
    byKit: group((o) => o.kitId).map(([kitId, g]) => ({ kitId, kitName: kits.find((k) => k.id === kitId)?.name ?? kitId, ...g, display: formatMoney(g.cents, 'USD') })),
    byProvider: group((o) => o.provider).map(([provider, g]) => ({ provider, ...g, display: formatMoney(g.cents, 'USD') })),
    activeEntitlements: active,
    attention: state.orders.filter((o) => o.status === 'review' || o.status === 'disputed' || (o.status === 'paid' && o.statusDetail)).map(adminOrderView),
    recent: state.orders.slice(0, 15).map(adminOrderView),
    server: status(),
    system: {
      runtime: 'cloudflare',
      providers: ['stripe', 'paypal', 'mercadopago'],
      stripeWebhooks: true,
      geoipReady: true,
      geoHeader: 'x-store-country',
      pluginConfigured: true,
      warnings: [],
      catalogVersion: 'demo',
    },
  };
});

on('GET', /^\/admin\/orders$/, (_m, query) => {
  requireAdmin();
  const statusFilter = query.get('status');
  const q = query.get('q')?.trim();
  const limit = Number(query.get('limit') ?? 50);
  const rows = state.orders.filter(
    (o) => (!statusFilter || o.status === statusFilter) && (!q || o.id === q || o.steamId === q || o.providerRef === q),
  );
  return { orders: rows.slice(0, limit).map(adminOrderView) };
});

on('POST', /^\/admin\/orders\/([\w-]+)\/refresh$/, (m) => {
  requireAdmin();
  const o = findOrder(m[1]!);
  settle(o);
  return orderView(o);
});

on('POST', /^\/admin\/orders\/([\w-]+)\/approve$/, (m) => {
  const admin = requireAdmin();
  const o = findOrder(m[1]!);
  if (o.status !== 'review') throw new ApiError(409, 'Only orders held for review can be approved.', 'not_in_review');
  fulfill(o, admin.steamId);
  return orderView(o);
});

on('GET', /^\/admin\/players\/(\d+)$/, (m) => {
  requireAdmin();
  const steamId = m[1]!;
  if (!/^7656119\d{10}$/.test(steamId)) throw new ApiError(400, 'Invalid SteamID64.', 'invalid_request');
  const known = Object.values(PEOPLE).find((p) => p.steamId === steamId);
  const name = known?.name ?? state.names[steamId] ?? null;
  const t = now();
  return {
    steamId,
    user: name ? { name, banned: state.banned.includes(steamId), lastLoginAt: t - 3 * 3600 } : null,
    kits: kitsFor(steamId),
    grants: state.grants
      .filter((g) => g.steamId === steamId)
      .sort((a, b) => b.grantedAt - a.grantedAt)
      .map(({ steamId: _s, ...g }) => g),
    orders: state.orders.filter((o) => o.steamId === steamId).map(orderView),
    claims: state.claims
      .filter((c) => c.steamId === steamId)
      .sort((a, b) => b.claimedAt - a.claimedAt)
      .map((c) => ({ kitId: c.kitId, claimedAt: c.claimedAt, serverId: c.serverId })),
  };
});

on('POST', /^\/admin\/grants$/, (_m, _q, body) => {
  const admin = requireAdmin();
  const steamId = String(body.steamId ?? '');
  if (!/^7656119\d{10}$/.test(steamId)) throw new ApiError(400, 'steamId: Invalid SteamID64', 'invalid_request');
  const kit = kits.find((k) => k.id === body.kitId);
  const duration = durations.find((d) => d.id === body.durationId);
  if (!kit || !duration) throw new ApiError(404, 'Unknown kit or duration.', 'not_found');
  const id = state.nextGrant++;
  state.grants.push({
    id,
    steamId,
    kitId: kit.id,
    days: duration.days,
    grantedAt: now(),
    source: 'admin',
    orderId: null,
    note: typeof body.note === 'string' ? body.note : null,
    createdBy: admin.steamId,
    revokedAt: null,
    revokedReason: null,
  });
  return { ok: true, grantId: id };
});

on('POST', /^\/admin\/grants\/(\d+)\/revoke$/, (m, _q, body) => {
  requireAdmin();
  const grant = state.grants.find((g) => g.id === Number(m[1]));
  if (!grant) throw new ApiError(404, 'Grant not found.', 'not_found');
  if (grant.revokedAt !== null) throw new ApiError(409, 'Grant is already revoked.', 'conflict');
  grant.revokedAt = now();
  grant.revokedReason = String(body.reason ?? 'Revoked');
  return { ok: true };
});

on('POST', /^\/admin\/players\/(\d+)\/ban$/, (m, _q, body) => {
  requireAdmin();
  const steamId = m[1]!;
  state.banned = state.banned.filter((id) => id !== steamId);
  if (body.banned === true) state.banned.push(steamId);
  return { ok: true };
});

on('POST', /^\/admin\/reload$/, () => {
  requireAdmin();
  throw new ApiError(409, 'On Cloudflare the config files are part of the deploy. Edit them in the GitHub repository and the site redeploys.', 'config_bundled');
});

/** Same contract as api(): resolves with the JSON body or rejects with ApiError. */
export async function demoApi<T>(path: string, init: Init = {}): Promise<T> {
  const url = new URL(path, 'https://demo.invalid');
  const method = init.method ?? 'GET';
  const body = (init.body ?? {}) as Record<string, unknown>;
  await new Promise((resolve) => setTimeout(resolve, path === '/site' || path === '/catalog' || path === '/me' ? 0 : 120));
  for (const r of routes) {
    if (r.method !== method) continue;
    const match = r.pattern.exec(url.pathname);
    if (!match) continue;
    try {
      return r.handler(match, url.searchParams, body) as T;
    } finally {
      save();
    }
  }
  throw new ApiError(404, 'Not found', 'not_found');
}
