// Fetch Phú An + Nhà Bè bulletins (Đài KTTV Nam Bộ) + Open-Meteo marine, fit lag/bias per station, write
// public/data/tide-phuan.json (§20a: `stations.{PA,NB}`; top-level fields = Phú An for clients older than §20).
// Run daily: `npm run fetch:tide`.  `--backfill <from> <to>` (bulletin dates YYYY-MM-DD) walks the RSS archive and merges older observed events.
// `--seed <obs.jsonl>` imports previously parsed observations once.  `--reparse` re-parses every cached bulletin (data/cache/tvhn) offline.
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pdfTextRuns, parseStations, STATIONS, isTvhnTitle, parseFeedItems, isCandidateTitle, tvhnAttachments, firstOffsetAtOrBefore } from './lib/tvhn.mjs';
import { fitLagBias, DEFAULT_TIDE, HOUR } from '../public/js/tide.js';

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
    const items = parseFeedItems(xml);
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

const RATE_MS = 400; // polite pause between requests to kttvnb.vn
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bulletins published in [from, to] (YYYY-MM-DD): page the RSS archive (newest first) by date.
async function discoverRange(from, to) {
  const fromMs = Date.parse(`${from}T00:00:00+07:00`);
  const toMs = Date.parse(`${to}T23:59:59+07:00`);
  const page = async (offset) => { await sleep(RATE_MS); return parseFeedItems(await get(`${FEED}&limitstart=${offset}`)); };
  const start = await firstOffsetAtOrBefore(async (o) => (await page(o))[0]?.date ?? null, toMs, FEED_PAGE);
  const urls = new Map();
  for (let offset = Math.max(0, start - FEED_PAGE); ; offset += FEED_PAGE) {
    const items = await page(offset);
    if (!items.length) break;
    for (const a of items.filter((i) => i.date >= fromMs && i.date <= toMs && isCandidateTitle(i.title))) {
      try {
        await sleep(RATE_MS);
        for (const [ymd, path] of tvhnAttachments(await get(a.link))) urls.set(ymd, `${SITE}/${path}`);
      } catch (err) {
        console.warn(`  article ${a.link}: ${err.message}`);
      }
    }
    if (items.every((i) => i.date < fromMs)) break;
  }
  return [...urls.entries()].sort(([a], [b]) => b.localeCompare(a));
}

async function loadPdf(ymd, url) {
  const file = new URL(`HCMC_TVHN_${ymd}.pdf`, PDF_CACHE);
  if (existsSync(file)) return readFile(file);
  await sleep(RATE_MS);
  const buf = await get(url, 'buffer');
  await mkdir(PDF_CACHE, { recursive: true });
  await writeFile(file, buf);
  return buf;
}

// research obs.jsonl: {obs_date, PA:[[h,"HH:MM"]|null ×2], PA_low:[…×2], NB:[…×2]} → { PA: events, NB: events }
function seedEvents(text) {
  const out = { PA: [], NB: [] };
  for (const line of text.split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    const add = (code, pairs, kind) => (pairs ?? []).filter(Boolean).forEach(([h, clock]) => out[code].push({ t: `${r.obs_date}T${clock}:00+07:00`, h, kind }));
    add('PA', r.PA, 'peak');
    add('PA', r.PA_low, 'low');
    add('NB', r.NB, 'peak');
    add('NB', r.NB_low, 'low');
  }
  return out;
}

// Every cached bulletin as [[yyyymmdd, url]], newest first (offline re-parse; the url is informational).
function cachedBulletins() {
  return readdirSync(PDF_CACHE).map((f) => /^HCMC_TVHN_(\d{8})\.pdf$/.exec(f)?.[1]).filter(Boolean)
    .sort((a, b) => b.localeCompare(a)).map((ymd) => [ymd, `cache:HCMC_TVHN_${ymd}.pdf`]);
}

// Previous observed events of one station (Phú An also from the legacy top-level field).
const prevObserved = (prev, code) => [prev.stations?.[code]?.observed ?? [], code === 'PA' ? prev.observed ?? [] : []];

function mergeEvents(...lists) {
  const map = new Map();
  for (const e of lists.flat(2)) if (e?.t && e.kind) map.set(`${e.t}|${e.kind}`, e);
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
  const seeded = seedIdx > 0 ? seedEvents(await readFile(process.argv[seedIdx + 1], 'utf8')) : { PA: [], NB: [] };
  if (seedIdx > 0) console.log(`Seeded PA ${seeded.PA.length} / NB ${seeded.NB.length} observed events from ${process.argv[seedIdx + 1]}`);

  const reparse = process.argv.includes('--reparse');
  const bf = process.argv.indexOf('--backfill');
  const range = bf > 0 ? process.argv.slice(bf + 1, bf + 3) : null;
  if (range && !range.every((d) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(d))) throw new Error('usage: --backfill <from YYYY-MM-DD> <to YYYY-MM-DD>');
  const offline = reparse && !range;
  console.log(offline ? 'Re-parsing cached bulletins…' : range ? `Discovering bulletins ${range[0]}..${range[1]} (RSS archive)…` : 'Discovering bulletins (RSS listing)…');
  const found = offline ? cachedBulletins() : range ? await discoverRange(...range) : await discoverBulletins();
  console.log(`  ${found.length} bulletin(s)${found.length > 20 ? '' : `: ${found.map(([d]) => d).join(', ')}`}`);

  const parsed = [];
  for (const [ymd, url] of found) {
    const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`;
    try {
      const st = parseStations(pdfTextRuns(await loadPdf(ymd, url)), date);
      for (const [code, r] of Object.entries(st)) if (r.error) console.warn(`  skip ${STATIONS[code]} ${ymd}: ${r.error}`);
      parsed.push({ date, url, st });
    } catch (err) {
      console.warn(`  skip ${url}: ${err.message}`);
    }
  }
  console.log(`  parsed ${Object.keys(STATIONS).map((c) => `${c} ${parsed.filter((p) => !p.st[c].error).length}`).join(' / ')} of ${found.length}`);

  // A backfill / re-parse must not replace the current forecast: only the daily run takes the newest bulletin.
  const latest = range || offline ? null : parsed[0];
  const stations = {};
  for (const code of Object.keys(STATIONS)) {
    const observed = mergeEvents(prevObserved(prev, code), seeded[code], parsed.map((p) => p.st[code].observed ?? []));
    const forecast = latest?.st[code]?.forecast ?? prev.stations?.[code]?.forecast ?? (code === 'PA' ? prev.forecast : null) ?? parsed[0]?.st[code]?.forecast ?? [];
    stations[code] = { name: STATIONS[code], observed, forecast };
  }
  if (!stations.PA.observed.length) throw new Error('no Phú An observations at all');

  const all = Object.values(stations);
  const first = all.map((s) => s.observed[0]?.t.slice(0, 10)).filter(Boolean).sort()[0];
  const lastFc = all.map((s) => s.forecast.at(-1)?.t.slice(0, 10)).filter(Boolean).sort().at(-1) ?? today();
  const omAt = await loadMarine(addDays(first, -1), [lastFc, addDays(today(), 7)].sort()[0]);
  for (const [code, s] of Object.entries(stations)) {
    // Phú An keeps the §10b lag (3 h) and fits only the bias; Nhà Bè fits lag + bias (§20a).
    const fit = fitLagBias(s.observed, omAt, code === 'PA' ? { lags: [DEFAULT_TIDE.lagH] } : {});
    Object.assign(s, { lagH: fit.lagH, bias: fit.bias, biasN: fit.n });
    s.fit = fit;
  }

  const PA = stations.PA;
  const out = {
    fetchedAt: new Date(Date.now() + 7 * HOUR).toISOString().replace(/\.\d+Z$/, '+07:00'),
    source: SOURCE,
    alerts: DEFAULT_TIDE.alerts,
    // Legacy top-level = Phú An (clients older than §20 read only these).
    lagH: PA.lagH,
    bias: PA.bias,
    biasN: PA.biasN,
    observed: PA.observed,
    forecast: PA.forecast,
    bulletins: latest ? parsed.map((p) => p.url) : (prev.bulletins ?? []),
    stations: Object.fromEntries(Object.entries(stations).map(([code, { fit, ...s }]) => [code, s])),
  };
  await writeFile(OUT, JSON.stringify(out));

  for (const s of Object.values(stations)) {
    const peaks = s.observed.filter((e) => e.kind === 'peak');
    const latestPeak = peaks.reduce((a, e) => (!a || Date.parse(e.t) > Date.parse(a.t) ? e : a), null);
    console.log(`\n${s.name}: lag ${s.lagH} h, bias ${s.bias} m (n = ${s.biasN} peaks ≥ 1.0 m, MAD ${s.fit.mad})  |  observed ${s.observed.length} events ${s.observed[0]?.t.slice(0, 10)}..${s.observed.at(-1)?.t.slice(0, 10)}`);
    console.log(`  latest observed peak: ${latestPeak?.h} m @ ${latestPeak?.t}`);
    console.log(`  forecast peaks: ${s.forecast.filter((e) => e.kind === 'peak').map((e) => `${e.t.slice(5, 16).replace('T', ' ')} ${e.h}`).join(' | ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
