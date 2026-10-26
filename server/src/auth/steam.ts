import { isSteamId } from '../lib/util.js';

export const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const CLAIMED_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

export function buildSteamLoginUrl(returnTo: string, realm: string): string {
  const params = new URLSearchParams({
    'openid.ns': OPENID_NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': IDENTIFIER_SELECT,
    'openid.claimed_id': IDENTIFIER_SELECT,
  });
  return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`;
}

/** `code` is what the site shows the visitor; the message stays in the server log. */
export class SteamAuthError extends Error {
  constructor(
    message: string,
    readonly code: 'cancelled' | 'expired' | 'failed' = 'failed',
  ) {
    super(message);
  }
}

/**
 * Verifies a Steam OpenID 2.0 positive assertion and returns the SteamID64.
 * Checks the return URL, the claimed identifier format, the signed field list,
 * and finally asks Steam to confirm the signature (check_authentication).
 */
export async function verifySteamAssertion(
  query: Record<string, unknown>,
  expectedReturnTo: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('openid.')) continue;
    if (typeof value !== 'string') throw new SteamAuthError(`Unexpected value for ${key}`);
    fields[key] = value;
  }

  if (fields['openid.ns'] !== OPENID_NS) throw new SteamAuthError('Invalid OpenID namespace');
  if (fields['openid.mode'] !== 'id_res') throw new SteamAuthError('Login was cancelled or failed', 'cancelled');
  if (fields['openid.op_endpoint'] !== STEAM_OPENID_ENDPOINT) throw new SteamAuthError('Unexpected OpenID provider');
  if (fields['openid.return_to'] !== expectedReturnTo) throw new SteamAuthError('Return URL mismatch');

  const claimed = fields['openid.claimed_id'] ?? '';
  const match = CLAIMED_ID_RE.exec(claimed);
  if (!match || fields['openid.identity'] !== claimed) throw new SteamAuthError('Invalid claimed identifier');
  const steamId = match[1]!;
  if (!isSteamId(steamId)) throw new SteamAuthError('Invalid SteamID');

  const signed = new Set((fields['openid.signed'] ?? '').split(','));
  for (const required of ['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle']) {
    if (!signed.has(required)) throw new SteamAuthError(`Assertion does not sign ${required}`);
  }

  const body = new URLSearchParams(fields);
  body.set('openid.mode', 'check_authentication');
  const res = await fetchFn(STEAM_OPENID_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/plain' },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new SteamAuthError(`Steam verification failed (${res.status})`);
  const text = await res.text();
  const valid = text.split('\n').some((line) => line.trim() === 'is_valid:true');
  if (!valid) throw new SteamAuthError('Steam rejected the login assertion');
  return steamId;
}

export interface SteamProfile {
  name: string | null;
  avatarUrl: string | null;
}

export async function fetchSteamProfile(apiKey: string, steamId: string, fetchFn: typeof fetch = fetch): Promise<SteamProfile | null> {
  const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('steamids', steamId);
  const res = await fetchFn(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as { response?: { players?: { steamid?: string; personaname?: string; avatarfull?: string }[] } };
  const player = data.response?.players?.find((p) => p.steamid === steamId);
  if (!player) return null;
  return { name: player.personaname?.slice(0, 64) ?? null, avatarUrl: player.avatarfull ?? null };
}
