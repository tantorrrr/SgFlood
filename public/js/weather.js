import { phuAnModel, tideParams } from './tide.js';

const GRID_N = 6;
const TIDE_POINT = [10.375, 106.958];
const CACHE_MS = 15 * 60_000;
// §18: 2 past days so the timeline reaches 48 h back (same as late reports).
const COMMON = 'past_days=2&forecast_days=3&timezone=Asia%2FHo_Chi_Minh';
// One extra past day so PA(t) = OM(t − lag) is defined at the start of the timeline.
const MARINE_RANGE = 'past_days=3&forecast_days=3&timezone=Asia%2FHo_Chi_Minh';
const HOUR = 3600_000;

const toEpoch = (local) => Date.parse(`${local}:00+07:00`);

function linspace(a, b, n) {
  return Array.from({ length: n }, (_, i) => +(a + ((b - a) * i) / (n - 1)).toFixed(4));
}

async function getJson(url) {
  try {
    const hit = JSON.parse(sessionStorage.getItem(url));
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  } catch { /* storage unavailable */ }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  try {
    sessionStorage.setItem(url, JSON.stringify({ at: Date.now(), data }));
  } catch { /* quota or disabled */ }
  return data;
}

function rainUrl(lats, lngs) {
  const la = [];
  const lo = [];
  for (const lat of lats) for (const lng of lngs) { la.push(lat); lo.push(lng); }
  return `https://api.open-meteo.com/v1/forecast?latitude=${la.join(',')}&longitude=${lo.join(',')}`
    + `&hourly=precipitation,precipitation_probability&models=ecmwf_ifs&${COMMON}`;
}

export function emptyWeather(bbox, now = Date.now()) {
  const [s, w, n, e] = bbox;
  const start = Math.floor(now / HOUR) * HOUR - 48 * HOUR;
  const times = Array.from({ length: 97 }, (_, i) => start + i * HOUR);
  const grid = { rows: 2, cols: 2, lats: [s, n], lngs: [w, e] };
  const none = times.map(() => null);
  return { times, grid, precip: times.map(() => new Float32Array(4)), sea: none, pa: none, paCorrected: none, tide: tideParams(null, now) };
}

async function loadTideFile() {
  const res = await fetch('data/tide-phuan.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function loadWeather(bbox) {
  const [s, w, n, e] = bbox;
  const lats = linspace(s, n, GRID_N);
  const lngs = linspace(w, e, GRID_N);
  const [rain, tide, tideFile] = await Promise.allSettled([
    getJson(rainUrl(lats, lngs)),
    getJson(`https://marine-api.open-meteo.com/v1/marine?latitude=${TIDE_POINT[0]}&longitude=${TIDE_POINT[1]}&hourly=sea_level_height_msl&${MARINE_RANGE}`),
    loadTideFile(),
  ]);
  if (rain.status === 'rejected') throw rain.reason;

  const cells = rain.value;
  const times = cells[0].hourly.time.map(toEpoch);
  const precip = times.map((_, ti) => Float32Array.from(cells, (c) => c.hourly.precipitation[ti] ?? 0));

  const seaByTime = new Map();
  if (tide.status === 'fulfilled') {
    tide.value.hourly.time.forEach((t, i) => seaByTime.set(toEpoch(t), tide.value.hourly.sea_level_height_msl[i]));
  }
  const params = tideParams(tideFile.status === 'fulfilled' ? tideFile.value : null);
  const model = phuAnModel((t) => seaByTime.get(t) ?? null, params);
  const pa = times.map((t) => model.at(t));
  return {
    times,
    grid: { rows: GRID_N, cols: GRID_N, lats, lngs },
    precip,
    sea: times.map((t) => seaByTime.get(t) ?? null), // Vũng Tàu coast (Open-Meteo, MSL)
    pa: pa.map((p) => p?.h ?? null), // Phú An, Hòn Dấu datum
    paCorrected: pa.map((p) => p?.corrected ?? null),
    tide: params,
    tideOk: tide.status === 'fulfilled',
  };
}
