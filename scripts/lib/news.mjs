// Pure helpers for the daily press scan (§16): RSS parsing, keyword filter, article text,
// mention → §4b geometry → resolved road pieces, dedupe. No network here.
import { createHash } from 'node:crypto';
import { distanceM, midpoint } from '../../public/js/geo.js';
import { normalizeName, resolveGeometry } from './hotspot-geom.mjs';

// Verified 2026-10-08 (HTTP 200, fresh items). Most outlets have no fresh TP.HCM-only feed; VOH 484 = "Tin TP Hồ Chí Minh".
// Người Lao Động's only live feed lags ~1 day behind the site.
export const FEEDS = [
  { outlet: 'VnExpress', url: 'https://vnexpress.net/rss/thoi-su.rss' },
  { outlet: 'Tuổi Trẻ', url: 'https://tuoitre.vn/rss/thoi-su.rss' },
  { outlet: 'Thanh Niên', url: 'https://thanhnien.vn/rss/thoi-su.rss' },
  { outlet: 'VOH', url: 'https://voh.com.vn/rss/484' },
  { outlet: 'SGGP', url: 'https://www.sggp.org.vn/rss/home.rss' },
  { outlet: 'Dân Trí', url: 'https://dantri.com.vn/rss/home.rss' },
  { outlet: 'VietNamNet', url: 'https://vietnamnet.vn/rss/thoi-su.rss' },
  { outlet: 'Người Lao Động', url: 'https://nld.com.vn/rss/home.rss' },
];

const FLOOD_WORDS = ['ngập', 'triều cường', 'mưa lớn', 'dắt bộ', 'chết máy', 'nước dâng'];
const PLACE_WORDS = ['tp.hcm', 'tphcm', 'tp hcm', 'tp. hcm', 'hồ chí minh', 'sài gòn', 'đường', 'phường'];
export const SIGNALS = ['dat_bo', 'chet_may', 'ket_xe', 'sau_30cm'];
export const KEEP_DAYS = 90;
const DAY = 86_400_000;
const DEDUPE_M = 300;
const JUNCTION_RADIUS_M = 120;
const JUNCTION_CROSS_M = 60;
const NEAR_MAX_M = 2000;
const CLOSE_PAIR_M = 30;
const QUOTE_WORDS = 25;
const ARTICLE_MAX_CHARS = 8000;

// Basic entities + the accented vowels Vietnamese feeds write as named entities (&acirc; &otilde; …).
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
for (const v of 'aeiouyAEIOUY') {
  for (const [mark, comb] of Object.entries({ acute: '́', grave: '̀', circ: '̂', tilde: '̃' })) {
    const ch = (v + comb).normalize('NFC');
    if (ch.length === 1) ENTITIES[v + mark] = ch;
  }
}
const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] !== '#' ? (ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m) :String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))));
// Decoded twice: some feeds (Thanh Niên) double-encode, e.g. "&amp;aacute;".
const plainText = (s) =>
  decodeEntities(decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// RSS dates seen: RFC 822 (2- or 4-digit year, "+07"/"+0700"/"+07:00") and Tuổi Trẻ's "10/8/2026 1:38:00 PM" (local, no zone).
export function parseDate(s) {
  const zoned = /([+-]\d{2}(:?\d{2})?|GMT|UTC|Z)$/i.test(s.trim());
  return Date.parse(zoned ? s : `${s} GMT+0700`);
}

export function parseFeed(xml) {
  return [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const tag = (name) => plainText(it.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? '');
    return { title: tag('title'), link: tag('link') || tag('guid'), description: tag('description'), publishedAt: parseDate(tag('pubDate')) };
  });
}

export function isCandidate({ title, description }) {
  const text = `${title} ${description}`.normalize('NFC').toLowerCase();
  return FLOOD_WORDS.some((w) => text.includes(w)) && PLACE_WORDS.some((w) => text.includes(w));
}

// Paragraph text of an article page; scripts/styles/captions dropped, capped to bound LLM input.
export function articleText(html) {
  const body = html.replace(/<(script|style|noscript|figure|figcaption)[\s\S]*?<\/\1>/gi, '');
  const paras = [...body.matchAll(/<p[\s>][\s\S]*?<\/p>/gi)].map(([p]) => plainText(p)).filter((p) => p.length > 30);
  return [...new Set(paras)].join('\n').slice(0, ARTICLE_MAX_CHARS);
}

export const isHeavy = (m) => m.signals.length > 0;
export const levelOf = (m) => (m.signals.includes('sau_30cm') || m.depthCm > 30 ? 3 : 2);
export const clampQuote = (q) => q.split(/\s+/).filter(Boolean).slice(0, QUOTE_WORDS).join(' ');

// Road pieces (roads.json / minor tile `segs`) as ways for hotspot-geom; vertices shared by exact rounded
// coordinates stand in for OSM node ids (pieces of one way and crossing ways share them).
export function buildNetwork(segs) {
  const named = segs.filter((s) => s.n);
  const ways = named.map((s) => ({ name: normalizeName(s.n), nodes: s.c.map((c) => c.join()), coords: s.c }));
  const byName = Map.groupBy(ways, (w) => w.name);
  return { segs: named, waysOf: (name) => byName.get(normalizeName(name)) ?? [] };
}

// The intersection of two streets as the `near` hint; refuses streets that meet in places > 2 km apart
// (the article does not say which one, and guessing paints the wrong road).
function intersectionHint(a, b, waysOf) {
  const coordOf = new Map(waysOf(a).flatMap((w) => w.nodes.map((id, i) => [id, w.coords[i]])));
  const shared = waysOf(b).flatMap((w) => w.nodes.filter((id) => coordOf.has(id)).map((id) => coordOf.get(id)));
  if (shared.length) {
    if (shared.some((p) => distanceM(p, shared[0]) > NEAR_MAX_M)) throw new Error(`${a} × ${b} meet in several places`);
    return shared[0];
  }
  let best = { d: CLOSE_PAIR_M, p: null };
  for (const p of waysOf(a).flatMap((w) => w.coords)) {
    for (const q of waysOf(b).flatMap((w) => w.coords)) {
      const d = distanceM(p, q);
      if (d < best.d) best = { d, p };
    }
  }
  if (!best.p) throw new Error(`no intersection ${a} × ${b}`);
  return best.p;
}

export function mentionGeometry(m, waysOf) {
  if (m.from && m.to) return { type: 'between', street: m.street, from: m.from, to: m.to, near: intersectionHint(m.street, m.from, waysOf) };
  const cross = m.cross ?? m.from ?? m.to;
  if (!cross) throw new Error('no cross street or stretch');
  return { type: 'junction', streets: [m.street, cross], radiusM: JUNCTION_RADIUS_M, crossRadiusM: JUNCTION_CROSS_M, near: intersectionHint(m.street, cross, waysOf) };
}

export function resolveMention(m, { segs, waysOf }, bbox) {
  const g = mentionGeometry(m, waysOf);
  const { names, contains } = resolveGeometry(g, waysOf);
  const lines = segs.filter((s) => names.has(normalizeName(s.n)) && contains(midpoint(s.c), normalizeName(s.n))).map((s) => s.c);
  if (!lines.length) throw new Error('0 road pieces');
  const mids = lines.map(midpoint);
  const centroid = [0, 1].map((k) => mids.reduce((a, p) => a + p[k], 0) / mids.length);
  const point = mids.reduce((a, p) => (distanceM(p, centroid) < distanceM(a, centroid) ? p : a));
  if (point[0] < bbox.s || point[0] > bbox.n || point[1] < bbox.w || point[1] > bbox.e) throw new Error('outside bbox');
  return g.type === 'junction' ? { lines, point, junction: g.streets } : { lines, point };
}

export function toRecord(m, geometry, article) {
  return {
    id: `news-${createHash('sha1').update(`${article.url}|${m.street}|${m.from}|${m.to}|${m.cross}`).digest('hex').slice(0, 12)}`,
    level: levelOf(m),
    cause: m.cause,
    street: m.street,
    observedAt: m.observedAt,
    publishedAt: article.publishedAt,
    signals: m.signals,
    geometry,
    sources: [{ url: article.url, outlet: article.outlet, date: article.publishedAt.slice(0, 10), quote: clampQuote(m.quote) }],
  };
}

const localDay = (r) => Math.floor((Date.parse(r.observedAt ?? r.publishedAt) + 7 * 3_600_000) / DAY);
const earliest = (a, b) => (a && b ? (Date.parse(a) <= Date.parse(b) ? a : b) : (a ?? b));
const junctionKey = (g) => (g.junction ? g.junction.map(normalizeName).sort().join('|') : null);
const pieceKeys = (g) => new Set(g.lines.map((c) => JSON.stringify(c)));

// Same place: the same junction street pair (any order), or points ≤ 300 m apart sharing ≥ 1 road piece.
function overlaps(a, b) {
  const ja = junctionKey(a.geometry);
  if (ja && ja === junctionKey(b.geometry)) return true;
  if (distanceM(a.geometry.point, b.geometry.point) > DEDUPE_M) return false;
  const keys = pieceKeys(a.geometry);
  return b.geometry.lines.some((c) => keys.has(JSON.stringify(c)));
}

// Same place (overlaps) within ±1 local calendar day (observedAt, else publishedAt) → one record: earliest
// non-null observedAt, union of signals, max level, all sources. Earlier records keep their id and geometry.
export function dedupe(records) {
  const out = [];
  for (const r of records) {
    const e = out.find((o) => Math.abs(localDay(o) - localDay(r)) <= 1 && overlaps(o, r));
    if (!e) {
      out.push(structuredClone(r));
      continue;
    }
    e.level = Math.max(e.level, r.level);
    e.cause ??= r.cause;
    e.observedAt = earliest(e.observedAt, r.observedAt);
    e.publishedAt = earliest(e.publishedAt, r.publishedAt);
    e.signals = [...new Set([...e.signals, ...r.signals])];
    for (const s of r.sources) if (!e.sources.some((x) => x.url === s.url)) e.sources.push(s);
  }
  return out;
}

export const withinDays = (now, days = KEEP_DAYS) => (r) => Date.parse(r.observedAt ?? r.publishedAt) >= now - days * DAY;
