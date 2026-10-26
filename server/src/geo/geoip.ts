import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Logger } from 'pino';

/**
 * Country lookup backed by the public-domain (PDDL) "user-country" database
 * from github.com/sapics/ip-location-db, stored as numeric CSV ranges.
 */

const V4_FILE = 'user-country-ipv4-num.csv';
const V6_FILE = 'user-country-ipv6-num.csv';
const MASK64 = (1n << 64n) - 1n;

interface V4Table {
  start: Uint32Array;
  end: Uint32Array;
  cc: Uint16Array;
}
interface V6Table {
  startHi: BigUint64Array;
  startLo: BigUint64Array;
  endHi: BigUint64Array;
  endLo: BigUint64Array;
  cc: Uint16Array;
}

const encodeCc = (cc: string) => (cc.charCodeAt(0) << 8) | cc.charCodeAt(1);
const decodeCc = (n: number) => String.fromCharCode(n >> 8, n & 0xff);

export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

export function ipv6ToBigInt(ip: string): bigint | null {
  let s = ip.split('%')[0] ?? '';
  if (!net.isIPv6(s)) return null;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...new Array<string>(fill).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

function isPrivateV4(n: number): boolean {
  const a = n >>> 24;
  const b = (n >>> 16) & 0xff;
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function parseV4(text: string): V4Table {
  const lines = text.split('\n');
  const start = new Uint32Array(lines.length);
  const end = new Uint32Array(lines.length);
  const cc = new Uint16Array(lines.length);
  let n = 0;
  for (const line of lines) {
    const [a, b, c] = line.trim().split(',');
    if (!a || !b || !c || c.length !== 2) continue;
    start[n] = Number(a);
    end[n] = Number(b);
    cc[n] = encodeCc(c.toUpperCase());
    n++;
  }
  return { start: start.slice(0, n), end: end.slice(0, n), cc: cc.slice(0, n) };
}

function parseV6(text: string): V6Table {
  const lines = text.split('\n');
  const startHi = new BigUint64Array(lines.length);
  const startLo = new BigUint64Array(lines.length);
  const endHi = new BigUint64Array(lines.length);
  const endLo = new BigUint64Array(lines.length);
  const cc = new Uint16Array(lines.length);
  let n = 0;
  for (const line of lines) {
    const [a, b, c] = line.trim().split(',');
    if (!a || !b || !c || c.length !== 2) continue;
    const s = BigInt(a);
    const e = BigInt(b);
    startHi[n] = s >> 64n;
    startLo[n] = s & MASK64;
    endHi[n] = e >> 64n;
    endLo[n] = e & MASK64;
    cc[n] = encodeCc(c.toUpperCase());
    n++;
  }
  return {
    startHi: startHi.slice(0, n),
    startLo: startLo.slice(0, n),
    endHi: endHi.slice(0, n),
    endLo: endLo.slice(0, n),
    cc: cc.slice(0, n),
  };
}

export class GeoIp {
  private v4: V4Table | null = null;
  private v6: V6Table | null = null;
  private updating: Promise<void> | null = null;
  loadedAt: number | null = null;

  constructor(
    private readonly dir: string,
    private readonly log: Logger,
  ) {}

  get ready(): boolean {
    return this.v4 !== null;
  }

  loadFromDisk(): boolean {
    try {
      const v4Path = path.join(this.dir, V4_FILE);
      const v6Path = path.join(this.dir, V6_FILE);
      if (!fs.existsSync(v4Path)) return false;
      this.v4 = parseV4(fs.readFileSync(v4Path, 'utf8'));
      this.v6 = fs.existsSync(v6Path) ? parseV6(fs.readFileSync(v6Path, 'utf8')) : null;
      this.loadedAt = Date.now();
      this.log.info({ v4: this.v4.start.length, v6: this.v6?.cc.length ?? 0 }, 'GeoIP database loaded');
      return true;
    } catch (err) {
      this.log.error({ err }, 'Failed to load GeoIP database');
      return false;
    }
  }

  /** Loads test data directly (used by tests). */
  loadFromText(v4: string, v6 = ''): void {
    this.v4 = parseV4(v4);
    this.v6 = v6 ? parseV6(v6) : null;
    this.loadedAt = Date.now();
  }

  lookup(ip: string | undefined | null): string | null {
    if (!ip) return null;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    const candidate = mapped ? mapped[1]! : ip;
    if (net.isIPv4(candidate)) {
      const n = ipv4ToInt(candidate);
      if (n === null || isPrivateV4(n) || !this.v4) return null;
      return this.lookupV4(n);
    }
    const big = ipv6ToBigInt(candidate);
    if (big === null || !this.v6) return null;
    return this.lookupV6(big);
  }

  private lookupV4(n: number): string | null {
    const t = this.v4!;
    let lo = 0;
    let hi = t.start.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (t.start[mid]! <= n) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found >= 0 && n <= t.end[found]!) return decodeCc(t.cc[found]!);
    return null;
  }

  private lookupV6(n: bigint): string | null {
    const t = this.v6!;
    const qHi = n >> 64n;
    const qLo = n & MASK64;
    const le = (aHi: bigint, aLo: bigint, bHi: bigint, bLo: bigint) => aHi < bHi || (aHi === bHi && aLo <= bLo);
    let lo = 0;
    let hi = t.cc.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (le(t.startHi[mid]!, t.startLo[mid]!, qHi, qLo)) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found >= 0 && le(qHi, qLo, t.endHi[found]!, t.endLo[found]!)) return decodeCc(t.cc[found]!);
    return null;
  }

  /** Downloads fresh data when the local copy is missing or older than maxAgeHours. */
  async updateIfStale(baseUrl: string, maxAgeHours = 24, fetchFn: typeof fetch = fetch): Promise<void> {
    if (this.updating) return this.updating;
    this.updating = (async () => {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        const v4Path = path.join(this.dir, V4_FILE);
        const fresh = fs.existsSync(v4Path) && Date.now() - fs.statSync(v4Path).mtimeMs < maxAgeHours * 3_600_000;
        if (fresh) {
          if (!this.ready) this.loadFromDisk();
          return;
        }
        for (const file of [V4_FILE, V6_FILE]) {
          await downloadVerified(fetchFn, `${baseUrl}/latest/${file}`, `${baseUrl}/checksum/${file}.sha256`, path.join(this.dir, file));
        }
        this.log.info('GeoIP database downloaded');
        this.loadFromDisk();
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, 'GeoIP update failed; keeping the previous data');
        if (!this.ready) this.loadFromDisk();
      } finally {
        this.updating = null;
      }
    })();
    return this.updating;
  }
}

async function downloadVerified(fetchFn: typeof fetch, url: string, checksumUrl: string, target: string): Promise<void> {
  const [fileRes, sumRes] = await Promise.all([
    fetchFn(url, { signal: AbortSignal.timeout(120_000) }),
    fetchFn(checksumUrl, { signal: AbortSignal.timeout(30_000) }),
  ]);
  if (!fileRes.ok) throw new Error(`Download failed (${fileRes.status}) for ${url}`);
  if (!sumRes.ok) throw new Error(`Checksum download failed (${sumRes.status}) for ${checksumUrl}`);
  const body = Buffer.from(await fileRes.arrayBuffer());
  const expected = (await sumRes.text()).trim().split(/\s+/)[0]?.toLowerCase();
  const actual = crypto.createHash('sha256').update(body).digest('hex');
  if (!expected || expected !== actual) throw new Error(`Checksum mismatch for ${url}`);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, target);
}
