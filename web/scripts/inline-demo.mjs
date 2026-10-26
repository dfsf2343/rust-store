// Turns dist-demo/ into one self-contained HTML page (script, styles and fonts inline),
// written to dist-demo/preview.html. Usage: node scripts/inline-demo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist-demo');
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');

const scriptSrc = /<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/.exec(html)?.[1];
const cssHref = /<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/.exec(html)?.[1];
if (!scriptSrc || !cssHref) throw new Error('Unexpected dist-demo/index.html: script or stylesheet tag not found');

const js = fs.readFileSync(path.join(dist, scriptSrc), 'utf8').replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(path.join(dist, cssHref), 'utf8').replace(/<\/style/gi, '<\\/style');
if (/url\((?!["']?data:)/.test(css)) throw new Error('A stylesheet asset was not inlined');

const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? 'Store preview';
const page = `<title>${title}</title>
<meta name="description" content="Preview of the store with sample data and simulated payments.">
<style>${css}</style>
<div id="root"></div>
<script type="module">${js}</script>
`;
fs.writeFileSync(path.join(dist, 'preview.html'), page);
console.log(`Wrote dist-demo/preview.html (${Math.round(page.length / 1024)} KB)`);
