import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheKey, enrichWeather, gridPoint, mergeWeather, needsWeather, parseUrlList, recordMs } from '../scripts/lib/news-weather.mjs';
import { newsEvent, withWeather } from '../public/js/news-layer.js';
import { dedupe } from '../scripts/lib/news.mjs';

const hours = (dates) => dates.flatMap((d) => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`));
const rec = (o = {}) => ({ id: 'news-a', level: 2, street: 'X', observedAt: '2026-10-03T14:40:00+07:00', publishedAt: '2026-10-03T16:00:00+07:00', signals: ['dat_bo'], geometry: { lines: [[[10.8, 106.7], [10.8, 106.71]]], point: [10.8123, 106.7061] }, sources: [], ...o });
const TIDE = { observed: [{ t: '2026-10-03T11:00:00+07:00', h: 1.62, kind: 'peak' }, { t: '2026-10-03T17:00:00+07:00', h: -1, kind: 'low' }] };
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });
const rainBody = (precip) => {
  const time = hours(['2026-10-02', '2026-10-03']);
  return { hourly: { time, precipitation: time.map((t) => precip[t.slice(11, 13) + (t.startsWith('2026-10-03') ? '' : 'x')] ?? 0) } };
};

test('pure helpers: hour, grid point, cache key, needsWeather, url list', () => {
  assert.equal(recordMs(rec()), Date.parse('2026-10-03T14:00:00+07:00'));
  assert.equal(recordMs(rec({ observedAt: null })), Date.parse('2026-10-03T16:00:00+07:00'));
  assert.deepEqual(gridPoint([10.8123, 106.7261]), { lat: 10.8, lng: 106.75 });
  assert.equal(cacheKey({ lat: 10.8, lng: 106.75 }, Date.parse('2026-10-03T23:30:00+07:00')), '10.80,106.75:2026-10-03');
  assert.equal(needsWeather(rec()), true);
  assert.equal(needsWeather(rec({ weather: { r3: 1, paPeak: null } })), true);
  assert.equal(needsWeather(rec({ weather: { r3: 1, paPeak: 1.2 } })), false);
  assert.deepEqual(parseUrlList('# month 2025-10\nhttps://a.vn/x\n\n  https://b.vn/y  # note\nhttps://a.vn/x#frag\n'), ['https://a.vn/x', 'https://b.vn/y', 'https://a.vn/x#frag']);
});

test('mergeWeather never downgrades a known part to null', () => {
  const old = { r3: 5, r3Src: 'era5', paPeak: null, paSrc: null };
  assert.deepEqual(mergeWeather(old, null), old);
  assert.deepEqual(mergeWeather(old, { r3: null, r3Src: null, paPeak: 1.5, paSrc: 'tvhn' }), { r3: 5, r3Src: 'era5', paPeak: 1.5, paSrc: 'tvhn' });
  assert.equal(mergeWeather(null, null), null);
});

test('enrichWeather: ERA5 R3 + Phú An peak, cache reused, falls back to historical forecast, backs off on 429', async () => {
  const calls = [];
  const replies = [{ ok: false, status: 429, text: async () => '' }, okJson(rainBody({ 14: 10, 13: 5, 12: 2 }))];
  const fetchFn = async (url) => { calls.push(url); return replies.shift(); };
  const sleeps = [];
  const cache = {};
  const a = rec();
  const b = rec({ id: 'news-b', geometry: { ...rec().geometry, point: [10.81, 106.71] } }); // same 0.05° cell + day → cache
  const stats = await enrichWeather([a, b], { tide: TIDE, cache, fetch: fetchFn, sleep: async (ms) => sleeps.push(ms), log: () => {} });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /archive-api.*latitude=10\.8000&longitude=106\.7000/);
  assert.equal(sleeps[0], 2000);
  assert.equal(a.weather.r3, 13.6);
  assert.equal(a.weather.r3Src, 'era5');
  assert.equal(b.weather.r3, a.weather.r3);
  assert.ok(a.weather.paPeak > 1 && a.weather.paPeak <= 1.62);
  assert.deepEqual([stats.r3, stats.paPeak, stats.requests], [2, 2, 1]);
  assert.ok(cache['10.80,106.70:2026-10-03']);

  // ERA5 not out yet (nulls) → historical forecast; no tide data → paPeak null.
  const empty = rainBody({});
  empty.hourly.precipitation = empty.hourly.precipitation.map(() => null);
  const seq = [okJson(empty), okJson(rainBody({ 14: 4 }))];
  const c = rec({ id: 'news-c' });
  await enrichWeather([c], { tide: null, cache: {}, fetch: async () => seq.shift(), sleep: async () => {}, log: () => {} });
  assert.deepEqual(c.weather, { r3: 4, r3Src: 'historical-forecast', paPeak: null, paSrc: null });

  // Network down → weather stays null, nothing thrown.
  const d = rec({ id: 'news-d' });
  const st = await enrichWeather([d], { fetch: async () => { throw new Error('offline'); }, sleep: async () => {}, log: () => {} });
  assert.equal(d.weather, null);
  assert.equal(st.failed, 1);
});

test('newsEvent uses the record weather (source archive); withWeather keeps it', () => {
  const ev = newsEvent(rec({ weather: { r3: 7.5, r3Src: 'era5', paPeak: 1.65, paSrc: 'tvhn' } }));
  assert.deepEqual([ev.Rh, ev.RhSrc, ev.PAh], [7.5, 'archive', 1.65]);
  const t = Math.floor(Date.parse(ev.t) / 3_600_000) * 3_600_000;
  const weather = { times: [t], rain: [[99]], points: [[10.8, 106.7]], phuAn: [1.2] };
  assert.deepEqual([withWeather(ev, weather).Rh, withWeather(ev, weather).PAh], [7.5, 1.65]);
  const bare = newsEvent(rec());
  assert.deepEqual([bare.Rh, bare.RhSrc, bare.PAh], [null, null, null]);
});

test('dedupe drops weather when the merged record hour moves', () => {
  const a = rec({ weather: { r3: 1, r3Src: 'era5', paPeak: 1, paSrc: 'tvhn' } });
  const [m] = dedupe([a, rec({ id: 'news-z', observedAt: '2026-10-03T12:00:00+07:00', sources: [{ url: 'u2' }] })]);
  assert.equal(m.weather, undefined);
  const [k] = dedupe([a, rec({ id: 'news-z', observedAt: '2026-10-03T18:00:00+07:00', sources: [{ url: 'u2' }] })]);
  assert.equal(k.weather.r3, 1);
});

test('urls file: optional YYYY-MM-DD column sets the publish date', async () => {
  const { parseUrlDates } = await import('../scripts/lib/news-weather.mjs');
  const text = 'https://a.vn/x 2026-08-03\nhttps://b.vn/y\n';
  assert.deepEqual(parseUrlList(text), ['https://a.vn/x', 'https://b.vn/y']);
  assert.deepEqual([...parseUrlDates(text)], [['https://a.vn/x', '2026-08-03']]);
});

test('publishedFrom: meta, JSON-LD, URL-embedded dates; null when none', async () => {
  const { publishedFrom } = await import('../scripts/lib/news.mjs');
  assert.equal(new Date(publishedFrom('<script>{"datePublished": "2026-09-30T08:00:00+07:00"}</script>', 'https://x.vn/a')).toISOString(), '2026-09-30T01:00:00.000Z');
  assert.equal(new Date(publishedFrom('', 'https://dantri.com.vn/thoi-su/a-20261008165058710.htm')).toISOString().slice(0, 10), '2026-10-08');
  assert.equal(publishedFrom('<p>no date</p>', 'https://x.vn/a'), null);
});
