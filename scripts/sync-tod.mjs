// Copy the TOD metro map (repo HcmTod) into public/tod/ so Cloudflare Pages serves it at /tod/.
// Usage: node scripts/sync-tod.mjs [path to HcmTod]   (default: ../HcmTod next to this repo)
// HcmTod stays the source of truth: edit there, then re-run this and commit public/tod/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(process.argv[2] ?? path.join(root, '..', 'HcmTod'));
const dst = path.join(root, 'public', 'tod');
const LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist'; // same CDN build as the flood map

if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.error(`HcmTod not found at ${src} (pass its path as the first argument)`);
  process.exit(1);
}
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });

let html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
const before = html;
html = html
  .replace('href="node_modules/leaflet/dist/leaflet.css"', `href="${LEAFLET}/leaflet.css" crossorigin=""`)
  .replace('src="node_modules/leaflet/dist/leaflet.js"', `src="${LEAFLET}/leaflet.js" crossorigin=""`)
  .replace('<div id="search-credit">', '<div id="back-link"><a href="/">← Bản đồ dự báo ngập</a></div>\n    <div id="search-credit">');
if (html === before || html.includes('node_modules/')) {
  console.error('index.html layout changed: Leaflet path or credit block not found, update sync-tod.mjs');
  process.exit(1);
}
fs.writeFileSync(path.join(dst, 'index.html'), html);

for (const dir of ['src', 'data']) fs.cpSync(path.join(src, dir), path.join(dst, dir), { recursive: true });

const files = fs.readdirSync(dst, { recursive: true }).filter(f => fs.statSync(path.join(dst, f)).isFile());
console.log(`synced ${files.length} files from ${src} to public/tod/`);
