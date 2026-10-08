// §17 crowd clusters (pure): reports + news → points → greedy density groups → hot / weak / chronic.
import { distanceM } from './geo.js';
import { observedMs, isDenied, isWithdrawn, reportTtlMs } from './reports.js';
import { NEWS_TTL_MS } from './news-layer.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const CLUSTER_M = 150;
export const MIN_SOURCES = 3;
export const MIN_REPORTS = 2;
export const CHRONIC_DAYS = 90;
export const CHRONIC_MIN_DAYS = 3;

// One point per report (source = its user) and per news article (source = its URL). Level-0 "dry" reports are ignored.
// ttl = how long the point counts towards a live cluster: the report's own TTL (crowd config), NEWS_TTL_MS for articles.
export function toPoints(reports = [], news = [], crowd = {}) {
  const pts = [];
  for (const r of reports) {
    if (!(r.level > 0) || isWithdrawn(r) || isDenied(r)) continue;
    pts.push({ lat: r.lat, lng: r.lng, t: observedMs(r), ttl: reportTtlMs((r.confirms ?? 0) - (r.denies ?? 0), crowd), level: r.level, source: `u:${r.user_id ?? r.id}`, kind: 'report' });
  }
  for (const n of news) {
    const p = n.geometry?.point;
    if (!p) continue;
    const t = Date.parse(n.observedAt ?? n.publishedAt);
    for (const s of n.sources ?? [{ url: n.id }]) pts.push({ lat: p[0], lng: p[1], t, ttl: NEWS_TTL_MS, level: n.level, source: `n:${s.url}`, kind: 'news' });
  }
  return pts.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.t));
}

// Greedy: seed = unassigned point with most unassigned neighbours (ties → lowest index); group = its unassigned neighbours.
export function groupPoints(points, radiusM = CLUSTER_M) {
  const n = points.length;
  const nb = points.map((p, i) => {
    const out = [];
    for (let j = 0; j < n; j++) if (distanceM([p.lat, p.lng], [points[j].lat, points[j].lng]) <= radiusM) out.push(j);
    return out;
  });
  const used = new Uint8Array(n);
  const groups = [];
  for (let left = n; left > 0;) {
    let seed = -1, best = -1;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const c = nb[i].reduce((a, j) => a + (used[j] ? 0 : 1), 0);
      if (c > best) { best = c; seed = i; }
    }
    const members = nb[seed].filter((j) => !used[j]);
    members.forEach((j) => { used[j] = 1; });
    left -= members.length;
    groups.push(members.map((j) => points[j]));
  }
  return groups;
}

function summarize(members) {
  const lat = members.reduce((a, p) => a + p.lat, 0) / members.length;
  const lng = members.reduce((a, p) => a + p.lng, 0) / members.length;
  return {
    latlng: [lat, lng],
    sources: new Set(members.map((p) => p.source)).size,
    count: members.length,
    level: Math.max(...members.map((p) => p.level)),
    lastT: Math.max(...members.map((p) => p.t)),
    members,
  };
}

// Points still within their own TTL at t → 'hot' (≥ 3 distinct sources, or any press article — one is enough)
// or 'weak' (≥ 2 reports, fewer sources). Hot first, by sources.
export function crowdClusters(points, t, { radiusM = CLUSTER_M, minSources = MIN_SOURCES, minReports = MIN_REPORTS } = {}) {
  const live = points.filter((p) => p.t <= t && t < p.t + p.ttl);
  return groupPoints(live, radiusM)
    .map(summarize)
    .map((c) => ({ ...c, news: c.members.some((p) => p.kind === 'news') }))
    .filter((c) => c.news || c.count >= minReports)
    .map((c) => ({ ...c, status: c.news || c.sources >= minSources ? 'hot' : 'weak' }))
    .sort((a, b) => (a.status === b.status ? b.sources - a.sources || b.count - a.count : a.status === 'hot' ? -1 : 1));
}

// "2 người · 1 bài báo · 4 lượt" — people and press articles counted separately.
export function sourceLabel(c) {
  const ids = new Set(c.members.map((p) => p.source));
  const press = [...ids].filter((s) => s.startsWith('n:')).length;
  const people = ids.size - press;
  return [people && `${people} người`, press && `${press} bài báo`, `${c.count} lượt`].filter(Boolean).join(' · ');
}

// Local (UTC+7) calendar day.
export const localDay = (ms) => new Date(ms + 7 * HOUR).toISOString().slice(0, 10);

// Groups over the last 90 days with ≥ 3 distinct local days → chronic candidates ("cộng đồng phát hiện").
export function chronicCandidates(points, now, { radiusM = CLUSTER_M, days = CHRONIC_DAYS, minDays = CHRONIC_MIN_DAYS } = {}) {
  const recent = points.filter((p) => p.t <= now && p.t >= now - days * DAY);
  return groupPoints(recent, radiusM)
    .map((m) => ({ ...summarize(m), days: [...new Set(m.map((p) => localDay(p.t)))].sort() }))
    .filter((c) => c.days.length >= minDays)
    .sort((a, b) => b.days.length - a.days.length);
}

// Heat weight = level × 2^(−age / halfLife); future points weigh 0.
export const heatWeight = (p, t, halfLifeMs) => (p.t > t ? 0 : p.level * 2 ** (-(t - p.t) / halfLifeMs));
export const HEAT_HALF_LIFE = { live: 3 * HOUR, history: 30 * DAY };
