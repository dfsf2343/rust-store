/**
 * Writes web/dist/_headers for Workers Static Assets: the same security headers Express
 * sends on Node, plus long caching for hashed files. Run after the web build.
 * Pass --http (or set STATIC_HEADERS_HTTP=1) for local testing over plain HTTP: drops
 * upgrade-insecure-requests and HSTS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContent } from '../src/content.js';
import { cspDirectives, serializeCsp, STATIC_SECURITY_HEADERS } from '../src/security.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  throw new Error('web/dist/index.html is missing: build the website first.');
}

const content = loadContent(path.join(root, 'config'));
const http = process.argv.includes('--http') || process.env.STATIC_HEADERS_HTTP === '1';
const csp = serializeCsp(cspDirectives(content.site, http ? 'http://' : 'https://'));
const headers = http
  ? Object.fromEntries(Object.entries(STATIC_SECURITY_HEADERS).filter(([name]) => name !== 'Strict-Transport-Security'))
  : STATIC_SECURITY_HEADERS;

const lines = [
  '/*',
  `  Content-Security-Policy: ${csp}`,
  ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`),
  '',
  '/assets/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
];
fs.writeFileSync(path.join(dist, '_headers'), lines.join('\n'));
console.log(`Wrote ${path.relative(root, path.join(dist, '_headers'))}`);
