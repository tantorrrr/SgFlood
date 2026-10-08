// Fetch Phú An bulletins (Đài KTTV Nam Bộ) + Open-Meteo marine, fit the bias, write public/data/tide-phuan.json.
// Run daily: `npm run fetch:tide`.  `--seed <obs.jsonl>` imports previously parsed observations once.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pdfTextRuns, parseBulletin, isTvhnTitle } from './lib/tvhn.mjs';
import { computeBias, DEFAULT_TIDE, HOUR } from '../public/js/tide.js';

const ROOT = new URL('..', import.meta.url);
const OUT = new URL('public/data/tide-phuan.json', ROOT);
const PDF_CACHE = new URL('data/cache/tvhn/', ROOT);
const HEADERS = { 'User-Agent': 'HcmFlood-POC/0.1 (+local dev)' };
// kttvnb.vn's HTTPS certificate is expired → plain HTTP. The RSS feed of the "Thủy văn" category is
// the listing; the article id cannot be derived from the date.
const SITE = 'http://kttvnb.vn';
const FEED = `${SITE}/index.php/thong-tin-kttv/thuy-van/100-thong-tin-kttv/thuy-van?format=feed&type=rss`;
const FEED_PAGE = 10;
const MAX_FEED_PAGES = 12;
const MAX_DAYS = 14;
const MARINE = 'https://marine-api.open-meteo.com/v1/marine?latitude=10.375&longitude=106.958&hourly=sea_level_height_msl&timezone=Asia%2FHo_Chi_Minh';
const SOURCE = 'Đài KTTV Nam Bộ (HCMC_TVHN) + Open-Meteo marine @10.375,106.958';

const DAY = 24 * HOUR;
const today = () => new Date(Date.now() + 7 * HOUR).toISOString().slice(0, 10);
const addDays = (iso, d) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * DAY).toISOString().slice(0, 10);

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return as === 'buffer' ? Buffer.from(await res.arrayBuffer()) : res.text();
}

async function discoverBulletins() {
  const since = Date.now() - (MAX_DAYS + 1) * DAY;
  const articles = [];
  for (let page = 0; page < MAX_FEED_PAGES; page++) {
    const xml = await get(`${FEED}&limitstart=${page * FEED_PAGE}`);
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => ({
      title: it.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '',
      link: it.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '',
      date: Date.parse(it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? ''),
    }));
    if (!items.length) break;
    articles.push(...items.filter((i) => isTvhnTitle(i.title) && i.date >= since));
    if (items.every((i) => i.date < since)) break;
  }
  const urls = new Map();
  for (const a of articles) {
    try {
      const html = await get(a.link.replace(/^https:/, 'http:'));
      for (const [, path, ymd] of html.matchAll(/(attachments\/article\/\d+\/HCMC_TVHN_(\d{8})\.pdf)/g)) urls.set(ymd, `${SITE}/${path}`);
    } catch (err) {
      console.warn(`  article ${a.link}: ${err.message}`);
    }
  }
  return [...urls.entries()].sort(([a], [b]) => b.localeCompare(a)).slice(0, MAX_DAYS);
}

async function loadPdf(ymd, url) {
  const file = new URL(`HCMC_TVHN_${ymd}.pdf`, PDF_CACHE);
  if (existsSync(file)) return readFile(file);
  const buf = await get(url, 'buffer');
  await mkdir(PDF_CACHE, { recursive: true });
  await writeFile(file, buf);
  return buf;
}

// research obs.jsonl: {obs_date, PA:[[h,"HH:MM"]|null ×2], PA_low:[…×2]}
function seedEvents(text) {
  const out = [];
  for (const line of text.split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    const add = (pairs, kind) => (pairs ?? []).filter(Boolean).forEach(([h, clock]) => out.push({ t: `${r.obs_date}T${clock}:00+07:00`, h, kind }));
    add(r.PA, 'peak');
    add(r.PA_low, 'low');
  }
  return out;
}

function mergeEvents(...lists) {
  const map = new Map();
  for (const e of lists.flat()) map.set(`${e.t}|${e.kind}`, e);
  return [...map.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

async function loadMarine(startDay, endDay) {
  const json = JSON.parse(await get(`${MARINE}&start_date=${startDay}&end_date=${endDay}`));
  const map = new Map();
  json.hourly.time.forEach((t, i) => {
    const v = json.hourly.sea_level_height_msl[i];
    if (v != null) map.set(Date.parse(`${t}:00+07:00`), v);
  });
  return (t) => map.get(t) ?? null;
}

async function main() {
  const prev = existsSync(OUT) ? JSON.parse(await readFile(OUT, 'utf8')) : {};
  const seedIdx = process.argv.indexOf('--seed');
  const seeded = seedIdx > 0 ? seedEvents(await readFile(process.argv[seedIdx + 1], 'utf8')) : [];
  if (seeded.length) console.log(`Seeded ${seeded.length} observed events from ${process.argv[seedIdx + 1]}`);

  console.log('Discovering bulletins (RSS listing)…');
  const found = await discoverBulletins();
  console.log(`  ${found.length} bulletin(s): ${found.map(([d]) => d).join(', ')}`);

  const parsed = [];
  for (const [ymd, url] of found) {
    const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`;
    try {
      parsed.push({ date, url, ...parseBulletin(pdfTextRuns(await loadPdf(ymd, url)), date) });
    } catch (err) {
      console.warn(`  skip ${url}: ${err.message}`);
    }
  }
  console.log(`  parsed ${parsed.length}/${found.length}`);

  const observed = mergeEvents(prev.observed ?? [], seeded, parsed.map((p) => p.observed));
  const latest = parsed[0];
  const forecast = latest ? latest.forecast : (prev.forecast ?? []);
  if (!observed.length) throw new Error('no observations at all');

  const first = observed[0].t.slice(0, 10);
  const lastFc = forecast.length ? forecast.at(-1).t.slice(0, 10) : today();
  const omAt = await loadMarine(addDays(first, -1), [lastFc, addDays(today(), 7)].sort()[0]);
  const { bias, n } = computeBias(observed, omAt, { lagH: DEFAULT_TIDE.lagH, fallback: DEFAULT_TIDE.bias });

  const out = {
    fetchedAt: new Date(Date.now() + 7 * HOUR).toISOString().replace(/\.\d+Z$/, '+07:00'),
    source: SOURCE,
    alerts: DEFAULT_TIDE.alerts,
    lagH: DEFAULT_TIDE.lagH,
    bias,
    biasN: n,
    observed,
    forecast,
    bulletins: parsed.length ? parsed.map((p) => p.url) : (prev.bulletins ?? []),
  };
  await writeFile(OUT, JSON.stringify(out));

  const peaks = observed.filter((e) => e.kind === 'peak');
  const latestPeak = peaks.reduce((a, e) => (Date.parse(e.t) > Date.parse(a.t) ? e : a));
  console.log(`\nbias = ${bias} m (n = ${n} peaks ≥ 1.0 m)  |  observed events: ${observed.length}`);
  console.log(`latest observed peak: ${latestPeak.h} m @ ${latestPeak.t}`);
  console.log(`forecast peaks (${latest ? latest.date : 'previous file'}): ${forecast.filter((e) => e.kind === 'peak').map((e) => `${e.t.slice(5, 16).replace('T', ' ')} ${e.h}`).join(' | ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
