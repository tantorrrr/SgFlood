import { weightedR3 } from './risk.js';
import { LATE_MS } from './reports.js';
import { loadDtm, dtmValueAt } from './dtm.js';
import { alertLevel, latestPeakBefore } from './tide.js';
import { rgbaToDbz, dbzToMmH } from './radar-rate.js';

const TIMEOUT_MS = 6000;
const MODELS = ['ecmwf_ifs', 'gfs_global'];
const RADAR_Z = 7;
const RADAR_SCHEME = 2;
const TIDE_SOURCE = 'open-meteo-marine@10.375,106.958';
const HOUR = 3600_000;
const RADAR_WINDOW_MS = 2 * HOUR;
const RADAR_LOOKBACK_MS = 60 * 60_000;
// Unsmoothed tiles (smooth 0, snow 0): pixels are exact colour-table entries, so they decode to dBZ.
const RADAR_OPTIONS = '0_0';

const toEpoch = (local) => Date.parse(`${local}:00+07:00`);

export function rainFeatures(times, precip, now) {
  const nowHour = Math.floor(now / HOUR) * HOUR;
  const k = times.findIndex((t) => toEpoch(t) === nowHour);
  if (k < 0) return null;
  const p = (i) => precip[i] ?? 0;
  let p6sum = 0;
  for (let i = Math.max(0, k - 5); i <= k; i++) p6sum += p(i);
  return { p1: p(k), R3: weightedR3(p(k), p(k - 1), p(k - 2)), p6sum };
}

// Hours [t − 6h, t + 3h] around the hour containing t.
export function sliceHours(times, values, t) {
  const k = times.findIndex((x) => toEpoch(x) === Math.floor(t / HOUR) * HOUR);
  if (k < 0) return { time: [], precipitation: [] };
  const [from, to] = [Math.max(0, k - 6), k + 4];
  return { time: times.slice(from, to), precipitation: values.slice(from, to) };
}

// §18: every RainViewer frame (epoch s) in [t − 60 min, t], as long as t is no older than 2h before the newest frame.
export function radarFramesBefore(past, t) {
  if (!past?.length || t < past.at(-1).time * 1000 - RADAR_WINDOW_MS) return [];
  return past.filter((f) => f.time * 1000 <= t && f.time * 1000 >= t - RADAR_LOOKBACK_MS);
}

// Decoded frames → { frames: [{ time, rgba, dBZ, mmH }], maxMmH }.
export function radarRates(frames) {
  const out = frames.map(({ time, rgba }) => {
    const dBZ = rgbaToDbz(rgba);
    return { time, rgba, dBZ, mmH: Math.round(dbzToMmH(dBZ) * 100) / 100 };
  });
  return { frames: out, maxMmH: out.length ? Math.max(...out.map((f) => f.mmH)) : null };
}

async function captureModels(lat, lng, signal, now) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}`
    + `&hourly=precipitation&models=${MODELS.join(',')}&past_days=3&forecast_days=2&timezone=Asia%2FHo_Chi_Minh`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { hourly } = await res.json();
  const models = {};
  const features = {};
  for (const m of MODELS) {
    const precipitation = hourly[`precipitation_${m}`] ?? [];
    models[m] = { hourly: sliceHours(hourly.time, precipitation, now) };
    features[m] = rainFeatures(hourly.time, precipitation, now);
  }
  return { models, features };
}

function loadImage(src, signal) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    signal.addEventListener('abort', () => reject(new Error('aborted')));
    img.src = src;
  });
}

async function captureRadar(lat, lng, signal, t) {
  const res = await fetch('https://api.rainviewer.com/public/weather-maps.json', { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { host, radar } = await res.json();
  const frames = radarFramesBefore(radar.past, t);
  if (!frames.length) throw new Error('out_of_range');
  const n = 2 ** RADAR_Z;
  const gx = ((lng + 180) / 360) * n * 256;
  const latRad = (lat * Math.PI) / 180;
  const gy = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n * 256;
  const [x, y, px, py] = [Math.floor(gx / 256), Math.floor(gy / 256), Math.floor(gx % 256), Math.floor(gy % 256)];
  const canvas = Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imgs = await Promise.all(frames.map((f) => loadImage(`${host}${f.path}/256/${RADAR_Z}/${x}/${y}/${RADAR_SCHEME}/${RADAR_OPTIONS}.png`, signal)));
  const pixels = imgs.map((img, i) => {
    ctx.clearRect(0, 0, 256, 256);
    ctx.drawImage(img, 0, 0);
    return { time: frames[i].time, rgba: [...ctx.getImageData(px, py, 1, 1).data] }; // throws SecurityError if tainted
  });
  const { frames: decoded, maxMmH } = radarRates(pixels);
  const latest = decoded.at(-1);
  return {
    source: 'rainviewer', scheme: RADAR_SCHEME, options: RADAR_OPTIONS, z: RADAR_Z, x, y, px, py,
    frameTime: latest.time, rgba: latest.rgba, frames: decoded, maxMmH,
  };
}

export function tideAt(weather, t) {
  const sea = weather?.sea;
  const idx = weather?.times?.indexOf(Math.floor(t / HOUR) * HOUR) ?? -1;
  if (!sea || idx < 0) return null;
  const tide = weather.tide ?? {};
  const lagH = tide.lagH ?? 3;
  const phuAn = weather.pa?.[idx] ?? null;
  return {
    source: TIDE_SOURCE,
    seaLevel: sea[idx] ?? null,
    seaLevelLagged: sea[idx - lagH] ?? null,
    phuAn: phuAn == null ? null : Math.round(phuAn * 100) / 100,
    phuAnSource: weather.paCorrected?.[idx] ? 'om+3h−bias+bulletin' : 'om+3h−bias',
    bias: tide.bias ?? null,
    alert: alertLevel(phuAn, tide.alerts),
    latestObservedPeak: latestPeakBefore(tide.observedPeaks, t),
  };
}

async function captureTerrain(lat, lng) {
  return { source: 'FABDEM v1-2', datum: 'Hòn Dấu (EGM2008 − 0.89)', z: dtmValueAt(await loadDtm(), lat, lng) };
}

const settle = (p) => p.then((value) => ({ value }), (err) => ({ error: err.message || String(err) }));

// Never rejects and resolves within TIMEOUT_MS; failed sources become null with an error note.
export async function captureSnapshot({ lat, lng }, { weather, observedAt, createdAt = null }) {
  const now = Date.now();
  const t = observedAt ?? now;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const timeout = new Promise((resolve) => ctrl.signal.addEventListener('abort', () => resolve({ error: 'timeout' })));
  const [models, radar, terrain] = await Promise.all([
    Promise.race([settle(captureModels(lat, lng, ctrl.signal, t)), timeout]),
    Promise.race([settle(captureRadar(lat, lng, ctrl.signal, t)), timeout]),
    Promise.race([settle(captureTerrain(lat, lng)), timeout]),
  ]);
  clearTimeout(timer);
  const snap = {
    v: 1,
    capturedAt: new Date(now).toISOString(),
    observedAt: new Date(t).toISOString(),
    late: (createdAt ?? now) - t > LATE_MS,
    timezone: 'Asia/Ho_Chi_Minh',
    lat,
    lng,
    models: models.value?.models ?? null,
    features: models.value?.features ?? null,
    radar: radar.value ?? null,
    tide: tideAt(weather, t),
    terrain: terrain.value ?? { source: 'FABDEM v1-2', datum: 'Hòn Dấu (EGM2008 − 0.89)', z: null },
  };
  if (models.error) snap.modelsError = models.error;
  if (radar.error) snap.radarError = radar.error;
  if (terrain.error) snap.terrainError = terrain.error;
  return snap;
}
