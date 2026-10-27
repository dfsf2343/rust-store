import { isSteamId } from '../lib/util.js';

export class SteamIdInputError extends Error {}

/**
 * Accepts a SteamID64, a steamcommunity.com/profiles/<id> link, or a custom
 * steamcommunity.com/id/<name> link (resolved through the Steam Web API when a key is set).
 */
export async function resolveSteamInput(raw: string, apiKey: string | null, fetchFn: typeof fetch): Promise<string> {
  const input = raw.trim();
  if (isSteamId(input)) return input;
  const profile = /^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/profiles\/(\d{17})\/?$/i.exec(input);
  if (profile && isSteamId(profile[1])) return profile[1]!;
  const vanity = /^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/id\/([A-Za-z0-9_-]{2,32})\/?$/i.exec(input);
  if (vanity) {
    if (!apiKey) throw new SteamIdInputError('Use your SteamID64 (17 digits) or a steamcommunity.com/profiles/ link.');
    const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(apiKey)}&vanityurl=${encodeURIComponent(vanity[1]!)}`;
    const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    const data = res?.ok ? ((await res.json().catch(() => null)) as { response?: { success?: number; steamid?: string } } | null) : null;
    const id = data?.response?.success === 1 ? data.response.steamid : undefined;
    if (isSteamId(id)) return id;
    throw new SteamIdInputError('That Steam profile was not found. Check the link or use your SteamID64.');
  }
  throw new SteamIdInputError('Enter your SteamID64 (17 digits starting with 7656119) or your Steam profile link.');
}
