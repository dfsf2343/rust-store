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
  if (!ua) return 'desconocido';
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
    { name: 'Ubicación', value: place ? `${flag(v.country)}${code(place)}${v.postalCode ? ` ${code(v.postalCode, 12)}` : ''}` : '-', inline: true },
    { name: 'Red / ISP', value: v.network || v.asn ? `${code(v.network, 80)}${v.asn ? ` AS${v.asn}` : ''}` : '-', inline: true },
    { name: 'Navegador', value: code(describeAgent(v.userAgent)), inline: true },
    {
      name: 'Dispositivo',
      value: v.deviceId ? `${code(v.deviceId)} ${v.newDevice ? '(nuevo)' : '(ya visto antes)'}` : '-',
      inline: true,
    },
    { name: 'Zona horaria', value: code(v.timezone), inline: true },
  ];
  if (v.language) fields.push({ name: 'Idioma', value: code(v.language, 60), inline: true });
  if (v.referrer) fields.push({ name: 'Viene de', value: code(v.referrer, 150), inline: true });
  fields.push({ name: 'User agent', value: code(v.userAgent, 300) });
  return fields;
}

function steamLink(steamId: string): string {
  return /^\d{17}$/.test(steamId) ? `[${steamId}](https://steamcommunity.com/profiles/${steamId})` : code(steamId);
}

function orderFields(o: OrderSummary): Field[] {
  return [
    { name: 'Jugador', value: steamLink(o.steamId), inline: true },
    { name: 'Kit', value: code(`${o.kitName} (${o.durationLabel})`), inline: true },
    { name: 'Monto', value: code(o.amount), inline: true },
    { name: 'Método', value: code(o.provider), inline: true },
    { name: 'País', value: o.country ? `${flag(o.country)}${code(o.country)}` : '-', inline: true },
    { name: 'Pedido', value: code(o.id), inline: true },
    ...(o.ip ? [{ name: 'IP', value: code(o.ip), inline: true }] : []),
  ];
}

const COLORS = { green: 0x2ecc71, red: 0xe74c3c, orange: 0xe67e22, grey: 0x95a5a6, blue: 0x3498db, gold: 0xf1c40f, purple: 0x9b59b6, teal: 0x1abc9c };

export function toEmbed(e: SiteEvent, nowSeconds: number): { title: string; color: number; fields: Field[]; timestamp: string } {
  const when: Field = { name: 'Hora', value: `<t:${nowSeconds}:F> (<t:${nowSeconds}:R>)` };
  const timestamp = new Date(nowSeconds * 1000).toISOString();
  const base = (title: string, color: number, fields: Field[]) => ({ title, color, fields: [...fields, when].slice(0, 25), timestamp });
  switch (e.type) {
    case 'access.granted':
      return base('Contraseña correcta: acceso concedido', COLORS.green, visitorFields(e.visitor));
    case 'access.denied':
      return base('Contraseña incorrecta', COLORS.red, visitorFields(e.visitor));
    case 'access.locked':
      return base('Bloqueado 15 minutos por 10 contraseñas incorrectas', COLORS.orange, visitorFields(e.visitor));
    case 'access.page':
      return base('Visita sin acceso (vio la página de contraseña)', COLORS.grey, [{ name: 'Ruta', value: code(e.path), inline: true }, ...visitorFields(e.visitor)]);
    case 'member.visit':
      return base('Miembro entró a la página', COLORS.teal, [{ name: 'Ruta', value: code(e.path), inline: true }, ...visitorFields(e.visitor)]);
    case 'login.ok':
      return base(e.firstLogin ? 'Jugador nuevo inició sesión con Steam' : 'Jugador inició sesión con Steam', COLORS.blue, [
        { name: 'Jugador', value: steamLink(e.steamId), inline: true },
        { name: 'Nombre en Steam', value: code(e.name, 64), inline: true },
        ...visitorFields(e.visitor),
      ]);
    case 'login.failed':
      return base('Falló el inicio de sesión con Steam', COLORS.orange, [{ name: 'Motivo', value: code(e.reason), inline: true }, ...visitorFields(e.visitor)]);
    case 'checkout.started':
      return base('Inició un pago', COLORS.blue, [...orderFields(e.order), ...visitorFields(e.visitor)]);
    case 'order.paid':
      return base('Compra completada', COLORS.gold, [...orderFields(e.order), { name: 'Recibido', value: code(e.paid), inline: true }, { name: 'Por', value: code(e.actor), inline: true }]);
    case 'order.refunded':
      return base('Reembolso: acceso quitado', COLORS.purple, [...orderFields(e.order), { name: 'Detalle', value: code(e.detail, 300) }]);
    case 'order.disputed':
      return base('Contracargo o disputa: acceso quitado', COLORS.red, [...orderFields(e.order), { name: 'Detalle', value: code(e.detail, 300) }]);
    case 'order.review':
      return base('Pedido requiere revisión manual', COLORS.orange, [...orderFields(e.order), { name: 'Detalle', value: code(e.detail, 300) }]);
    case 'admin.grant':
    case 'admin.revoke':
      return base(e.type === 'admin.grant' ? 'Admin regaló un kit' : 'Admin quitó un kit', COLORS.purple, [
        { name: 'Admin', value: steamLink(e.admin), inline: true },
        { name: 'Jugador', value: steamLink(e.steamId), inline: true },
        { name: 'Detalle', value: code(e.detail, 300) },
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
    const content = this.dropped > 0 ? `${this.dropped} eventos más no se enviaron por el límite de Discord.` : undefined;
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
