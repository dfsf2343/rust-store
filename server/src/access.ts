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

/** The page shown to anyone without access. Plain HTML form, no scripts. */
export function gatePage(siteName: string, wrongPassword: boolean): string {
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
main { width: 100%; max-width: 420px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 28px 24px; }
h1 { margin: 0 0 8px; font-size: 1.5rem; line-height: 1.2; }
p { margin: 0 0 20px; color: var(--muted); }
label { display: grid; gap: 6px; font-weight: 600; }
input { font: inherit; padding: 10px 12px; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; }
button { margin-top: 16px; width: 100%; font: inherit; font-weight: 700; padding: 12px; color: #fff; background: var(--go); border: 0; border-radius: 8px; cursor: pointer; }
button:hover { background: var(--go-hover); }
input:focus-visible, button:focus-visible { outline: 3px solid #f2c230; outline-offset: 2px; }
.error { color: var(--stop); margin: 12px 0 0; }
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
<button type="submit">Enter</button>
</form>
</main>
</body>
</html>`;
}

const GATE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

/**
 * Handles the gate for one request. Returns a Response when the request must stop here
 * (gate page, refusal or the password form), or null when it may continue.
 */
export async function gate(request: Request, password: string, siteName: string, nowSeconds: number): Promise<Response | null> {
  const url = new URL(request.url);
  const ip = request.headers.get('cf-connecting-ip');
  const secure = url.protocol === 'https:';
  if (url.pathname === ACCESS_PATH && request.method === 'POST') {
    // Same-site form posts only.
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return new Response('Forbidden', { status: 403 });
    let attempt = '';
    try {
      const form = await request.formData();
      attempt = String(form.get('password') ?? '').slice(0, 200);
    } catch {
      attempt = '';
    }
    if (ip && (await passwordMatches(password, attempt))) {
      return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': await issueCookie(password, nowSeconds, secure, ip), 'Cache-Control': 'no-store' } });
    }
    return new Response(gatePage(siteName, true), { status: 401, headers: GATE_HEADERS });
  }
  if (isOpenPath(url.pathname)) return null;
  if (await hasAccess(password, request.headers.get('cookie'), nowSeconds, ip)) return null;
  if (url.pathname.startsWith('/api/')) {
    return Response.json({ error: { code: 'access_required', message: 'Enter the access password first.' } }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response(gatePage(siteName, false), { status: 401, headers: GATE_HEADERS });
}
