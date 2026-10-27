/**
 * Members-only gate. When ACCESS_PASSWORD is set, every page, file and API call needs a
 * signed access cookie that is only issued for the right password. Payment webhooks, the
 * game plugin and the health check stay open: they authenticate with their own signatures.
 * Uses Web Crypto so the same code runs in the Cloudflare Worker and in Node.
 */

export const ACCESS_COOKIE = 'rs_access';
export const ACCESS_PATH = '/api/access';
const ACCESS_TTL_SECONDS = 30 * 86_400;

/** Paths that never need the cookie. */
export function isOpenPath(pathname: string): boolean {
  return (
    pathname === ACCESS_PATH ||
    pathname === '/api/health' ||
    pathname.startsWith('/api/webhooks/') ||
    pathname.startsWith('/api/plugin/') ||
    pathname === '/favicon.svg'
  );
}

// ---------- IP allowlist (ALLOWED_IPS) ----------

/** Parses an IPv4 or IPv6 address into a bigint and its bit width, or null when invalid. */
function parseIp(ip: string): { value: bigint; bits: 32 | 128 } | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((p) => p > 255)) return null;
    return { value: parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n), bits: 32 };
  }
  if (!ip.includes(':') || !/^[0-9a-fA-F:.]+$/.test(ip)) return null;
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) is treated as the IPv4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return parseIp(mapped[1]!);
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return { value: groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n), bits: 128 };
}

/** True when `ip` matches one entry of a comma-separated list of addresses and CIDR ranges. */
export function ipAllowed(ip: string | null | undefined, list: string): boolean {
  const addr = ip ? parseIp(ip.trim()) : null;
  if (!addr) return false;
  for (const raw of list.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const [base, prefixText] = entry.split('/');
    const net = base ? parseIp(base) : null;
    if (!net || net.bits !== addr.bits) continue;
    const prefix = prefixText === undefined ? net.bits : Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > net.bits) continue;
    const shift = BigInt(net.bits - prefix);
    if (addr.value >> shift === net.value >> shift) return true;
  }
  return false;
}

/** Plain refusal for addresses outside ALLOWED_IPS: no page, no hint about the site. */
export function ipRefusal(): Response {
  return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
}

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sign(password: string, message: string): Promise<string> {
  // The key comes from the password, so changing the password signs everyone out.
  const key = await crypto.subtle.importKey('raw', encoder.encode(`rust-store-access:${password}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function passwordMatches(password: string, attempt: string): Promise<boolean> {
  // Compare fixed-length digests so the time taken does not depend on the attempt.
  const [expected, given] = await Promise.all([sign(password, `attempt:${password}`), sign(password, `attempt:${attempt}`)]);
  return safeEqual(expected, given);
}

/**
 * The cookie is bound to the address that entered the password: from any other IP it is
 * refused and the visitor has to enter the password again, which then enables that IP.
 */
export async function issueCookie(password: string, nowSeconds: number, secure: boolean, ip: string): Promise<string> {
  const expires = nowSeconds + ACCESS_TTL_SECONDS;
  const value = `${expires}.${await sign(password, `access:${expires}:${ip}`)}`;
  return `${ACCESS_COOKIE}=${value}; Path=/; Max-Age=${ACCESS_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export async function hasAccess(password: string, cookieHeader: string | null | undefined, nowSeconds: number, ip: string | null | undefined): Promise<boolean> {
  if (!ip) return false;
  const value = readCookie(cookieHeader, ACCESS_COOKIE);
  if (!value || value.length > 200) return false;
  const [expiresText, mac] = value.split('.');
  const expires = Number(expiresText);
  if (!mac || !Number.isInteger(expires) || expires <= nowSeconds) return false;
  return safeEqual(mac, await sign(password, `access:${expires}:${ip}`));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Terms and refund policy, shown on the gate page. Keep in line with web/src/pages/Legal.tsx. */
function policiesHtml(name: string): string {
  return `<details>
<summary>Terms of service</summary>
<h2>Who can use the store</h2>
<p>The ${name} website and store are only for players authorized by the ${name} staff. By entering the access password, signing in or buying anything you confirm that you are authorized and agree to these terms and the server rules. Purchases by anyone else are prohibited: the access is removed and the order is not refunded, except where the law requires it.</p>
<h2>What you buy</h2>
<p>A kit gives your Steam account the right to claim that kit in game on our server, once per cooldown, for the access length you chose. Kits are virtual items with no cash value. They cannot be resold, transferred to another account or exchanged for money. Lifetime access lasts for as long as we run the server and store.</p>
<h2>Delivery and server changes</h2>
<p>Access starts automatically once the payment is confirmed. Rust is a live game: we may change kit contents, cooldowns, settings and the wipe schedule, and wipes remove items already claimed. If the server closes permanently, active access ends with it.</p>
<h2>Rules, bans and chargebacks</h2>
<p>Buying a kit does not exempt anyone from the server rules. A ban for breaking them removes access to purchased kits without a refund. Opening a chargeback or payment dispute removes the access bought with that payment and can block the account from the store.</p>
<h2>Payments</h2>
<p>Payments are processed by Stripe (shown on statements as LINK.COM* CC DIGITAL), PayPal or Mercado Pago. We never see your full card details. Payment providers may also apply their own buyer-protection rules.</p>
<h2>Liability and age</h2>
<p>The server and store are provided as they are, without a guarantee of uptime. To the extent the law allows, our liability for a purchase is limited to the amount paid for it. If you are under 18, you need permission from a parent or guardian to buy.</p>
<h2>Changes</h2>
<p>We may update these terms. The version shown when you buy applies to that purchase.</p>
</details>
<details>
<summary>Refund policy</summary>
<p>All purchases are final and non-refundable.</p>
<p>The only exception is an internal problem on our server that stops you from receiving or using what you bought, such as a kit that never reached your account because of an error on our side. Staff check each case, and if it is confirmed we either fix the delivery or refund the purchase.</p>
<ul>
<li>Changing your mind, wipes, bans, server rule changes or game updates are not reasons for a refund.</li>
<li>To report a problem, open a ticket with the server staff within 14 days and include your order ID.</li>
<li>Nothing in this policy limits rights you have under consumer protection law where you live.</li>
</ul>
</details>`;
}

/** The page shown to anyone without access. Plain HTML form, no scripts. */
export function gatePage(siteName: string, wrongPassword: boolean, locked = false): string {
  const name = escapeHtml(siteName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${name}: members only</title>
<style>
:root { color-scheme: dark; --bg: #222725; --panel: #2c3230; --line: #4a524f; --text: #eeebe0; --muted: #a8aea6; --go: #0e6b47; --go-hover: #128056; --stop: #f08a80; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--text); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 560px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 28px 24px; }
h1 { margin: 0 0 8px; font-size: 1.5rem; line-height: 1.2; }
p { margin: 0 0 20px; color: var(--muted); }
label { display: grid; gap: 6px; font-weight: 600; }
input { font: inherit; padding: 10px 12px; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; }
button { margin-top: 16px; width: 100%; font: inherit; font-weight: 700; padding: 12px; color: #fff; background: var(--go); border: 0; border-radius: 8px; cursor: pointer; }
button:hover { background: var(--go-hover); }
input:focus-visible, button:focus-visible { outline: 3px solid #f2c230; outline-offset: 2px; }
.error { color: var(--stop); margin: 12px 0 0; }
.notice { margin: 24px 0 0; padding: 14px 16px; border-left: 4px solid #f2c230; background: var(--bg); border-radius: 6px; color: var(--text); }
.notice p { margin: 0 0 8px; color: var(--text); }
.notice p:last-child { margin: 0; }
details { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 12px; }
summary { cursor: pointer; font-weight: 700; }
details h2 { font-size: 1rem; margin: 16px 0 4px; color: var(--text); }
details p, details li { color: var(--muted); font-size: 0.92rem; margin: 0 0 8px; }
details ul { padding-left: 20px; margin: 0 0 8px; }
</style>
</head>
<body>
<main>
<h1>${name}</h1>
<p>This site is only for players allowed on the ${name} Rust server. Enter the access password you got from the server staff.</p>
<form method="post" action="${ACCESS_PATH}">
<label for="password">Access password
<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="200" autofocus>
</label>
${wrongPassword ? '<p class="error" role="alert">That password is not right. Check it with the server staff.</p>' : ''}
${locked ? '<p class="error" role="alert">Too many wrong passwords from this connection. Try again in 15 minutes.</p>' : ''}
<button type="submit">Enter</button>
</form>
<div class="notice">
<p><strong>Members only.</strong> Only players authorized by the ${name} staff may use this site and buy kits. Anyone else is not allowed to make purchases.</p>
<p><strong>All purchases are final.</strong> Refunds are only given when an internal problem on our server stops you from receiving or using what you bought. In any other case there are no refunds.</p>
</div>
${policiesHtml(name)}
</main>
</body>
</html>`;
}

const GATE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  // no-referrer would make browsers send `Origin: null` on the password form.
  'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

/**
 * Handles the gate for one request. Returns a Response when the request must stop here
 * (gate page, refusal or the password form), or null when it may continue.
 */
/** Accepts form posts from our own pages. Some browsers send `Origin: null`; Sec-Fetch-Site then decides. */
export function sameOriginPost(origin: string | null | undefined, fetchSite: string | null | undefined, ownOrigin: string): boolean {
  if (!origin) return true;
  if (origin === ownOrigin) return true;
  return origin === 'null' && fetchSite === 'same-origin';
}

/** Counts wrong passwords per address. The Worker keeps the counters in the Durable Object. */
export interface AttemptLimiter {
  isBlocked(ip: string): Promise<boolean>;
  recordFailure(ip: string): Promise<void>;
}

export async function gate(request: Request, password: string, siteName: string, nowSeconds: number, limiter?: AttemptLimiter): Promise<Response | null> {
  const url = new URL(request.url);
  const ip = request.headers.get('cf-connecting-ip');
  const secure = url.protocol === 'https:';
  if (url.pathname === ACCESS_PATH && request.method === 'POST') {
    // Same-site form posts only.
    if (!sameOriginPost(request.headers.get('origin'), request.headers.get('sec-fetch-site'), url.origin)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!ip) return new Response('Forbidden', { status: 403 });
    if (limiter && (await limiter.isBlocked(ip))) {
      return new Response(gatePage(siteName, false, true), { status: 429, headers: { ...GATE_HEADERS, 'Retry-After': '900' } });
    }
    let attempt = '';
    try {
      const form = await request.formData();
      attempt = String(form.get('password') ?? '').slice(0, 200);
    } catch {
      attempt = '';
    }
    if (await passwordMatches(password, attempt)) {
      return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': await issueCookie(password, nowSeconds, secure, ip), 'Cache-Control': 'no-store' } });
    }
    await limiter?.recordFailure(ip);
    return new Response(gatePage(siteName, true), { status: 401, headers: GATE_HEADERS });
  }
  if (isOpenPath(url.pathname)) return null;
  if (await hasAccess(password, request.headers.get('cookie'), nowSeconds, ip)) return null;
  if (url.pathname.startsWith('/api/')) {
    return Response.json({ error: { code: 'access_required', message: 'Enter the access password first.' } }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response(gatePage(siteName, false), { status: 401, headers: GATE_HEADERS });
}
