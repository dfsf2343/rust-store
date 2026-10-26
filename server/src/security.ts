import type { SiteContent } from './content.js';

/** Content-Security-Policy for the site. Express sends it on Node; on Cloudflare it is written into web/dist/_headers at build time. */
export function cspDirectives(site: SiteContent, baseUrl: string): Record<string, string[]> {
  const iconHost = site.store.itemIconUrl ? new URL(site.store.itemIconUrl.replace('{shortname}', 'x')).origin : null;
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'script-src': ["'self'"],
    'script-src-attr': ["'none'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'https://*.steamstatic.com', 'https://steamcdn-a.akamaihd.net', ...(iconHost ? [iconHost] : [])],
    'font-src': ["'self'"],
    'connect-src': ["'self'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
  };
  if (baseUrl.startsWith('https://')) directives['upgrade-insecure-requests'] = [];
  return directives;
}

export function serializeCsp(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([name, values]) => (values.length ? `${name} ${values.join(' ')}` : name))
    .join('; ');
}

/** The other headers helmet sends, for static files served outside Express. */
export const STATIC_SECURITY_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-DNS-Prefetch-Control': 'off',
  'X-Download-Options': 'noopen',
  'X-Frame-Options': 'DENY',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'X-XSS-Protection': '0',
};
