import pino from 'pino';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { gate, type GateEvent } from '../src/access.js';
import { loadConfig } from '../src/config.js';
import { describeAgent, DiscordEventLog, readDeviceId, toEmbed, type Visitor } from '../src/events.js';
import { BASE, makeCtx } from './helpers.js';

const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJ-0123456789';
const visitor: Visitor = {
  ip: '203.0.113.7',
  country: 'CL',
  city: 'Santiago',
  region: 'Santiago Metropolitan',
  network: 'Example ISP',
  asn: 64500,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  deviceId: '0123456789abcdef',
  newDevice: true,
};

function recorder() {
  const calls: { url: string; body: any }[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('Discord activity log', () => {
  it('sends one embed per event without allowing mentions', async () => {
    const { calls, fetchFn } = recorder();
    const log = new DiscordEventLog(HOOK, fetchFn, pino({ level: 'silent' }), () => 1_800_000_000, 'CC');
    await log.emit({ type: 'access.denied', visitor: { ...visitor, userAgent: '`@everyone` hi' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.startsWith(HOOK)).toBe(true);
    expect(calls[0]!.body.allowed_mentions).toEqual({ parse: [] });
    const text = JSON.stringify(calls[0]!.body.embeds[0]);
    expect(text).toContain('203.0.113.7');
    expect(text).toContain('Santiago');
    expect(text).toContain('<t:1800000000:F>');
    expect(text).not.toContain('`@everyone`');
  });

  it('sends repeated page views once and caps floods', async () => {
    const { calls, fetchFn } = recorder();
    const log = new DiscordEventLog(HOOK, fetchFn, pino({ level: 'silent' }), () => 1_800_000_000, 'CC');
    for (let i = 0; i < 5; i++) await log.emit({ type: 'access.page', visitor, path: '/' });
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 40; i++) await log.emit({ type: 'access.denied', visitor });
    expect(calls).toHaveLength(25);
  });

  it('describes purchases and browsers', () => {
    const embed = toEmbed(
      { type: 'order.paid', order: { id: 'ord_1', steamId: '76561198000000002', kitName: 'Warlord', durationLabel: '30 days', amount: '$50', provider: 'stripe', country: 'US' }, paid: '$50', actor: 'system' },
      1_800_000_000,
    );
    expect(embed.title).toBe('Purchase completed');
    expect(JSON.stringify(embed)).toContain('steamcommunity.com/profiles/76561198000000002');
    expect(describeAgent(visitor.userAgent)).toBe('Chrome 130 on Windows (desktop)');
    expect(describeAgent('curl/8.5.0')).toContain('script');
    expect(readDeviceId('a=1; rs_device=0123456789abcdef')).toBe('0123456789abcdef');
    expect(readDeviceId('rs_device=../../etc')).toBeNull();
  });

  it('ignores a webhook URL that is not Discord', () => {
    const config = loadConfig({ NODE_ENV: 'test', CONFIG_DIR: 'config', DISCORD_WEBHOOK_URL: 'https://evil.example/api/webhooks/1/x' }, 'cloudflare');
    expect(config.discordWebhookUrl).toBeNull();
    expect(loadConfig({ NODE_ENV: 'test', DISCORD_WEBHOOK_URL: HOOK }, 'cloudflare').discordWebhookUrl).toBe(HOOK);
  });

  it('reports what the gate did', async () => {
    const now = Math.floor(Date.now() / 1000);
    const seen: GateEvent[] = [];
    const on = (e: GateEvent) => seen.push(e);
    await gate(new Request('https://x.workers.dev/'), 'Tr4v3l-Gr1d9', 'CC', now, undefined, on);
    const post = (password: string) => {
      const form = new FormData();
      form.set('password', password);
      return new Request('https://x.workers.dev/api/access', { method: 'POST', body: form, headers: { Origin: 'https://x.workers.dev', 'cf-connecting-ip': '203.0.113.7' } });
    };
    await gate(post('nope'), 'Tr4v3l-Gr1d9', 'CC', now, undefined, on);
    await gate(post('Tr4v3l-Gr1d9'), 'Tr4v3l-Gr1d9', 'CC', now, undefined, on);
    expect(seen).toEqual(['access.page', 'access.denied', 'access.granted']);
  });

  it('logs the gate and sign-ins in the Node build', async () => {
    const { calls, fetchFn } = recorder();
    const { app } = makeCtx({ env: { ACCESS_PASSWORD: 'Tr4v3l-Gr1d9', DISCORD_WEBHOOK_URL: HOOK }, fetchFn });
    await supertest(app).post('/api/access').set('Origin', BASE).type('form').send({ password: 'nope' });
    await supertest(app).post('/api/access').set('Origin', BASE).type('form').send({ password: 'Tr4v3l-Gr1d9' });
    await new Promise((r) => setTimeout(r, 20));
    const titles = calls.filter((c) => c.url.startsWith(HOOK)).map((c) => c.body.embeds[0].title);
    expect(titles).toEqual(['Wrong password', 'Correct password: access granted']);
  });
});

import { ADMIN_STEAM, loginAs } from './helpers.js';

describe('Discord test button', () => {
  it('reports a missing webhook and a Discord refusal to admins', async () => {
    const missing = makeCtx();
    const admin = await loginAs(missing.app, ADMIN_STEAM);
    expect((await admin.post('/api/admin/discord-test').set('Origin', BASE).send({})).body.error.code).toBe('discord_missing');

    const blocked = (async () => new Response('{"message":"You are being rate limited."}', { status: 429 })) as unknown as typeof fetch;
    const t = makeCtx({ env: { DISCORD_WEBHOOK_URL: HOOK }, fetchFn: blocked });
    const a = await loginAs(t.app, ADMIN_STEAM);
    const res = await a.post('/api/admin/discord-test').set('Origin', BASE).send({});
    expect(res.body.error.code).toBe('discord_failed');
    expect(res.body.error.message).toContain('429');
  });
});
