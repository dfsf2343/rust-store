import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { gate } from '../src/access.js';
import { BASE, makeCtx } from './helpers.js';

const PASSWORD = 'Tr4v3l-Gr1d9';

describe('members-only gate', () => {
  it('blocks pages and the API until the right password is given', async () => {
    const { app } = makeCtx({ env: { ACCESS_PASSWORD: PASSWORD } });
    const page = await supertest(app).get('/store');
    expect(page.status).toBe(401);
    expect(page.text).toContain('Access password');
    expect((await supertest(app).get('/api/site')).status).toBe(401);
    expect((await supertest(app).get('/api/catalog')).body.error.code).toBe('access_required');

    // Webhooks, the plugin and the health check keep working without the cookie.
    expect((await supertest(app).get('/api/health')).status).toBe(200);
    // The plugin route answers with its own signature error, not the gate.
    expect((await supertest(app).post('/api/plugin/sync').send({})).body.error?.code).not.toBe('access_required');

    const wrong = await supertest(app).post('/api/access').set('Origin', BASE).type('form').send({ password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const crossSite = await supertest(app).post('/api/access').set('Origin', 'https://evil.example').type('form').send({ password: PASSWORD });
    expect(crossSite.status).toBe(403);

    const right = await supertest(app).post('/api/access').set('Origin', BASE).type('form').send({ password: PASSWORD });
    expect(right.status).toBe(303);
    const cookie = String(right.headers['set-cookie']).split(';')[0]!;
    expect((await supertest(app).get('/api/site').set('Cookie', cookie)).status).toBe(200);

    // A cookie signed for another password, or tampered with, is refused.
    const [name, value] = cookie.split('=') as [string, string];
    const [expires, mac] = value.split('.') as [string, string];
    expect((await supertest(app).get('/api/site').set('Cookie', `${name}=${Number(expires) + 1}.${mac}`)).status).toBe(401);
    const other = makeCtx({ env: { ACCESS_PASSWORD: 'another-password' } });
    expect((await supertest(other.app).get('/api/site').set('Cookie', cookie)).status).toBe(401);
  });

  it('gates every request in the Worker form too', async () => {
    const now = Math.floor(Date.now() / 1000);
    const asset = await gate(new Request('https://x.workers.dev/assets/index.js'), PASSWORD, 'CC', now);
    expect(asset?.status).toBe(401);
    expect(await gate(new Request('https://x.workers.dev/api/webhooks/stripe', { method: 'POST' }), PASSWORD, 'CC', now)).toBeNull();
    const form = new FormData();
    form.set('password', PASSWORD);
    const ok = await gate(new Request('https://x.workers.dev/api/access', { method: 'POST', body: form, headers: { Origin: 'https://x.workers.dev' } }), PASSWORD, 'CC', now);
    expect(ok?.status).toBe(303);
    const cookie = ok!.headers.get('set-cookie')!.split(';')[0]!;
    expect(await gate(new Request('https://x.workers.dev/assets/index.js', { headers: { Cookie: cookie } }), PASSWORD, 'CC', now)).toBeNull();
  });
});
