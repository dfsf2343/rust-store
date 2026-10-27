/**
 * Activity log sent to a Discord channel through a webhook (DISCORD_WEBHOOK_URL).
 * Covers the access gate, Steam sign-ins, checkouts, payments, refunds, disputes and admin
 * actions. Sending never blocks or breaks the request that caused the event.
 */
import type { Logger } from 'pino';

export const DEVICE_COOKIE = 'rs_device';
const DEVICE_RE = /^[0-9a-f]{16}$/;

export interface Visitor {
  ip: string | null;
  country: string | null;
  region?: string | null;
  city?: string | null;
  postalCode?: string | null;
  timezone?: string | null;
  /** Network operator (ISP or hosting company) and its AS number. */
  network?: string | null;
  asn?: number | null;
  userAgent: string | null;
  language?: string | null;
  referrer?: string | null;
  deviceId: string | null;
  newDevice?: boolean;
}

export interface OrderSummary {
  id: string;
  steamId: string;
  kitName: string;
  durationLabel: string;
  amount: string;
  provider: string;
  country: string | null;
  ip?: string | null;
}

export type SiteEvent =
  | { type: 'access.granted' | 'access.denied' | 'access.locked' | 'access.page' | 'member.visit'; visitor: Visitor; path?: string }
  | { type: 'login.ok'; visitor: Visitor; steamId: string; name: string | null; firstLogin: boolean }
  | { type: 'login.failed'; visitor: Visitor; reason: string }
  | { type: 'checkout.started'; visitor: Visitor; order: OrderSummary }
  | { type: 'order.paid'; order: OrderSummary; paid: string; actor: string }
  | { type: 'order.refunded' | 'order.disputed' | 'order.review'; order: OrderSummary; detail: string }
  | { type: 'admin.grant' | 'admin.revoke'; admin: string; steamId: string; detail: string };

export interface EventLog {
  emit(event: SiteEvent): Promise<void>;
  /** Sends a test message right away and reports what Discord answered. */
  test?(): Promise<{ status: number; body: string }>;
}

export const noEventLog: EventLog = { emit: async () => {} };

const WEBHOOK_RE = /^https:\/\/(?:discord\.com|discordapp\.com|canary\.discord\.com|ptb\.discord\.com)\/api\/webhooks\/\d{5,25}\/[\w-]{20,100}$/;

export function validWebhookUrl(url: string): boolean {
  return WEBHOOK_RE.test(url);
}

export function readDeviceId(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === DEVICE_COOKIE && v && DEVICE_RE.test(v)) return v;
  }
  return null;
}

export function newDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function deviceCookie(id: string, secure: boolean): string {
  return `${DEVICE_COOKIE}=${id}; Path=/; Max-Age=${400 * 86_400}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Short "Chrome 130 on Windows (desktop)" summary of a User-Agent string. */
export function describeAgent(ua: string | null | undefined): string {
  if (!ua) return 'unknown';
  const browser =
    /Edg\/(\d+)/.exec(ua)?.[1] ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}` :
    /OPR\/(\d+)/.exec(ua)?.[1] ? `Opera ${/OPR\/(\d+)/.exec(ua)![1]}` :
    /Firefox\/(\d+)/.exec(ua)?.[1] ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}` :
    /Chrome\/(\d+)/.exec(ua)?.[1] ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}` :
    /Version\/(\d+)[\d.]* .*Safari\//.exec(ua)?.[1] ? `Safari ${/Version\/(\d+)/.exec(ua)![1]}` :
    /curl|wget|python|go-http|node|axios|okhttp|java\//i.test(ua) ? `script (${ua.slice(0, 40)})` :
    /bot|crawl|spider/i.test(ua) ? `bot (${ua.slice(0, 40)})` : 'other browser';
  const os =
    /Windows NT/.test(ua) ? 'Windows' :
    /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
    /Android/.test(ua) ? 'Android' :
    /Mac OS X/.test(ua) ? 'macOS' :
    /CrOS/.test(ua) ? 'ChromeOS' :
    /Linux/.test(ua) ? 'Linux' : 'unknown OS';
  const kind = /iPad|Tablet/.test(ua) ? 'tablet' : /Mobile|iPhone|Android/.test(ua) ? 'mobile' : 'desktop';
  return `${browser} on ${os} (${kind})`;
}

function flag(country: string | null | undefined): string {
  if (!country || !/^[A-Z]{2}$/.test(country)) return '';
  return String.fromCodePoint(...[...country].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) + ' ';
}

/** Keeps user-controlled text from breaking out of an inline code span. */
function code(text: string | null | undefined, max = 200): string {
  const clean = (text ?? '').replace(/[`\r\n]/g, ' ').slice(0, max).trim();
  return clean ? `\`${clean}\`` : '-';
}

interface Field {
  name: string;
  value: string;
  inline?: boolean;
}

function visitorFields(v: Visitor): Field[] {
  const place = [v.city, v.region, v.country].filter(Boolean).join(', ');
  const fields: Field[] = [
    { name: 'IP', value: code(v.ip), inline: true },
    { name: 'Location', value: place ? `${flag(v.country)}${code(place)}${v.postalCode ? ` ${code(v.postalCode, 12)}` : ''}` : '-', inline: true },
    { name: 'Network', value: v.network || v.asn ? `${code(v.network, 80)}${v.asn ? ` AS${v.asn}` : ''}` : '-', inline: true },
    { name: 'Browser', value: code(describeAgent(v.userAgent)), inline: true },
    {
      name: 'Device',
      value: v.deviceId ? `${code(v.deviceId)} ${v.newDevice ? '(first time seen)' : '(seen before)'}` : '-',
      inline: true,
    },
    { name: 'Time zone', value: code(v.timezone), inline: true },
  ];
  if (v.language) fields.push({ name: 'Language', value: code(v.language, 60), inline: true });
  if (v.referrer) fields.push({ name: 'Came from', value: code(v.referrer, 150), inline: true });
  fields.push({ name: 'User agent', value: code(v.userAgent, 300) });
  return fields;
}

function steamLink(steamId: string): string {
  return /^\d{17}$/.test(steamId) ? `[${steamId}](https://steamcommunity.com/profiles/${steamId})` : code(steamId);
}

function orderFields(o: OrderSummary): Field[] {
  return [
    { name: 'Player', value: steamLink(o.steamId), inline: true },
    { name: 'Kit', value: code(`${o.kitName} (${o.durationLabel})`), inline: true },
    { name: 'Amount', value: code(o.amount), inline: true },
    { name: 'Payment', value: code(o.provider), inline: true },
    { name: 'Country', value: o.country ? `${flag(o.country)}${code(o.country)}` : '-', inline: true },
    { name: 'Order', value: code(o.id), inline: true },
    ...(o.ip ? [{ name: 'IP', value: code(o.ip), inline: true }] : []),
  ];
}

const COLORS = { green: 0x2ecc71, red: 0xe74c3c, orange: 0xe67e22, grey: 0x95a5a6, blue: 0x3498db, gold: 0xf1c40f, purple: 0x9b59b6, teal: 0x1abc9c };

export function toEmbed(e: SiteEvent, nowSeconds: number): { title: string; color: number; fields: Field[]; timestamp: string } {
  const when: Field = { name: 'When', value: `<t:${nowSeconds}:F> (<t:${nowSeconds}:R>)` };
  const timestamp = new Date(nowSeconds * 1000).toISOString();
  const base = (title: string, color: number, fields: Field[]) => ({ title, color, fields: [...fields, when].slice(0, 25), timestamp });
  switch (e.type) {
    case 'access.granted':
      return base('Correct password: access granted', COLORS.green, visitorFields(e.visitor));
    case 'access.denied':
      return base('Wrong password', COLORS.red, visitorFields(e.visitor));
    case 'access.locked':
      return base('Blocked for 15 minutes after 10 wrong passwords', COLORS.orange, visitorFields(e.visitor));
    case 'access.page':
      return base('Visit without access (password page shown)', COLORS.grey, [{ name: 'Path', value: code(e.path), inline: true }, ...visitorFields(e.visitor)]);
    case 'member.visit':
      return base('Member opened the site', COLORS.teal, [{ name: 'Path', value: code(e.path), inline: true }, ...visitorFields(e.visitor)]);
    case 'login.ok':
      return base(e.firstLogin ? 'New player signed in with Steam' : 'Player signed in with Steam', COLORS.blue, [
        { name: 'Player', value: steamLink(e.steamId), inline: true },
        { name: 'Steam name', value: code(e.name, 64), inline: true },
        ...visitorFields(e.visitor),
      ]);
    case 'login.failed':
      return base('Steam sign-in failed', COLORS.orange, [{ name: 'Reason', value: code(e.reason), inline: true }, ...visitorFields(e.visitor)]);
    case 'checkout.started':
      return base('Checkout started', COLORS.blue, [...orderFields(e.order), ...visitorFields(e.visitor)]);
    case 'order.paid':
      return base('Purchase completed', COLORS.gold, [...orderFields(e.order), { name: 'Received', value: code(e.paid), inline: true }, { name: 'By', value: code(e.actor), inline: true }]);
    case 'order.refunded':
      return base('Refund: access removed', COLORS.purple, [...orderFields(e.order), { name: 'Detail', value: code(e.detail, 300) }]);
    case 'order.disputed':
      return base('Chargeback or dispute: access removed', COLORS.red, [...orderFields(e.order), { name: 'Detail', value: code(e.detail, 300) }]);
    case 'order.review':
      return base('Order needs manual review', COLORS.orange, [...orderFields(e.order), { name: 'Detail', value: code(e.detail, 300) }]);
    case 'admin.grant':
    case 'admin.revoke':
      return base(e.type === 'admin.grant' ? 'Admin granted a kit' : 'Admin revoked a kit', COLORS.purple, [
        { name: 'Admin', value: steamLink(e.admin), inline: true },
        { name: 'Player', value: steamLink(e.steamId), inline: true },
        { name: 'Detail', value: code(e.detail, 300) },
      ]);
  }
}

/** Events that repeat on every page load are only sent once per visitor in this window. */
const QUIET_SECONDS: Partial<Record<SiteEvent['type'], number>> = { 'access.page': 600, 'access.locked': 900, 'member.visit': 6 * 3600 };
const MAX_PER_MINUTE = 25;

export class DiscordEventLog implements EventLog {
  private readonly recent = new Map<string, number>();
  private window = { start: 0, count: 0 };
  private dropped = 0;

  constructor(
    private readonly url: string,
    private readonly fetchFn: typeof fetch,
    private readonly log: Logger,
    private readonly now: () => number,
    private readonly siteName: string,
  ) {}

  async test(): Promise<{ status: number; body: string }> {
    try {
      const res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `${this.siteName} log`.slice(0, 80), content: 'Test message: the store activity log is connected.', allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(8000),
      });
      return { status: res.status, body: (await res.text().catch(() => '')).slice(0, 300) };
    } catch (err) {
      return { status: 0, body: (err as Error).message };
    }
  }

  async emit(event: SiteEvent): Promise<void> {
    const now = this.now();
    const quiet = QUIET_SECONDS[event.type];
    if (quiet && 'visitor' in event) {
      const key = `${event.type}:${event.visitor.deviceId ?? ''}:${event.visitor.ip ?? ''}`;
      const last = this.recent.get(key);
      if (last !== undefined && now - last < quiet) return;
      this.recent.set(key, now);
      if (this.recent.size > 5000) this.recent.clear();
    }
    // Discord allows about 30 messages a minute per webhook; floods are counted, not sent.
    if (now - this.window.start >= 60) this.window = { start: now, count: 0 };
    if (this.window.count >= MAX_PER_MINUTE) {
      this.dropped += 1;
      return;
    }
    this.window.count += 1;
    const embed = toEmbed(event, now);
    const content = this.dropped > 0 ? `${this.dropped} more events were not sent because of the Discord rate limit.` : undefined;
    this.dropped = 0;
    try {
      const res = await this.fetchFn(`${this.url}?wait=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `${this.siteName} log`.slice(0, 80), content, embeds: [embed], allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) this.log.warn({ status: res.status, body: (await res.text().catch(() => '')).slice(0, 300) }, 'Discord log webhook refused the event');
      else this.log.info({ type: event.type, status: res.status }, 'Discord log sent');
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'Discord log webhook failed');
    }
  }
}
