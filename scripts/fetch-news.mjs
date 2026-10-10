// Daily press scan (§16): RSS of HCMC outlets → flood keyword filter (last 24 h) → article text →
// Claude (claude-haiku-5-5) mentions → heavy-only → §4b geometry on roads (+ minor tiles) → dedupe →
// public/data/news-floods.json (+ Supabase `news_reports` when the service-role env is set).
// Run daily: `npm run fetch:news`. Needs env ANTHROPIC_API_KEY for the LLM stage.
// Options: --hours N (RSS window, default 24) · --dump-candidates <dir> (write {url,outlet,publishedAt,text} per
// article as <sha1(url)>.json, then exit) · --llm-responses <dir> (read <sha1(url)>.json instead of calling the API) ·
// --ignore-seen (re-process articles already in the seen-cache; their records replace earlier ones with the same id) ·
// --url <article> (repeatable: process these articles directly instead of scanning RSS, e.g. a link someone shared).
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { BBOX, CACHE, HEADERS, ROOT } from './lib/osm.mjs';
import { FEEDS, parseFeed, isCandidate, articleText, isHeavy, buildNetwork, resolveMention, toRecord, dedupe, withinDays } from './lib/news.mjs';
import { extractMentions, readMentions, responseFile, costUsd, MODEL } from './lib/news-llm.mjs';

const OUT = new URL('public/data/news-floods.json', ROOT);
const ROADS = new URL('public/data/roads.json', ROOT);
const MINOR = new URL('public/data/minor/', ROOT);
const SEEN = new URL('news-seen.json', CACHE);
const { values: OPTS } = parseArgs({ options: { hours: { type: 'string', default: '24' }, 'dump-candidates': { type: 'string' }, 'llm-responses': { type: 'string' }, 'ignore-seen': { type: 'boolean', default: false }, url: { type: 'string', multiple: true } } });
const HOURS = Number(OPTS.hours);
const WINDOW_MS = HOURS * 3_600_000;
const iso = (ms) => new Date(ms + 7 * 3_600_000).toISOString().replace(/\.\d+Z$/, '+07:00');
const readJson = async (url, fallback) => (existsSync(url) ? JSON.parse(await readFile(url, 'utf8')) : fallback);

async function get(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function scanFeeds(seen, now) {
  const byLink = new Map();
  let scanned = 0;
  const results = await Promise.allSettled(FEEDS.map(async (f) => ({ f, items: parseFeed(await get(f.url)) })));
  results.forEach((r, i) => {
    if (r.status === 'rejected') return console.warn(`  ${FEEDS[i].outlet.padEnd(15)} FAIL ${r.reason.message}`);
    const { f, items } = r.value;
    const recent = items.filter((it) => it.publishedAt >= now - WINDOW_MS);
    const hits = recent.filter(isCandidate);
    scanned += recent.length;
    console.log(`  ${f.outlet.padEnd(15)} ${String(items.length).padStart(4)} items, ${String(recent.length).padStart(3)} in ${HOURS} h, ${hits.length} keyword match`);
    for (const it of hits) if (!seen[it.link] && !byLink.has(it.link)) byLink.set(it.link, { ...it, outlet: f.outlet });
  });
  return { scanned, candidates: [...byLink.values()] };
}

// Ad-hoc article: outlet from the host, published time from the page's article meta (fallback: now).
async function directArticle(url, now) {
  const html = await get(url);
  const meta = html.match(/<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|datePublished|pubdate)["'][^>]*content=["']([^"']+)["']/i);
  const published = Date.parse(meta?.[1] ?? '');
  const host = new URL(url).hostname.replace(/^www\./, '');
  return { url, outlet: host, publishedAt: iso(Number.isFinite(published) ? published : now), text: articleText(html) };
}

async function loadNetwork() {
  const segs = [...(await readJson(ROADS)).segs];
  const index = await readJson(new URL('index.json', MINOR), { tiles: [] });
  for (const t of index.tiles) segs.push(...(await readJson(new URL(`${t.id}.json`, MINOR))).segs);
  console.log(`Road network: ${segs.length} pieces (${index.tiles.length} minor tiles)`);
  return { ...buildNetwork(segs), hotspots: await readJson(new URL('data/hotspots.json', ROOT), []) };
}

async function upsertSupabase(records) {
  const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = process.env;
  if (!url || !key) return console.log('Supabase: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set → local file only');
  const rows = records.map((r) => ({
    id: r.id, level: r.level, cause: r.cause, street: r.street, observed_at: r.observedAt, published_at: r.publishedAt,
    signals: r.signals, geometry: r.geometry, sources: r.sources,
  }));
  const res = await fetch(`${url}/rest/v1/news_reports?on_conflict=id`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase upsert: HTTP ${res.status} ${await res.text()}`);
  console.log(`Supabase: upserted ${rows.length} news_reports`);
}

async function main() {
  const now = Date.now();
  const seen = Object.fromEntries(Object.entries(await readJson(SEEN, {})).filter(([, at]) => withinDays(now)({ publishedAt: at })));

  const articles = [];
  const direct = OPTS.url ?? [];
  let scanned = 0;
  let candidates = [];
  if (direct.length) {
    console.log(`Direct article(s): ${direct.length} (RSS scan skipped)`);
    for (const url of direct) {
      try {
        articles.push(await directArticle(url, now));
      } catch (err) {
        console.warn(`  article ${url}: ${err.message}`);
      }
    }
  } else {
    console.log(`Scanning RSS (last ${HOURS} h)…`);
    ({ scanned, candidates } = await scanFeeds(OPTS['ignore-seen'] ? {} : seen, now));
    console.log(`  ${scanned} recent items, ${candidates.length} new keyword candidate(s)`);
    candidates.forEach((c) => console.log(`    [${c.outlet}] ${c.title}`));
  }
  for (const c of candidates) {
    try {
      articles.push({ url: c.link, outlet: c.outlet, publishedAt: iso(c.publishedAt), text: articleText(await get(c.link)) });
    } catch (err) {
      console.warn(`  article ${c.link}: ${err.message}`);
    }
  }
  console.log(`  ${articles.length} article text(s), ${articles.reduce((a, x) => a + x.text.length, 0)} chars`);

  const dumpDir = OPTS['dump-candidates'];
  if (dumpDir) {
    await mkdir(dumpDir, { recursive: true });
    for (const a of articles) await writeFile(responseFile(dumpDir, a.url), JSON.stringify(a, null, 1));
    return console.log(`
Dumped ${articles.length} candidate(s) to ${dumpDir} (no LLM call, nothing else written).`);
  }
  const responsesDir = OPTS['llm-responses'];
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (responsesDir) console.log(`LLM stage: reading responses from ${responsesDir} (no API call)`);
  else if (!apiKey) {
    console.log('\nANTHROPIC_API_KEY is not set → stopping after the RSS/keyword stage (no LLM call, nothing written).');
    return;
  }

  const net = await loadNetwork();
  const usage = { input: 0, output: 0 };
  const records = [];
  let calls = 0;
  let mentions = 0;
  let heavy = 0;
  for (const a of articles) {
    let res;
    try {
      res = responsesDir ? await readMentions(a, responsesDir) : await extractMentions(a, { apiKey });
      if (!res) {
        console.log(`  no response file for ${a.url} → skipped`);
        continue;
      }
    } catch (err) {
      console.warn(`  LLM ${a.url}: ${err.message}`);
      continue;
    }
    calls++;
    usage.input += res.usage.input_tokens;
    usage.output += res.usage.output_tokens;
    seen[a.url] = iso(now);
    mentions += res.mentions.length;
    for (const m of res.mentions.filter(isHeavy)) {
      heavy++;
      try {
        records.push(toRecord(m, resolveMention(m, net, BBOX), a));
      } catch (err) {
        console.warn(`  unresolved "${m.street}" (${[m.from, m.to, m.cross].filter(Boolean).join(' / ') || '—'}) ${a.url}: ${err.message}`);
      }
    }
  }

  const prev = await readJson(OUT, { reports: [] });
  const fresh = new Set(records.map((r) => r.id));
  const reports = dedupe([...prev.reports.filter((r) => !fresh.has(r.id)), ...records]).filter(withinDays(now));
  await writeFile(OUT, JSON.stringify({ fetchedAt: iso(now), model: MODEL, reports }));
  await mkdir(CACHE, { recursive: true });
  await writeFile(SEEN, JSON.stringify(seen));
  await upsertSupabase(reports);

  console.log(`\nscanned ${scanned} | keyword ${candidates.length} | LLM calls ${calls} | mentions ${mentions} | heavy ${heavy} | resolved ${records.length} | file ${reports.length} reports`);
  console.log(`tokens in ${usage.input} / out ${usage.output} → ≈ $${costUsd(usage).toFixed(4)} (${MODEL})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
