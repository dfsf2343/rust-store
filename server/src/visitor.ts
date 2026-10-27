import type { Request } from 'express';
import type { AppContext } from './context.js';
import { readDeviceId, type Visitor } from './events.js';
import { resolveCountry } from './geo/routing.js';

/** Set by the Worker from Cloudflare's request data; client-supplied values are overwritten. */
export const VISITOR_HEADER = 'x-store-visitor';

export type EdgeDetails = Pick<Visitor, 'region' | 'city' | 'postalCode' | 'timezone' | 'network' | 'asn'>;

function str(v: unknown, max = 100): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

export function parseEdgeDetails(raw: unknown): EdgeDetails {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    region: str(o.region),
    city: str(o.city),
    postalCode: str(o.postalCode, 16),
    timezone: str(o.timezone, 64),
    network: str(o.network),
    asn: typeof o.asn === 'number' && Number.isInteger(o.asn) ? o.asn : null,
  };
}

export function firstLanguage(header: string | null | undefined): string | null {
  return header ? (header.split(',')[0]?.trim().slice(0, 35) ?? null) : null;
}

/** Who made this request, for the activity log. */
export function visitorFromRequest(req: Request, ctx: AppContext): Visitor {
  let edge: EdgeDetails = {};
  // Only the Worker sets this header (it replaces any value sent by the client).
  if (ctx.config.runtime === 'cloudflare') {
    try {
      edge = parseEdgeDetails(JSON.parse(req.get(VISITOR_HEADER) ?? '{}'));
    } catch {
      edge = {};
    }
  }
  return {
    ip: req.ip ?? null,
    country: resolveCountry(req, ctx.config, ctx.geo).country,
    ...edge,
    userAgent: req.get('user-agent')?.slice(0, 400) ?? null,
    language: firstLanguage(req.get('accept-language')),
    referrer: null,
    deviceId: readDeviceId(req.get('cookie')),
    newDevice: false,
  };
}
