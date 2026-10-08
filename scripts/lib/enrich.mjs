// §18 post-event enrichment (logic for scripts/enrich-reports.mjs): for reports 2–10 days old without a
// report_enrichment row, re-read rain at the report's point and hour from Open-Meteo (ERA5 archive, else the
// Historical Forecast API while ERA5 still lags) → r3_obs = same weighted R3 as the app. Talks to Supabase REST
// with the service-role key; `fetch` is injected so tests run on mocks.
import { rainFeatures } from '../../public/js/snapshot.js';

const DAY = 86_400_000;
export const MIN_AGE_DAYS = 2;
export const MAX_AGE_DAYS = 10;
export const SOURCES = [
  ['era5', 'https://archive-api.open-meteo.com/v1/archive'],
  ['historical-forecast', 'https://historical-forecast-api.open-meteo.com/v1/forecast'],
];

const localDate = (ms) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10);

export function rainUrl(base, { lat, lng }, observedMs) {
  return `${base}?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&hourly=precipitation`
    + `&start_date=${localDate(observedMs - DAY)}&end_date=${localDate(observedMs)}&timezone=Asia%2FHo_Chi_Minh`;
}

// R3 at the observed hour, null when the hour or any of its 3 hours is missing (ERA5 not out yet).
export function r3FromHourly(hourly, observedMs) {
  const k = hourly?.time?.findIndex((t) => Date.parse(`${t}:00+07:00`) === Math.floor(observedMs / 3_600_000) * 3_600_000) ?? -1;
  if (k < 2 || [0, 1, 2].some((d) => typeof hourly.precipitation[k - d] !== 'number')) return null;
  return Math.round(rainFeatures(hourly.time, hourly.precipitation, observedMs).R3 * 100) / 100;
}

async function json(fetchFn, url, init) {
  const res = await fetchFn(url, init);
  if (!res.ok) throw new Error(`${url.split('?')[0]}: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

export async function enrichReports({ url, key, now = Date.now(), fetch: fetchFn = fetch, log = console.log }) {
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const from = new Date(now - MAX_AGE_DAYS * DAY).toISOString();
  const to = new Date(now - MIN_AGE_DAYS * DAY).toISOString();
  const reports = await json(fetchFn, `${url}/rest/v1/reports?select=id,lat,lng,observed_at&withdrawn_at=is.null`
    + `&observed_at=gte.${from}&observed_at=lte.${to}&order=observed_at`, { headers });
  const done = reports.length
    ? new Set((await json(fetchFn, `${url}/rest/v1/report_enrichment?select=report_id&report_id=in.(${reports.map((r) => r.id).join(',')})`, { headers })).map((e) => e.report_id))
    : new Set();
  const pending = reports.filter((r) => !done.has(r.id));
  log(`Reports ${MIN_AGE_DAYS}–${MAX_AGE_DAYS} days old: ${reports.length}, already enriched ${done.size}, pending ${pending.length}`);

  const rows = [];
  for (const r of pending) {
    const t = Date.parse(r.observed_at);
    let row = null;
    for (const [source, base] of SOURCES) {
      try {
        const r3 = r3FromHourly((await json(fetchFn, rainUrl(base, r, t))).hourly, t);
        if (r3 != null) { row = { report_id: r.id, r3_obs: r3, source: `open-meteo ${source}`, fetched_at: new Date(now).toISOString() }; break; }
      } catch (err) {
        log(`  ${r.id} ${source}: ${err.message}`);
      }
    }
    if (row) rows.push(row);
    else log(`  ${r.id}: no rain data yet — retry tomorrow`);
  }
  if (rows.length) {
    await json(fetchFn, `${url}/rest/v1/report_enrichment?on_conflict=report_id`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
  }
  log(`Enriched ${rows.length}/${pending.length}`);
  return rows;
}
