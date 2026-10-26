import { hmacHex, safeEqualHex } from '../lib/util.js';

export const MAX_CLOCK_SKEW_SECONDS = 300;

/**
 * Request signature: hex(HMAC-SHA256(secret, `${timestamp}\n${rawBody}`)).
 * Sent as X-Store-Timestamp and X-Store-Signature.
 */
export function signRequest(secret: string, timestamp: number, rawBody: string): string {
  return hmacHex(secret, `${timestamp}\n${rawBody}`);
}

export function verifyRequest(
  secret: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  rawBody: string,
  now: number,
): { ok: true } | { ok: false; reason: string } {
  if (!timestampHeader || !/^\d{9,11}$/.test(timestampHeader)) return { ok: false, reason: 'missing or invalid timestamp' };
  const ts = Number(timestampHeader);
  if (Math.abs(now - ts) > MAX_CLOCK_SKEW_SECONDS) return { ok: false, reason: 'timestamp outside allowed window (check the game server clock)' };
  if (!signatureHeader) return { ok: false, reason: 'missing signature' };
  const expected = signRequest(secret, ts, rawBody);
  if (!safeEqualHex(expected, signatureHeader.toLowerCase())) return { ok: false, reason: 'bad signature (check PLUGIN_SECRET)' };
  return { ok: true };
}

/**
 * Responses are wrapped so the plugin can verify them even if TLS is misconfigured:
 * { "payload": "<json string>", "signature": hex(HMAC-SHA256(secret, payload)) }
 */
export function signEnvelope(secret: string, payload: unknown): { payload: string; signature: string } {
  const json = JSON.stringify(payload);
  return { payload: json, signature: hmacHex(secret, json) };
}
