import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichReports, r3FromHourly, rainUrl, SOURCES } from '../scripts/lib/enrich.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-08T00:00:00Z');
const hours = (date) => Array.from({ length: 24 }, (_, h) => `${date}T${String(h).padStart(2, '0')}:00`);

test('r3FromHourly: weighted R3 at the observed local hour; null while hours are missing', () => {
  const time = hours('2026-10-03');
  const precipitation = time.map((_, h) => (h === 14 ? 10 : h === 13 ? 5 : h === 12 ? 2 : 0));
  const t = Date.parse('2026-10-03T14:40:00+07:00');
  assert.equal(r3FromHourly({ time, precipitation }, t), 10 + 0.6 * 5 + 0.3 * 2);
  assert.equal(r3FromHourly({ time, precipitation: precipitation.map((v, h) => (h === 13 ? null : v)) }, t), null);
  assert.equal(r3FromHourly({ time, precipitation }, Date.parse('2026-10-03T01:00:00+07:00')), null); // needs t − 2 h
  assert.equal(r3FromHourly(undefined, t), null);
  assert.match(rainUrl(SOURCES[0][1], { lat: 10.78, lng: 106.7 }, t), /start_date=2026-10-02&end_date=2026-10-03/);
});

test('enrichReports: only 2–10 day old, not yet enriched; ERA5 first, Historical Forecast fallback; service-role upsert', async () => {
  const reports = [
    { id: 'a', lat: 10.78, lng: 106.7, observed_at: '2026-10-03T07:40:00Z' }, // 14:40 local
    { id: 'b', lat: 10.79, lng: 106.71, observed_at: '2026-10-04T07:40:00Z' },
    { id: 'c', lat: 10.8, lng: 106.72, observed_at: '2026-10-02T07:40:00Z' },
  ];
  const calls = [];
  const reply = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const hourly = (date, v) => ({ hourly: { time: hours(date), precipitation: hours(date).map(() => v) } });
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('/rest/v1/reports?')) return reply(reports);
    if (url.includes('/rest/v1/report_enrichment?select')) return reply([{ report_id: 'c' }]);
    if (url.includes('/rest/v1/report_enrichment?on_conflict')) return reply(null, 201);
    const date = url.match(/end_date=([\d-]+)/)[1];
    if (url.startsWith(SOURCES[0][1])) return reply(hourly(date, date === '2026-10-03' ? 2 : null)); // ERA5 lags for b
    return reply(hourly(date, 1));
  };
  const tide = { observed: [{ t: '2026-10-03T12:00:00+07:00', h: 1.2 }, { t: '2026-10-03T17:00:00+07:00', h: 1.6 }] };
  const rows = await enrichReports({ url: 'https://x.supabase.co', key: 'service', now: NOW, fetch: fakeFetch, log: () => {}, tide });
  assert.deepEqual(rows.map((r) => [r.report_id, r.r3_obs, r.source]), [['a', 3.8, 'open-meteo era5'], ['b', 1.9, 'open-meteo historical-forecast']]);
  assert.equal(rows[0].pa_obs > 1.2 && rows[0].pa_obs < 1.6, true, 'pa_obs from observed tide at 14:40');
  assert.equal(rows[1].pa_obs, null, 'outside the observed record');
  const list = calls[0].url;
  assert.match(list, new RegExp(`observed_at=gte\.${new Date(NOW - 10 * DAY).toISOString()}`));
  assert.match(list, new RegExp(`observed_at=lte\.${new Date(NOW - 2 * DAY).toISOString()}`));
  assert.match(list, /withdrawn_at=is\.null/);
  const upsert = calls.at(-1);
  assert.equal(upsert.init.method, 'POST');
  assert.equal(upsert.init.headers.Authorization, 'Bearer service');
  assert.match(upsert.init.headers.Prefer, /merge-duplicates/);
  assert.deepEqual(JSON.parse(upsert.init.body).map((r) => r.report_id), ['a', 'b']);
});

test('enrichReports: nothing pending → no Open-Meteo calls, no upsert', async () => {
  const calls = [];
  const fakeFetch = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => [] }; };
  assert.deepEqual(await enrichReports({ url: 'https://x', key: 'k', now: NOW, fetch: fakeFetch, log: () => {} }), []);
  assert.equal(calls.length, 1);
});
