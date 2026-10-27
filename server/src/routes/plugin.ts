import express, { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { pluginKitDefinitions } from '../content.js';
import { isSteamId } from '../lib/util.js';
import { signEnvelope, verifyRequest } from '../plugin/protocol.js';
import { activeEntitlements } from '../store/entitlements.js';

const SYNC_INTERVAL_SECONDS = 15;
const NOTIFICATION_MAX_AGE_SECONDS = 14 * 86_400;

// Zod 4 numbers already reject NaN and Infinity.
const finite = z.number();

/** Server status is informational: bad fields are dropped instead of failing the sync. */
const StatusSchema = z.object({
  hostname: z.string().max(200).nullish(),
  players: finite.int().min(0).max(10_000).nullish(),
  maxPlayers: finite.int().min(0).max(10_000).nullish(),
  queued: finite.int().min(0).max(10_000).nullish(),
  joining: finite.int().min(0).max(10_000).nullish(),
  sleepers: finite.int().min(0).max(1_000_000).nullish(),
  worldSize: finite.int().min(0).max(100_000).nullish(),
  seed: finite.int().nullish(),
  fps: finite.min(0).max(100_000).nullish(),
  wipedAt: finite.int().nullish(),
  command: z.string().regex(/^[a-z0-9_]{1,24}$/).nullish(),
  pluginVersion: z.string().max(32).nullish(),
});

const SyncBody = z.object({
  nonce: z.string().min(8).max(64),
  serverId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default('main'),
  catalogVersion: z.string().max(64).nullish(),
  status: z.unknown().optional(),
  claims: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
        steamId: z.string().refine(isSteamId),
        kitId: z.string().max(32),
        at: finite.int(),
      }),
    )
    .max(500)
    .nullish()
    .transform((v) => v ?? []),
  delivered: z
    .array(z.number().int().positive())
    .max(500)
    .nullish()
    .transform((v) => v ?? []),
});

function sanitizeStatus(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(StatusSchema.shape)) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    const parsed = schema.safeParse(value);
    if (parsed.success && parsed.data !== null && parsed.data !== undefined) out[key] = parsed.data;
  }
  return out;
}

export function pluginRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post('/sync', express.text({ type: '*/*', limit: '512kb' }), (req, res) => {
    const secret = ctx.config.pluginSecret;
    if (!secret) return res.status(503).json({ error: 'unavailable' });
    const raw = typeof req.body === 'string' ? req.body : '';
    const now = ctx.now();
    const check = verifyRequest(secret, req.get('x-store-timestamp'), req.get('x-store-signature'), raw, now);
    if (!check.ok) {
      ctx.log.warn({ reason: check.reason, ip: req.ip }, 'Rejected plugin sync');
      // The reason stays in the server log; callers only learn that it failed.
      return res.status(401).json({ error: 'unauthorized' });
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: 'invalid JSON' });
    }
    const parsed = SyncBody.safeParse(parsedJson);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    const body = parsed.data;
    const content = ctx.content();
    const knownKits = new Set(content.catalog.kits.map((k) => k.id));

    const status = sanitizeStatus(body.status);

    ctx.db.transaction(() => {
      if (status) {
        ctx.db
          .prepare(
            `INSERT INTO server_status (server_id, payload, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(server_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
          )
          .run(body.serverId, JSON.stringify(status), now);
      }
      const insertClaim = ctx.db.prepare(
        'INSERT OR IGNORE INTO claims (id, steam_id, kit_id, claimed_at, server_id, received_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const c of body.claims) {
        if (!knownKits.has(c.kitId)) continue;
        // Never accept claim times from the future; it would lock the player out.
        insertClaim.run(c.id, c.steamId, c.kitId, Math.min(c.at, now), body.serverId, now);
      }
      const markDelivered = ctx.db.prepare('UPDATE notifications SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL');
      for (const id of body.delivered) markDelivered.run(now, id);
    })();

    const banned = new Set(
      (ctx.db.prepare('SELECT steam_id FROM users WHERE is_banned = 1').all() as { steam_id: string }[]).map((r) => r.steam_id),
    );
    const entitlements = activeEntitlements(ctx.db, now)
      .filter((e) => knownKits.has(e.kitId) && !banned.has(e.steamId))
      .map((e) => ({ steamId: e.steamId, kitId: e.kitId, expiresAt: e.lifetime ? null : e.expiresAt, lastClaimAt: e.lastClaimAt }));
    const notifications = ctx.db
      .prepare('SELECT id, steam_id AS steamId, message FROM notifications WHERE delivered_at IS NULL AND created_at > ? ORDER BY id LIMIT 200')
      .all(now - NOTIFICATION_MAX_AGE_SECONDS) as { id: number; steamId: string; message: string }[];

    const payload = {
      nonce: body.nonce,
      now,
      syncIntervalSeconds: SYNC_INTERVAL_SECONDS,
      catalogVersion: content.catalogVersion,
      kits: body.catalogVersion === content.catalogVersion ? null : pluginKitDefinitions(content.catalog),
      entitlements,
      notifications,
      storeUrl: ctx.config.baseUrl,
    };
    res.set('Cache-Control', 'no-store');
    res.json(signEnvelope(secret, payload));
  });

  return router;
}
