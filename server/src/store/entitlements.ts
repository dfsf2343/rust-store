import type { DB } from '../db.js';

export interface GrantRow {
  id: number;
  steam_id: string;
  kit_id: string;
  days: number | null;
  granted_at: number;
  source: 'order' | 'admin';
  order_id: string | null;
  note: string | null;
  created_by: string | null;
  revoked_at: number | null;
  revoked_reason: string | null;
}

export interface Access {
  lifetime: boolean;
  /** Unix seconds; null when lifetime. */
  expiresAt: number | null;
}

/**
 * Replays grants in purchase order. Each timed grant starts when it was granted
 * or when the previous access ends, whichever is later, so stacked purchases add
 * time and a revoked grant simply drops out of the replay.
 */
export function computeAccess(grants: Pick<GrantRow, 'days' | 'granted_at' | 'revoked_at'>[]): Access | null {
  const active = grants.filter((g) => g.revoked_at === null).sort((a, b) => a.granted_at - b.granted_at);
  if (active.length === 0) return null;
  let lifetime = false;
  let expiresAt: number | null = null;
  for (const g of active) {
    if (g.days === null) {
      lifetime = true;
      continue;
    }
    const startsAt: number = Math.max(g.granted_at, expiresAt ?? 0);
    expiresAt = startsAt + g.days * 86_400;
  }
  if (lifetime) return { lifetime: true, expiresAt: null };
  return expiresAt === null ? null : { lifetime: false, expiresAt };
}

export function isActive(access: Access | null, now: number): boolean {
  return access !== null && (access.lifetime || (access.expiresAt !== null && access.expiresAt > now));
}

export function recomputeEntitlement(db: DB, steamId: string, kitId: string, now: number): Access | null {
  const grants = db
    .prepare('SELECT days, granted_at, revoked_at FROM grants WHERE steam_id = ? AND kit_id = ?')
    .all(steamId, kitId) as Pick<GrantRow, 'days' | 'granted_at' | 'revoked_at'>[];
  const access = computeAccess(grants);
  if (access === null) {
    db.prepare('DELETE FROM entitlements WHERE steam_id = ? AND kit_id = ?').run(steamId, kitId);
  } else {
    db.prepare(
      `INSERT INTO entitlements (steam_id, kit_id, lifetime, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(steam_id, kit_id) DO UPDATE SET lifetime = excluded.lifetime, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    ).run(steamId, kitId, access.lifetime ? 1 : 0, access.expiresAt, now);
  }
  return access;
}

export function insertGrant(
  db: DB,
  g: { steamId: string; kitId: string; days: number | null; grantedAt: number; source: 'order' | 'admin'; orderId?: string | null; note?: string | null; createdBy?: string | null },
): number {
  const info = db
    .prepare(
      `INSERT INTO grants (steam_id, kit_id, days, granted_at, source, order_id, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(g.steamId, g.kitId, g.days, g.grantedAt, g.source, g.orderId ?? null, g.note ?? null, g.createdBy ?? null);
  return Number(info.lastInsertRowid);
}

export interface EntitlementView {
  steamId: string;
  kitId: string;
  lifetime: boolean;
  expiresAt: number | null;
  lastClaimAt: number | null;
}

export function activeEntitlements(db: DB, now: number, steamId?: string): EntitlementView[] {
  const rows = db
    .prepare(
      `SELECT e.steam_id, e.kit_id, e.lifetime, e.expires_at,
              (SELECT MAX(c.claimed_at) FROM claims c WHERE c.steam_id = e.steam_id AND c.kit_id = e.kit_id) AS last_claim_at
       FROM entitlements e
       WHERE (e.lifetime = 1 OR e.expires_at > ?) ${steamId ? 'AND e.steam_id = ?' : ''}
       ORDER BY e.steam_id, e.kit_id`,
    )
    .all(...(steamId ? [now, steamId] : [now])) as {
    steam_id: string;
    kit_id: string;
    lifetime: number;
    expires_at: number | null;
    last_claim_at: number | null;
  }[];
  return rows.map((r) => ({
    steamId: r.steam_id,
    kitId: r.kit_id,
    lifetime: r.lifetime === 1,
    expiresAt: r.expires_at,
    lastClaimAt: r.last_claim_at,
  }));
}
