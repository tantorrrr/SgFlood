// Per-record weather for press events (backfill-safe): rain 3 h (same weighted R3 as the app) at the record's point
// and hour from Open-Meteo (ERA5 archive, else Historical Forecast while ERA5 lags) + peak observed tide level of
// the 3 h before at the point's station (§20a Phú An / Nhà Bè, tide-phuan.json; `paStation`). Lets old articles feed learned thresholds without the 48 h weather window.
// Requests are cached per (point rounded to 0.05°, local date); `fetch` and `sleep` are injected for tests.
import { SOURCES, rainUrl, r3FromHourly } from './enrich.mjs';
import { paPeakBefore, stationFor, stationBlock } from '../../public/js/tide.js';

const HOUR = 3_600_000;
export const GRID = 0.05;
export const PA_LOOKBACK_H = 3;

export const recordMs = (r) => Math.floor(Date.parse(r.observedAt ?? r.publishedAt) / HOUR) * HOUR;
const snap = (v) => Math.round(v / GRID) * GRID;
export const gridPoint = ([lat, lng]) => ({ lat: +snap(lat).toFixed(2), lng: +snap(lng).toFixed(2) });
export const cacheKey = (p, ms) => `${p.lat.toFixed(2)},${p.lng.toFixed(2)}:${new Date(ms + 7 * HOUR).toISOString().slice(0, 10)}`;

const pointStation = (r) => stationFor(r.geometry?.point?.[0], r.geometry?.point?.[1]);
// Rain needs (re)computing: none yet (rain not out yet).
export const needsRain = (r) => !r.weather || r.weather.r3 == null;
// Tide needs (re)computing: missing (bulletin added later) or taken at another station than the point's (§20a:
// every record written before stations existed has no paStation → recomputed once; no network needed).
export const needsTide = (r) => !r.weather || r.weather.paPeak == null || r.weather.paStation !== pointStation(r);
export const needsWeather = (r) => needsRain(r) || needsTide(r);

export function weatherOf(r3Res, paPeak, station = 'PA') {
  if (r3Res?.r3 == null && paPeak == null) return null;
  return { r3: r3Res?.r3 ?? null, r3Src: r3Res?.r3 == null ? null : r3Res.src, paPeak, paSrc: paPeak == null ? null : 'tvhn', paStation: paPeak == null ? null : station };
}

// Keep parts an earlier run got when this run could not (offline, ERA5 gap): never downgrade to null.
export function mergeWeather(old, w) {
  if (!old || !w) return w ?? old ?? null;
  const rain = w.r3 != null ? w : old;
  const pa = w.paPeak != null ? w : old;
  return { r3: rain.r3, r3Src: rain.r3Src, paPeak: pa.paPeak, paSrc: pa.paSrc, paStation: pa.paStation ?? null };
}

async function getJson(fetchFn, url, sleep, log, tries = 5) {
  for (let i = 0; ; i++) {
    const res = await fetchFn(url);
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && i < tries - 1) {
      const wait = 2000 * 2 ** i;
      log(`  open-meteo HTTP ${res.status} → retry in ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    throw new Error(`HTTP ${res.status}`);
  }
}

// Mutates records (sets `weather`) and cache ({key: {src, hourly}}); returns coverage counts.
export async function enrichWeather(records, { tide = null, cache = {}, fetch: fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, gapMs = 300, force = false } = {}) {
  const stats = { pending: 0, r3: 0, paPeak: 0, requests: 0, failed: 0 };
  for (const r of records) {
    const point = r.geometry?.point;
    if (!(force || needsWeather(r)) || !Number.isFinite(point?.[0]) || !Number.isFinite(point?.[1])) continue;
    stats.pending++;
    const station = pointStation(r);
    // A tide value taken at another station (or before §20a) is never kept as a fallback for this one.
    if (r.weather && r.weather.paStation !== station) r.weather = { ...r.weather, paPeak: null, paSrc: null, paStation: null };
    if (!force && !needsRain(r)) { // tide only (§20a station switch / late bulletin): no request
      const paPeak = paPeakBefore(stationBlock(tide, station)?.observed, recordMs(r), PA_LOOKBACK_H);
      r.weather = mergeWeather(r.weather, weatherOf({ r3: r.weather.r3, src: r.weather.r3Src }, paPeak, station));
      continue;
    }
    const t = recordMs(r);
    const p = gridPoint(point);
    const key = cacheKey(p, t);
    let rain = null;
    const hit = cache[key];
    if (hit) rain = { r3: r3FromHourly(hit.hourly, t), src: hit.src };
    else {
      for (const [src, base] of SOURCES) {
        try {
          stats.requests++;
          if (stats.requests > 1) await sleep(gapMs);
          const { hourly } = await getJson(fetchFn, rainUrl(base, p, t), sleep, log);
          const r3 = r3FromHourly(hourly, t);
          if (r3 != null) { cache[key] = { src, hourly: { time: hourly.time, precipitation: hourly.precipitation } }; rain = { r3, src }; break; }
        } catch (err) {
          log(`  weather ${r.id} ${src}: ${err.message}`);
        }
      }
      if (!rain) stats.failed++;
    }
    const paPeak = paPeakBefore(stationBlock(tide, station)?.observed, t, PA_LOOKBACK_H);
    r.weather = mergeWeather(r.weather, weatherOf(rain, paPeak, station));
  }
  for (const r of records) {
    if (r.weather?.r3 != null) stats.r3++;
    if (r.weather?.paPeak != null) stats.paPeak++;
    if (r.weather?.paStation === 'NB') stats.nb = (stats.nb ?? 0) + 1;
  }
  return stats;
}

// One article URL per line; blank lines and `#` comments ignored.
const urlLines = (text) => text.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*/, '').trim()).filter(Boolean);
// One URL per line, `#` comments; an optional second column `YYYY-MM-DD` sets the publish date for pages without one.
export const parseUrlList = (text) => urlLines(text).map((l) => l.split(/\s+/)[0]);
export const parseUrlDates = (text) => new Map(urlLines(text).map((l) => l.split(/\s+/)).filter(([, d]) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '')));
