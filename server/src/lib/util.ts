import crypto from 'node:crypto';

export type Clock = () => number;

/** Current unix time in seconds. */
export const systemClock: Clock = () => Math.floor(Date.now() / 1000);

export const STEAM_ID_RE = /^7656119\d{10}$/;

export function isSteamId(value: unknown): value is string {
  return typeof value === 'string' && STEAM_ID_RE.test(value);
}

export function randomId(prefix: string, bytes = 12): string {
  return `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hmacHex(secret: string, value: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]*$/i.test(a + b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

const ZERO_DECIMAL = new Set(['CLP', 'JPY', 'KRW', 'PYG', 'VND', 'UGX', 'XAF', 'XOF']);

export function currencyDecimals(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

export function minorToMajor(amount: number, currency: string): number {
  return amount / 10 ** currencyDecimals(currency);
}

export function majorToMinor(amount: number, currency: string): number {
  return Math.round(amount * 10 ** currencyDecimals(currency));
}

export function formatMoney(amountMinor: number, currency: string): string {
  const decimals = currencyDecimals(currency);
  const value = minorToMajor(amountMinor, currency);
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals === 0 || Number.isInteger(value) ? 0 : decimals,
    maximumFractionDigits: decimals,
  }).format(value);
  return currency.toUpperCase() === 'USD' ? `$${formatted}` : `${currency.toUpperCase()} ${formatted}`;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = 'error',
  ) {
    super(message);
  }
}
