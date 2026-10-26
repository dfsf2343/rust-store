import type { Content } from '../content.js';
import { priceCents } from '../content.js';
import type { DB } from '../db.js';
import { formatMoney } from '../lib/util.js';
import { nextWipe } from '../lib/wipe.js';
import { activeEntitlements } from './entitlements.js';
import type { OrderRow } from './orders.js';

export function catalogView(content: Content) {
  const { catalog } = content;
  return {
    currency: catalog.currency,
    durations: catalog.durations.map((d) => ({
      id: d.id,
      label: d.label,
      days: d.days,
      badge: d.badge ?? null,
      default: d.default ?? false,
    })),
    kits: catalog.kits
      .filter((k) => !k.hidden)
      .map((k) => ({
        id: k.id,
        name: k.name,
        tier: k.tier,
        tagline: k.tagline,
        cooldownHours: k.cooldownHours,
        items: k.items,
        prices: Object.fromEntries(
          catalog.durations.map((d) => {
            const cents = priceCents(k, d);
            return [d.id, { cents, display: formatMoney(cents, 'USD') }];
          }),
        ),
      })),
  };
}

export function siteView(content: Content) {
  const { site } = content;
  return {
    name: site.name,
    shortName: site.shortName,
    tagline: site.tagline,
    description: site.description,
    region: site.region,
    connect: site.connect,
    links: site.links,
    wipe: site.wipe,
    highlights: site.highlights,
    features: site.features,
    rules: site.rules,
    faq: site.faq,
    legal: site.legal,
    store: site.store,
  };
}

export interface PluginStatus {
  hostname?: string;
  players?: number;
  maxPlayers?: number;
  queued?: number;
  joining?: number;
  sleepers?: number;
  worldSize?: number;
  seed?: number;
  fps?: number;
  uptimeSeconds?: number;
  wipedAt?: number | null;
  command?: string;
  pluginVersion?: string;
}

const ONLINE_WINDOW_SECONDS = 90;

export function statusView(db: DB, content: Content, nowSeconds: number) {
  const row = db.prepare('SELECT payload, updated_at FROM server_status ORDER BY updated_at DESC LIMIT 1').get() as
    | { payload: string; updated_at: number }
    | undefined;
  let status: PluginStatus = {};
  if (row) {
    try {
      status = JSON.parse(row.payload) as PluginStatus;
    } catch {
      status = {};
    }
  }
  const online = !!row && nowSeconds - row.updated_at <= ONLINE_WINDOW_SECONDS;
  const wipe = content.site.wipe;
  return {
    online,
    updatedAt: row?.updated_at ?? null,
    hostname: status.hostname ?? content.site.name,
    players: online ? (status.players ?? 0) : 0,
    maxPlayers: status.maxPlayers ?? null,
    queued: online ? (status.queued ?? 0) : 0,
    joining: online ? (status.joining ?? 0) : 0,
    worldSize: status.worldSize ?? null,
    seed: status.seed ?? null,
    wipedAt: status.wipedAt ?? null,
    nextWipeAt: nextWipe(nowSeconds * 1000, wipe.timezone, wipe.slots),
    wipeLabel: wipe.label,
    connect: content.site.connect.address,
    command: status.command ?? content.site.store.inGameCommand,
  };
}

export function orderView(order: OrderRow, content: Content) {
  return {
    id: order.id,
    status: order.status,
    statusDetail: order.status === 'review' ? 'Payment received, waiting for staff review.' : order.status_detail,
    kit: { id: order.kit_id, name: order.kit_name },
    duration: { id: order.duration_id, label: order.duration_label, days: order.duration_days },
    amount: { cents: order.amount_cents, currency: order.currency, display: formatMoney(order.amount_cents, order.currency) },
    charge: { amount: order.charge_amount, currency: order.charge_currency, display: formatMoney(order.charge_amount, order.charge_currency) },
    provider: order.provider,
    createdAt: order.created_at,
    paidAt: order.paid_at,
    command: `/${content.site.store.inGameCommand} ${order.kit_id}`,
  };
}

export function accountKitsView(db: DB, content: Content, steamId: string, now: number) {
  const kits = new Map(content.catalog.kits.map((k) => [k.id, k]));
  return activeEntitlements(db, now, steamId).map((e) => {
    const kit = kits.get(e.kitId);
    const cooldown = Math.round((kit?.cooldownHours ?? 0) * 3600);
    const nextClaimAt = e.lastClaimAt !== null ? e.lastClaimAt + cooldown : null;
    return {
      kitId: e.kitId,
      kitName: kit?.name ?? e.kitId,
      tier: kit?.tier ?? null,
      lifetime: e.lifetime,
      expiresAt: e.expiresAt,
      lastClaimAt: e.lastClaimAt,
      nextClaimAt: nextClaimAt !== null && nextClaimAt > now ? nextClaimAt : null,
      command: `/${content.site.store.inGameCommand} ${e.kitId}`,
    };
  });
}
