import crypto from 'node:crypto';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { signRequest } from '../src/plugin/protocol.js';
import { ADMIN_STEAM, BASE, ORIGIN, PLAYER_STEAM, PLUGIN_SECRET, loginAs, makeCtx, scriptedFetch } from './helpers.js';

function pluginSync(app: Parameters<typeof supertest>[0], body: object, opts: { ts?: number; secret?: string } = {}) {
  const raw = JSON.stringify(body);
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  return supertest(app)
    .post('/api/plugin/sync')
    .set('Content-Type', 'application/json')
    .set('X-Store-Timestamp', String(ts))
    .set('X-Store-Signature', signRequest(opts.secret ?? PLUGIN_SECRET, ts, raw))
    .send(raw);
}

function openEnvelope(res: { body: { payload: string; signature: string } }) {
  const expected = crypto.createHmac('sha256', PLUGIN_SECRET).update(res.body.payload).digest('hex');
  expect(res.body.signature).toBe(expected);
  return JSON.parse(res.body.payload);
}

describe('plugin sync', () => {
  it('rejects bad signatures and stale timestamps', async () => {
    const { app } = makeCtx();
    expect((await pluginSync(app, { nonce: 'abcdefgh' }, { secret: 'wrong-secret-wrong-secret-wrong-secret' })).status).toBe(401);
    expect((await pluginSync(app, { nonce: 'abcdefgh' }, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
  });

  it('delivers kits, entitlements and notifications, and records claims', async () => {
    const { app, ctx } = makeCtx();
    const admin = await loginAs(app, ADMIN_STEAM);
    const grant = await admin.post('/api/admin/grants').set(ORIGIN).send({ steamId: PLAYER_STEAM, kitId: 'ranger', durationId: '7d', note: 'giveaway' });
    expect(grant.status).toBe(200);

    const first = await pluginSync(app, {
      nonce: 'nonce-0001',
      serverId: 'main',
      status: { hostname: 'Test Server', players: 42, maxPlayers: 150, queued: 3, worldSize: 4000, seed: 12345, command: 'claim', pluginVersion: '1.0.0' },
    });
    expect(first.status).toBe(200);
    const payload = openEnvelope(first);
    expect(payload.nonce).toBe('nonce-0001');
    expect(payload.kits.map((k: { id: string }) => k.id)).toEqual(['scrapper', 'builder', 'ranger', 'warlord', 'overlord']);
    expect(payload.kits[2].cooldownSeconds).toBe(6 * 3600);
    expect(payload.entitlements).toEqual([{ steamId: PLAYER_STEAM, kitId: 'ranger', expiresAt: expect.any(Number), lastClaimAt: null }]);
    expect(payload.notifications).toHaveLength(1);
    expect(payload.notifications[0].message).toContain('/claim ranger');

    const status = await supertest(app).get('/api/status');
    expect(status.body).toMatchObject({ online: true, players: 42, maxPlayers: 150, queued: 3, hostname: 'Test Server' });

    const claimAt = Math.floor(Date.now() / 1000) - 10;
    const second = await pluginSync(app, {
      nonce: 'nonce-0002',
      catalogVersion: payload.catalogVersion,
      claims: [{ id: 'c0ffee00-0000-4000-8000-000000000001', steamId: PLAYER_STEAM, kitId: 'ranger', at: claimAt }],
      delivered: [payload.notifications[0].id],
    });
    const p2 = openEnvelope(second);
    expect(p2.kits).toBeNull();
    expect(p2.notifications).toHaveLength(0);
    expect(p2.entitlements[0].lastClaimAt).toBe(claimAt);

    // Re-sending the same claim does not duplicate it.
    await pluginSync(app, { nonce: 'nonce-0003', claims: [{ id: 'c0ffee00-0000-4000-8000-000000000001', steamId: PLAYER_STEAM, kitId: 'ranger', at: claimAt }] });
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM claims').get() as { n: number }).n).toBe(1);

    const account = await (await loginAs(app, PLAYER_STEAM)).get('/api/account');
    expect(account.body.kits[0].nextClaimAt).toBe(claimAt + 6 * 3600);
  });

  it('hides entitlements of banned players', async () => {
    const { app } = makeCtx();
    const admin = await loginAs(app, ADMIN_STEAM);
    await admin.post('/api/admin/grants').set(ORIGIN).send({ steamId: PLAYER_STEAM, kitId: 'scrapper', durationId: 'lifetime' });
    await admin.post(`/api/admin/players/${PLAYER_STEAM}/ban`).set(ORIGIN).send({ banned: true });
    const payload = openEnvelope(await pluginSync(app, { nonce: 'nonce-ban-1' }));
    expect(payload.entitlements).toEqual([]);
  });
});

describe('Steam login', () => {
  const steamId = '76561198012345678';

  function assertionParams(returnTo: string) {
    return {
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'id_res',
      'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
      'openid.claimed_id': `https://steamcommunity.com/openid/id/${steamId}`,
      'openid.identity': `https://steamcommunity.com/openid/id/${steamId}`,
      'openid.return_to': returnTo,
      'openid.response_nonce': '2026-10-26T12:00:00ZabcDEF',
      'openid.assoc_handle': '1234567890',
      'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
      'openid.sig': 'c2lnbmF0dXJl',
    };
  }

  it('verifies the assertion with Steam and creates a session', async () => {
    const sf = scriptedFetch([
      { method: 'POST', match: 'steamcommunity.com/openid/login', reply: () => ({ body: 'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n' }) },
      {
        method: 'GET',
        match: 'GetPlayerSummaries',
        reply: () => ({ body: { response: { players: [{ steamid: steamId, personaname: 'Ironfist', avatarfull: 'https://avatars.steamstatic.com/a_full.jpg' }] } } }),
      },
    ]);
    const { app } = makeCtx({ fetchFn: sf.fn, env: { STEAM_API_KEY: 'KEY' } });
    const agent = supertest.agent(app);

    const start = await agent.get('/api/auth/steam?returnTo=/store/warlord');
    expect(start.status).toBe(302);
    const steamUrl = new URL(start.headers.location!);
    expect(steamUrl.origin + steamUrl.pathname).toBe('https://steamcommunity.com/openid/login');
    expect(steamUrl.searchParams.get('openid.mode')).toBe('checkid_setup');
    expect(steamUrl.searchParams.get('openid.realm')).toBe(`${BASE}/`);
    const returnTo = steamUrl.searchParams.get('openid.return_to')!;
    expect(returnTo.startsWith(`${BASE}/api/auth/steam/callback?state=`)).toBe(true);

    const callback = new URL(returnTo);
    for (const [k, v] of Object.entries(assertionParams(returnTo))) callback.searchParams.set(k, v);
    const done = await agent.get(callback.pathname + callback.search);
    expect(done.status).toBe(302);
    expect(done.headers.location).toBe('/store/warlord');

    const checkCall = sf.calls.find((c) => c.method === 'POST')!;
    const sent = new URLSearchParams(String(checkCall.init?.body));
    expect(sent.get('openid.mode')).toBe('check_authentication');
    expect(sent.get('openid.sig')).toBe('c2lnbmF0dXJl');

    const me = await agent.get('/api/me');
    expect(me.body.user).toMatchObject({ steamId, name: 'Ironfist', isAdmin: false });
  });

  it('rejects assertions Steam does not confirm or that skip the state check', async () => {
    const sf = scriptedFetch([{ method: 'POST', match: 'steamcommunity.com/openid/login', reply: () => ({ body: 'is_valid:false\n' }) }]);
    const { app } = makeCtx({ fetchFn: sf.fn });
    const agent = supertest.agent(app);
    const start = await agent.get('/api/auth/steam');
    const returnTo = new URL(start.headers.location!).searchParams.get('openid.return_to')!;
    const callback = new URL(returnTo);
    for (const [k, v] of Object.entries(assertionParams(returnTo))) callback.searchParams.set(k, v);
    const done = await agent.get(callback.pathname + callback.search);
    expect(done.headers.location).toBe('/?login_error=failed');
    expect((await agent.get('/api/me')).body.user).toBeNull();

    // No state cookie (different browser): rejected before contacting Steam.
    const before = sf.calls.length;
    const other = await supertest(app).get(callback.pathname + callback.search);
    expect(other.headers.location).toBe('/?login_error=expired');
    expect(sf.calls.length).toBe(before);
  });

  it('refuses open redirects', async () => {
    const { app } = makeCtx();
    const res = await supertest(app).get('/api/auth/steam?returnTo=//evil.example/x');
    const cookie = res.headers['set-cookie']![0]!;
    const encoded = decodeURIComponent(cookie.split('=')[1]!.split(';')[0]!).split('.')[1]!;
    expect(Buffer.from(encoded, 'base64url').toString()).toBe('/account');
  });
});

describe('admin', () => {
  it('is restricted to configured SteamIDs', async () => {
    const { app } = makeCtx();
    const player = await loginAs(app, PLAYER_STEAM);
    expect((await player.get('/api/admin/overview')).status).toBe(403);
    const admin = await loginAs(app, ADMIN_STEAM);
    const overview = await admin.get('/api/admin/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.system.providers).toEqual(['stripe', 'paypal', 'mercadopago']);
  });

  it('grants, revokes and audits', async () => {
    const { app } = makeCtx();
    const admin = await loginAs(app, ADMIN_STEAM);
    const g = await admin.post('/api/admin/grants').set(ORIGIN).send({ steamId: PLAYER_STEAM, kitId: 'overlord', durationId: '30d' });
    const player = await admin.get(`/api/admin/players/${PLAYER_STEAM}`);
    expect(player.body.kits).toHaveLength(1);
    const revoke = await admin.post(`/api/admin/grants/${g.body.grantId}/revoke`).set(ORIGIN).send({ reason: 'test' });
    expect(revoke.body.access).toBeNull();
    expect((await admin.get(`/api/admin/players/${PLAYER_STEAM}`)).body.kits).toHaveLength(0);
    const audit = await admin.get('/api/admin/audit');
    expect(audit.body.entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['admin.grant', 'admin.revoke']));
  });
});
