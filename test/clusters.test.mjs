import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPoints, groupPoints, crowdClusters, chronicCandidates, heatWeight, localDay } from '../public/js/clusters.js';

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.parse('2026-10-08T10:00:00Z');
const BASE = [10.78, 106.7];
const off = (m) => [BASE[0] + m / 111_320, BASE[1]]; // m metres north
const rep = (id, user, m, ageMs, level = 2, extra = {}) => {
  const [lat, lng] = off(m);
  const iso = new Date(NOW - ageMs).toISOString();
  return { id, user_id: user, lat, lng, level, created_at: iso, observed_at: iso, confirms: 0, denies: 0, ...extra };
};
const news = (id, m, ageMs, urls) => ({
  id, level: 3, observedAt: new Date(NOW - ageMs).toISOString(), publishedAt: new Date(NOW - ageMs).toISOString(),
  geometry: { point: off(m), lines: [] }, sources: urls.map((url) => ({ url, outlet: 'X' })),
});

test('toPoints: one source per user / per article; skips dry, withdrawn, denied', () => {
  const pts = toPoints([
    rep('a', 'u1', 0, H), rep('b', 'u1', 10, H), rep('c', 'u2', 0, H, 0),
    rep('d', 'u3', 0, H, 2, { withdrawn_at: 'x' }), rep('e', 'u4', 0, H, 2, { denies: 2 }),
  ], [news('n1', 0, H, ['https://a', 'https://b'])]);
  assert.deepEqual(pts.map((p) => p.source), ['u:u1', 'u:u1', 'n:https://a', 'n:https://b']);
});

test('groupPoints: density seed, deterministic, all points assigned once', () => {
  const pts = [0, 100, 200, 260, 1000].map((m, i) => ({ ...Object.fromEntries([['lat', off(m)[0]], ['lng', off(m)[1]]]), i }));
  const g = groupPoints(pts, 150);
  assert.deepEqual(g.map((m) => m.map((p) => p.i)), [[0, 1, 2], [3], [4]]);
  assert.deepEqual(groupPoints(pts, 150), g);
});

test('crowdClusters: ≥3 distinct sources in 6h → hot; same user repeated → weak', () => {
  const reports = [rep('a', 'u1', 0, H), rep('b', 'u2', 50, 2 * H), rep('c', 'u3', 80, 5 * H),
    rep('x', 'u9', 2000, H), rep('y', 'u9', 2050, H), rep('old', 'u5', 3000, 7 * H), rep('old2', 'u6', 3000, 8 * H)];
  const cs = crowdClusters(toPoints(reports), NOW);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].status, 'hot');
  assert.equal(cs[0].sources, 3);
  assert.equal(cs[0].count, 3);
  assert.equal(cs[1].status, 'weak');
  assert.equal(cs[1].sources, 1);
  // Viewing 3 h earlier: the 1 h-old report is in the future → not counted.
  assert.equal(crowdClusters(toPoints(reports), NOW - 3 * H)[0]?.status, 'weak');
});

test('§18 hot window = each report TTL (crowd config), not a fixed 6 h', () => {
  const reports = [rep('a', 'u1', 0, 7 * H, 2, { confirms: 2 }), rep('b', 'u2', 50, 7 * H), rep('c', 'u3', 80, H)];
  const [c] = crowdClusters(toPoints(reports), NOW); // a: TTL 8 h → live; b: TTL 6 h → expired
  assert.equal(c.count, 2);
  assert.equal(crowdClusters(toPoints(reports, [], { REPORT_TTL_H: 8 }), NOW)[0].count, 3);
  assert.equal(crowdClusters(toPoints(reports, [], { REPORT_TTL_H: 1, REPORT_TTL_MAX_H: 1 }), NOW).length, 0);
});

test('crowdClusters: news articles count as sources', () => {
  const pts = toPoints([rep('a', 'u1', 0, H)], [news('n', 30, 2 * H, ['https://a', 'https://b'])]);
  const [c] = crowdClusters(pts, NOW);
  assert.equal(c.status, 'hot');
  assert.equal(c.sources, 3);
});

test('chronicCandidates: ≥3 distinct local days within 90 days', () => {
  const reports = [rep('a', 'u1', 0, 1 * D), rep('b', 'u1', 20, 1 * D + H), rep('c', 'u1', 40, 10 * D), rep('d', 'u2', 0, 89 * D),
    rep('e', 'u3', 5000, D), rep('f', 'u3', 5000, 2 * D), rep('g', 'u3', 5000, 95 * D)];
  const cs = chronicCandidates(toPoints(reports), NOW);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].days.length, 3);
  assert.equal(localDay(Date.parse('2026-10-07T18:00:00Z')), '2026-10-08');
});

test('heatWeight: level × half-life decay, zero in the future', () => {
  const p = { level: 2, t: NOW - 3 * H };
  assert.equal(heatWeight(p, NOW, 3 * H), 1);
  assert.equal(heatWeight(p, NOW - 4 * H, 3 * H), 0);
});

test('a single press article makes a hot cluster on its own', () => {
  const t = Date.parse('2026-10-07T13:00:00Z');
  const news = [{ id: 'n1', level: 3, observedAt: new Date(t - 3600_000).toISOString(), geometry: { point: [10.8, 106.7] }, sources: [{ url: 'https://example.invalid/a' }] }];
  const [c] = crowdClusters(toPoints([], news), t);
  assert.equal(c.status, 'hot');
  assert.equal(c.count, 1);
});
