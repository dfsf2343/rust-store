export type ProviderId = 'stripe' | 'paypal' | 'mercadopago';
export type OrderStatus = 'pending' | 'paid' | 'failed' | 'canceled' | 'expired' | 'refunded' | 'disputed' | 'review';
export type ItemCategory =
  | 'weapon'
  | 'ammo'
  | 'attachment'
  | 'armor'
  | 'clothing'
  | 'medical'
  | 'food'
  | 'tool'
  | 'resource'
  | 'building'
  | 'explosive'
  | 'misc';

export interface Site {
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  region: string;
  connect: { address: string };
  links: { discord: string | null; steamGroup: string | null };
  wipe: { timezone: string; slots: { weekday: number; time: string }[]; label: string };
  highlights: { label: string; value: string }[];
  features: { title: string; body: string }[];
  rules: { title: string; items: string[] }[];
  faq: { q: string; a: string }[];
  legal: { operatorName: string; contactEmail: string; lastUpdated: string };
  store: { inGameCommand: string; itemIconUrl: string | null };
}

export interface KitItem {
  shortname: string;
  name: string;
  amount: number;
  category: ItemCategory;
}

export interface Kit {
  id: string;
  name: string;
  tier: number;
  tagline: string;
  cooldownHours: number;
  items: KitItem[];
  prices: Record<string, { cents: number; display: string }>;
}

export interface Duration {
  id: string;
  label: string;
  days: number | null;
  badge: string | null;
  default: boolean;
}

export interface Catalog {
  currency: string;
  durations: Duration[];
  kits: Kit[];
}

export interface ServerStatus {
  online: boolean;
  updatedAt: number | null;
  hostname: string;
  players: number;
  maxPlayers: number | null;
  queued: number;
  joining: number;
  worldSize: number | null;
  seed: number | null;
  nextWipeAt: number | null;
  wipeLabel: string;
  connect: string;
  command: string;
}

export interface Me {
  user: { steamId: string; name: string | null; avatarUrl: string | null; isAdmin: boolean; banned: boolean } | null;
  devLogin: boolean;
}

export interface Money {
  display: string;
}

export interface Order {
  id: string;
  status: OrderStatus;
  statusDetail: string | null;
  kit: { id: string; name: string };
  duration: { id: string; label: string; days: number | null };
  amount: Money & { cents: number; currency: string };
  charge: Money & { amount: number; currency: string };
  provider: ProviderId;
  createdAt: number;
  paidAt: number | null;
  command: string;
}

export interface CheckoutOptions {
  country: string | null;
  countryName: string | null;
  region: string;
  providers: { id: ProviderId; label: string; description: string; charge: (Money & { amount: number; currency: string }) | null }[];
}

export interface AccountKit {
  kitId: string;
  kitName: string;
  tier: number | null;
  lifetime: boolean;
  expiresAt: number | null;
  lastClaimAt: number | null;
  nextClaimAt: number | null;
  command: string;
}

export interface Account {
  user: { steamId: string; name: string | null; avatarUrl: string | null; banned: boolean };
  kits: AccountKit[];
  orders: Order[];
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string } } | null)?.error;
    throw new ApiError(res.status, err?.message ?? `Request failed (${res.status})`, err?.code ?? 'error');
  }
  return data as T;
}

export function steamLoginUrl(returnTo: string): string {
  return `/api/auth/steam?returnTo=${encodeURIComponent(returnTo)}`;
}
