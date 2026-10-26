import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import type { DB } from '../db.js';
import { HttpError, randomToken, sha256Hex } from '../lib/util.js';

export const SESSION_COOKIE = 'rs_session';
export const SESSION_TTL_SECONDS = 30 * 86_400;

export interface UserRow {
  id: number;
  steam_id: string;
  name: string | null;
  avatar_url: string | null;
  is_banned: number;
  created_at: number;
  last_login_at: number;
}

export interface AuthedUser extends UserRow {
  isAdmin: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthedUser;
  }
}

export function upsertUser(db: DB, steamId: string, profile: { name: string | null; avatarUrl: string | null } | null, now: number): UserRow {
  db.prepare(
    `INSERT INTO users (steam_id, name, avatar_url, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(steam_id) DO UPDATE SET
       name = COALESCE(excluded.name, users.name),
       avatar_url = COALESCE(excluded.avatar_url, users.avatar_url),
       last_login_at = excluded.last_login_at`,
  ).run(steamId, profile?.name ?? null, profile?.avatarUrl ?? null, now, now);
  return db.prepare('SELECT * FROM users WHERE steam_id = ?').get(steamId) as UserRow;
}

export function createSession(db: DB, userId: number, now: number, ip: string | null, userAgent: string | null): string {
  const token = randomToken(32);
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)').run(
    sha256Hex(token),
    userId,
    now,
    now + SESSION_TTL_SECONDS,
    ip,
    userAgent?.slice(0, 256) ?? null,
  );
  return token;
}

export function destroySession(db: DB, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256Hex(token));
}

export function sessionCookieOptions(config: AppConfig) {
  return {
    httpOnly: true,
    secure: config.baseUrl.startsWith('https://'),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000,
  };
}

/** Attaches req.user when a valid session cookie is present. Never rejects. */
export function loadUser(db: DB, config: AppConfig, now: () => number) {
  const find = db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`,
  );
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (token && typeof token === 'string' && token.length <= 128) {
      const row = find.get(sha256Hex(token), now()) as UserRow | undefined;
      if (row) req.user = { ...row, isAdmin: config.adminSteamIds.has(row.steam_id) };
    }
    next();
  };
}

export function requireUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Sign in with Steam to continue.', 'auth_required'));
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Sign in with Steam to continue.', 'auth_required'));
  if (!req.user.isAdmin) return next(new HttpError(403, 'Admins only.', 'forbidden'));
  next();
}
