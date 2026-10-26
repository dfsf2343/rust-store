import { Router } from 'express';
import { z } from 'zod';
import { createSession, destroySession, SESSION_COOKIE, sessionCookieOptions, upsertUser } from '../auth/sessions.js';
import { buildSteamLoginUrl, fetchSteamProfile, SteamAuthError, verifySteamAssertion } from '../auth/steam.js';
import type { AppContext } from '../context.js';
import { audit } from '../db.js';
import { HttpError, isSteamId, randomToken } from '../lib/util.js';
import { limiter, parseBody } from './http.js';

const STATE_COOKIE = 'rs_login';

function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.length > 200) {
    return '/account';
  }
  return value;
}

export function authRoutes(ctx: AppContext): Router {
  const router = Router();
  const callbackPath = '/api/auth/steam/callback';

  router.get('/auth/steam', limiter(60, 30), (req, res) => {
    const state = randomToken(18);
    const returnPath = safeReturnPath(req.query.returnTo);
    res.cookie(STATE_COOKIE, `${state}.${Buffer.from(returnPath).toString('base64url')}`, {
      httpOnly: true,
      secure: ctx.config.baseUrl.startsWith('https://'),
      sameSite: 'lax',
      path: '/api/auth',
      maxAge: 10 * 60 * 1000,
    });
    const returnTo = `${ctx.config.baseUrl}${callbackPath}?state=${state}`;
    res.redirect(302, buildSteamLoginUrl(returnTo, `${ctx.config.baseOrigin}/`));
  });

  router.get('/auth/steam/callback', limiter(60, 30), async (req, res) => {
    const cookie = req.cookies?.[STATE_COOKIE] as string | undefined;
    res.clearCookie(STATE_COOKIE, { path: '/api/auth' });
    const [cookieState, encodedReturn] = (cookie ?? '').split('.');
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const returnPath = safeReturnPath(encodedReturn ? Buffer.from(encodedReturn, 'base64url').toString() : '/account');
    try {
      if (!cookieState || !state || cookieState !== state) throw new SteamAuthError('Login session expired', 'expired');
      const steamId = await verifySteamAssertion(req.query as Record<string, unknown>, `${ctx.config.baseUrl}${callbackPath}?state=${state}`, ctx.fetchFn);
      const profile = ctx.config.steamApiKey
        ? await fetchSteamProfile(ctx.config.steamApiKey, steamId, ctx.fetchFn).catch((err) => {
            ctx.log.warn({ err: (err as Error).message }, 'Steam profile lookup failed');
            return null;
          })
        : null;
      const now = ctx.now();
      const user = upsertUser(ctx.db, steamId, profile, now);
      const token = createSession(ctx.db, user.id, now, req.ip ?? null, req.get('user-agent') ?? null);
      res.cookie(SESSION_COOKIE, token, sessionCookieOptions(ctx.config));
      audit(ctx.db, steamId, 'auth.login', steamId, { ip: req.ip }, now);
      res.redirect(302, returnPath);
    } catch (err) {
      // Only a fixed code reaches the page, so the query string cannot carry arbitrary text.
      const code = err instanceof SteamAuthError ? err.code : 'failed';
      if (err instanceof SteamAuthError) ctx.log.warn({ reason: err.message }, 'Steam login rejected');
      else ctx.log.error({ err }, 'Steam login error');
      res.redirect(302, `/?login_error=${code}`);
    }
  });

  router.post('/auth/logout', (req, res) => {
    destroySession(ctx.db, req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  if (ctx.config.dev.login) {
    ctx.log.warn('DEV_LOGIN is enabled: anyone can sign in as any SteamID. Never enable this in production.');
    router.post('/auth/dev-login', (req, res) => {
      const { steamId, name } = parseBody(
        z.object({ steamId: z.string().refine(isSteamId, 'Invalid SteamID64'), name: z.string().max(64).optional() }),
        req.body,
      );
      const now = ctx.now();
      const user = upsertUser(ctx.db, steamId, { name: name ?? `Dev ${steamId.slice(-4)}`, avatarUrl: null }, now);
      const token = createSession(ctx.db, user.id, now, req.ip ?? null, req.get('user-agent') ?? null);
      res.cookie(SESSION_COOKIE, token, sessionCookieOptions(ctx.config));
      res.json({ ok: true });
    });
  }

  router.get('/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const u = req.user;
    res.json({
      user: u
        ? { steamId: u.steam_id, name: u.name, avatarUrl: u.avatar_url, isAdmin: u.isAdmin, banned: u.is_banned === 1 }
        : null,
      devLogin: ctx.config.dev.login,
    });
  });

  router.use('/auth', (_req, _res, next) => next(new HttpError(404, 'Not found', 'not_found')));
  return router;
}
