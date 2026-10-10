import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFeed, isCandidate, articleText, isHeavy, levelOf, clampQuote, buildNetwork, resolveMention, toRecord, dedupe, withinDays } from '../scripts/lib/news.mjs';
import { extractMentions, readMentions, responseFile, costUsd, MODEL } from '../scripts/lib/news-llm.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { distanceM } from '../public/js/geo.js';

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
const LLM_RESPONSE = JSON.parse(fixture('news-llm-response.json'));
const BBOX = { s: 10.66, w: 106.58, n: 10.90, e: 106.84 };
const LAT = 10.8;

// "Lê Văn A" runs east along LAT in 275 m pieces; "Bé" and "Cờ" cross it at 106.705 and 106.715.
const lngs = [106.7, 106.7025, 106.705, 106.7075, 106.71, 106.7125, 106.715, 106.7175, 106.72];
const SEGS = [
  ...lngs.slice(1).map((lng, i) => ({ n: 'Đường Lê Văn A', c: [[LAT, lngs[i]], [LAT, lng]] })),
  { n: 'Bé', c: [[10.799, 106.705], [LAT, 106.705], [10.801, 106.705]] },
  { n: 'Cờ', c: [[10.799, 106.715], [LAT, 106.715], [10.801, 106.715]] },
];
const NET = buildNetwork(SEGS);
// Same two streets in ~55 m pieces around the Lê Văn A × Cờ junction (106.715).
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const steps = (a, b) => Array.from({ length: Math.round((b - a) / 0.0005) }, (_, i) => [r4(a + i * 0.0005), r4(a + (i + 1) * 0.0005)]);
const FINE = buildNetwork([
  ...steps(106.71, 106.72).map(([a, b]) => ({ n: 'Lê Văn A', c: [[LAT, a], [LAT, b]] })),
  ...steps(10.797, 10.803).map(([a, b]) => ({ n: 'Cờ', c: [[a, 106.715], [b, 106.715]] })),
]);
const ARTICLE = { url: 'https://example.vn/a.html', outlet: 'Mẫu', publishedAt: '2026-10-07T18:00:00+07:00' };

const mockFetch = (calls, body = LLM_RESPONSE, status = 200) => async (url, init) => {
  calls.push({ url, init });
  return { ok: status === 200, status, json: async () => body };
};

test('parseFeed handles CDATA, double-encoded entities and the three date styles', () => {
  const items = parseFeed(fixture('news-feed.xml'));
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Mưa lớn, đường Lê Văn A ở TP.HCM ngập sâu');
  assert.equal(items[0].description, 'Nhiều xe chết máy.');
  assert.equal(items[0].publishedAt, Date.parse('2026-10-08T15:39:58+07:00'));
  assert.equal(items[1].title, 'Mưa lớn, nhiều tuyến đường, khu dân cư ở Quảng Ngãi ngập cục bộ');
  assert.equal(items[1].publishedAt, Date.parse('2026-10-08T13:38:00+07:00'));
  assert.equal(items[2].link, 'https://example.vn/c.html');
  assert.equal(items[2].publishedAt, Date.parse('2026-10-07T18:41:51+07:00'));
});

test('isCandidate needs a flood keyword and a place cue', () => {
  const [hcm, other, gold] = parseFeed(fixture('news-feed.xml'));
  assert.equal(isCandidate(hcm), true);
  assert.equal(isCandidate(other), true); // "tuyến đường" — the LLM drops non-HCMC places
  assert.equal(isCandidate(gold), false);
  assert.equal(isCandidate({ title: 'Ngập ở Đà Lạt', description: '' }), false);
});

test('articleText keeps body paragraphs only', () => {
  const text = articleText(fixture('news-article.html'));
  assert.equal(text.split('\n').length, 2);
  assert.match(text, /ngập sâu khoảng 40 cm/);
  assert.match(text, /dắt bộ "bì bõm"/);
  assert.doesNotMatch(text, /Chú thích|không phải nội dung/);
});

test('extractMentions sends only the article text with a JSON schema and returns mentions + usage', async () => {
  const calls = [];
  const { mentions, usage } = await extractMentions({ text: 'Bài mẫu', publishedAt: ARTICLE.publishedAt }, { apiKey: 'test-key', fetchImpl: mockFetch(calls) });
  assert.equal(mentions.length, 4);
  assert.equal(usage.input_tokens, 1200);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, MODEL);
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.deepEqual(body.messages, [{ role: 'user', content: `Ngày đăng: ${ARTICLE.publishedAt}\n\nBài mẫu` }]);
  assert.equal(calls[0].init.headers['x-api-key'], 'test-key');
});

test('extractMentions surfaces API errors without the key', async () => {
  const err = await extractMentions({ text: 'x', publishedAt: '' }, { apiKey: 'secret-key', fetchImpl: mockFetch([], { error: { message: 'overloaded' } }, 529) }).catch((e) => e);
  assert.match(err.message, /529: overloaded/);
  assert.doesNotMatch(err.message, /secret-key/);
});

test('heavy filter and level: any signal kept; level 3 on sau_30cm or depth > 30', () => {
  assert.equal(isHeavy({ signals: [] }), false);
  assert.equal(levelOf({ signals: ['dat_bo'], depthCm: 40 }), 3);
  assert.equal(levelOf({ signals: ['sau_30cm'], depthCm: null }), 3);
  assert.equal(levelOf({ signals: ['ket_xe'], depthCm: 30 }), 2);
  assert.equal(clampQuote(Array(30).fill('từ').join(' ')).split(' ').length, 25);
});

test('mock article → heavy mentions → between / junction geometry; street-only mention is unresolved', () => {
  const { mentions } = JSON.parse(LLM_RESPONSE.content[0].text);
  const heavy = mentions.filter(isHeavy);
  assert.equal(heavy.length, 3);

  const between = resolveMention(heavy[0], NET, BBOX);
  assert.equal(between.lines.length, 4); // 106.705 → 106.715 only, not the whole street
  assert.ok(between.lines.every((l) => l.every(([, lng]) => lng >= 106.705 && lng <= 106.715)));
  assert.ok(distanceM(between.point, [LAT, 106.71]) < 200);

  const junction = resolveMention(heavy[1], FINE, BBOX);
  assert.deepEqual(junction.junction, ['Lê Văn A', 'Cờ']);
  assert.ok(distanceM(junction.point, [LAT, 106.715]) < 60);

  assert.throws(() => resolveMention(heavy[2], NET, BBOX), /no cross street/);
  assert.throws(() => resolveMention(heavy[0], NET, { s: 0, w: 0, n: 1, e: 1 }), /outside bbox/);
  assert.throws(() => resolveMention({ ...heavy[1], cross: 'Không Có' }, NET, BBOX), /no intersection/);
});

test('junction: 120 m of the flooded (first) street, cross street only within 60 m of the intersection', () => {
  const g = resolveMention({ street: 'Lê Văn A', cross: 'Cờ', signals: ['ket_xe'] }, FINE, BBOX);
  const along = g.lines.filter((c) => c[0][0] === LAT && c[1][0] === LAT);
  const cross = g.lines.filter((c) => c[0][1] === 106.715 && c[1][1] === 106.715);
  assert.equal(along.length, 4); // midpoints at ±27 m, ±82 m
  assert.equal(cross.length, 2); // midpoints at ±27 m; ±82 m are past 60 m
  assert.equal(g.lines.length, 6);
  const swapped = resolveMention({ street: 'Cờ', cross: 'Lê Văn A', signals: ['ket_xe'] }, FINE, BBOX);
  assert.equal(swapped.lines.filter((c) => c[0][1] === 106.715 && c[1][1] === 106.715).length, 4);
});

test('a cross street meeting the street in two far places is refused', () => {
  const loop = buildNetwork([...SEGS, { n: 'Vòng', c: [[10.799, 106.7], [LAT, 106.7], [10.81, 106.71], [LAT, 106.72], [10.799, 106.72]] }]);
  assert.throws(() => resolveMention({ street: 'Lê Văn A', cross: 'Vòng', signals: ['ket_xe'] }, loop, BBOX), /several places/);
});

test('toRecord + dedupe merge same street/day within 300 m and keep all sources', () => {
  const m = JSON.parse(LLM_RESPONSE.content[0].text).mentions[0];
  const a = toRecord(m, resolveMention(m, NET, BBOX), ARTICLE);
  assert.equal(a.level, 3);
  assert.equal(a.sources[0].date, '2026-10-07');
  assert.ok(a.sources[0].quote.split(' ').length <= 25);

  const other = { ...ARTICLE, url: 'https://example.vn/z.html', outlet: 'Khác' };
  const b = toRecord({ ...m, signals: ['ket_xe'], depthCm: null, observedAt: null }, resolveMention(m, NET, BBOX), other);
  const nextDay = { ...b, id: 'x', observedAt: '2026-10-08T07:00:00+07:00' };
  const junctionM = JSON.parse(LLM_RESPONSE.content[0].text).mentions[1];
  const far = toRecord(junctionM, resolveMention(junctionM, NET, BBOX), ARTICLE);

  const twoDays = { ...b, id: 'y', observedAt: '2026-10-09T07:00:00+07:00' };

  const out = dedupe([a, b, nextDay, far, twoDays]);
  assert.equal(out.length, 3); // a + b + nextDay (±1 day) | far junction | twoDays
  assert.deepEqual(out.map((r) => r.id), [a.id, far.id, 'y']);
  assert.equal(out[0].id, a.id);
  assert.deepEqual(out[0].sources.map((s) => s.outlet), ['Mẫu', 'Khác']);
  assert.deepEqual(out[0].signals, ['chet_may', 'dat_bo', 'ket_xe']);
  assert.equal(out[0].level, 3);
  assert.equal(a.sources.length, 1); // inputs untouched
});

test('withinDays drops records older than 90 days', () => {
  const now = Date.parse('2026-10-08T00:00:00Z');
  const keep = withinDays(now);
  assert.equal(keep({ observedAt: null, publishedAt: '2026-07-15T00:00:00+07:00' }), true);
  assert.equal(keep({ observedAt: '2026-07-01T00:00:00+07:00', publishedAt: '2026-10-01T00:00:00+07:00' }), false);
  assert.ok(Math.abs(costUsd({ input: 1e6, output: 1e6 }) - 0.6) < 1e-9);
});

test('readMentions reads <sha1(url)>.json from a directory; missing file → null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-resp-'));
  try {
    assert.match(basename(responseFile(dir, ARTICLE.url)), /^[0-9a-f]{40}\.json$/);
    assert.equal(await readMentions(ARTICLE, dir), null);
    const body = JSON.parse(LLM_RESPONSE.content.find((b) => b.type === 'text').text);
    writeFileSync(responseFile(dir, ARTICLE.url), JSON.stringify(body));
    const { mentions, usage } = await readMentions(ARTICLE, dir);
    assert.deepEqual(mentions, body.mentions);
    assert.deepEqual(usage, { input_tokens: 0, output_tokens: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dedupe real cases: D5×XVNT reported next day without a time; junction pair in either order', () => {
  const at = (street, cross, observedAt, publishedAt, outlet, signals) => toRecord(
    { street, cross, observedAt, signals, cause: 'rain', quote: 'ngập' },
    resolveMention({ street, cross }, FINE, BBOX),
    { url: `https://example.vn/${outlet}.html`, outlet, publishedAt },
  );
  // D5 × XVNT: VnExpress gives 20:00 on the 7th; Thanh Niên publishes 08:37 on the 8th with no time.
  const vne = at('Lê Văn A', 'Cờ', '2026-10-07T20:00:00+07:00', '2026-10-07T19:05:28+07:00', 'VnExpress', ['dat_bo']);
  const tn = at('Lê Văn A', 'Cờ', null, '2026-10-08T08:37:00+07:00', 'Thanh Niên', ['chet_may']);
  // Phan Văn Trị × Phạm Văn Đồng vs Phạm Văn Đồng × Phan Văn Trị: different first street, same pair.
  const pvt = at('Cờ', 'Lê Văn A', null, '2026-10-07T19:05:28+07:00', 'VnExpress2', ['ket_xe']);
  const out = dedupe([tn, vne, pvt]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, tn.id);
  assert.equal(out[0].observedAt, '2026-10-07T20:00:00+07:00'); // earliest non-null
  assert.equal(out[0].publishedAt, '2026-10-07T19:05:28+07:00');
  assert.deepEqual(out[0].signals, ['chet_may', 'dat_bo', 'ket_xe']);
  assert.deepEqual(out[0].sources.map((x) => x.outlet), ['Thanh Niên', 'VnExpress', 'VnExpress2']);
  // Same pair two days apart stays separate.
  assert.equal(dedupe([vne, { ...tn, publishedAt: '2026-10-09T08:37:00+07:00' }]).length, 2);
});

test('nua_banh counts as heavy (level 2); street-only mention reuses the chronic hotspot geometry', async () => {
  const { mentionGeometry } = await import('../scripts/lib/news.mjs');
  assert.equal(isHeavy({ signals: ['nua_banh'] }), true);
  assert.equal(levelOf({ signals: ['nua_banh'], depthCm: null }), 2);
  const g = { type: 'between', street: 'Nguyễn Bình', from: 'A', to: 'B', near: [10.7, 106.7] };
  assert.deepEqual(mentionGeometry({ street: 'Đường Nguyễn Bình', signals: ['nua_banh'] }, () => [], [{ id: 'nb', geometry: g }]), g);
  assert.throws(() => mentionGeometry({ street: 'Khác', signals: ['nua_banh'] }, () => [], [{ id: 'nb', geometry: g }]), /no cross street/);
});
