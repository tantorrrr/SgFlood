// Phú An tide (Hòn Dấu datum) from the Open-Meteo marine curve at the Vũng Tàu coast:
// PA(t) = OM(t − lagH) − bias, then shifted per day so the day's highest hour matches the official forecast peak.
// Pure functions, shared by the browser and scripts/fetch-tide.mjs.

export const HOUR = 3600_000;
export const VN_OFFSET_MS = 7 * HOUR;
export const DEFAULT_TIDE = { lagH: 3, bias: 0.6, alerts: { I: 1.4, II: 1.5, III: 1.6 }, staleDays: 3 };

export const localDay = (ms) => new Date(ms + VN_OFFSET_MS).toISOString().slice(0, 10);
const dayStart = (day) => Date.parse(`${day}T00:00:00+07:00`);

export function alertLevel(h, alerts = DEFAULT_TIDE.alerts) {
  if (h == null) return null;
  return h >= alerts.III ? 'III' : h >= alerts.II ? 'II' : h >= alerts.I ? 'I' : '<I';
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Highest hourly OM value within ±halfH of (t − lagH); null when no data.
export function omPeakNear(omAt, t, lagH, halfH = 2) {
  const centre = Math.round((t - lagH * HOUR) / HOUR) * HOUR;
  let best = null;
  for (let k = -halfH; k <= halfH; k++) {
    const v = omAt(centre + k * HOUR);
    if (v != null && (best == null || v > best)) best = v;
  }
  return best;
}

// bias = median(OM_peak(t − lag) − PA_obs_peak) over observed peaks ≥ minH.
export function computeBias(observed, omAt, { lagH = DEFAULT_TIDE.lagH, minH = 1.0, minN = 3, fallback = DEFAULT_TIDE.bias } = {}) {
  const diffs = [];
  for (const e of observed) {
    if (e.kind !== 'peak' || e.h < minH) continue;
    const om = omPeakNear(omAt, Date.parse(e.t), lagH);
    if (om != null) diffs.push(om - e.h);
  }
  if (diffs.length < minN) return { bias: fallback, n: diffs.length };
  return { bias: Math.round(median(diffs) * 1000) / 1000, n: diffs.length };
}

// Highest official forecast peak per local day.
export function forecastDayPeaks(forecast = []) {
  const out = new Map();
  for (const e of forecast) {
    if (e.kind !== 'peak') continue;
    const day = localDay(Date.parse(e.t));
    out.set(day, Math.max(out.get(day) ?? -Infinity, e.h));
  }
  return out;
}

// Returns paAt(t) → { h, corrected } | null. Day correction needs ≥ minHours of the base curve that day.
export function phuAnModel(omAt, { bias = DEFAULT_TIDE.bias, lagH = DEFAULT_TIDE.lagH, forecast = [] } = {}, minHours = 20) {
  const base = (t) => {
    const v = omAt(t - lagH * HOUR);
    return v == null ? null : v - bias;
  };
  const offsets = new Map();
  for (const [day, peak] of forecastDayPeaks(forecast)) {
    let max = -Infinity;
    let n = 0;
    for (let h = 0; h < 24; h++) {
      const v = base(dayStart(day) + h * HOUR);
      if (v != null) { n++; max = Math.max(max, v); }
    }
    if (n >= minHours) offsets.set(day, peak - max);
  }
  const at = (t) => {
    const b = base(t);
    if (b == null) return null;
    const off = offsets.get(localDay(t));
    return off == null ? { h: b, corrected: false } : { h: b + off, corrected: true };
  };
  return { at, offsets };
}

// Most recent observed peak at or before t (ms), or null.
export function latestPeakBefore(peaks, t) {
  return (peaks ?? []).reduce((a, e) => (Date.parse(e.t) <= t && (!a || Date.parse(e.t) > Date.parse(a.t)) ? e : a), null);
}

// §20a Stations of tide-phuan.json `stations`. Alert marks are the same for both (1.40/1.50/1.60).
export const STATION_NAMES = { PA: 'Phú An', NB: 'Nhà Bè' };
export const STATION_CODES = Object.keys(STATION_NAMES);

// §20a Station by zone, NO interpolation between the two. Nhà Bè covers the south (Q7, Nhà Bè, Q8, Bình Chánh and the
// parts of Q4/Q5/Q6 south of the Tàu Hũ–Bến Nghé canal); everything else Phú An.
// APPROXIMATE boundary (lat < 10.755, or lat < 10.765 west of lng 106.70) — to be refined.
export function stationFor(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 'PA';
  return lat < 10.755 || (lat < 10.765 && lng < 106.70) ? 'NB' : 'PA';
}

// One station's block of tide-phuan.json: `stations[code]`, else the legacy top-level fields (= Phú An) so a file
// written before §20 keeps working (Nhà Bè then falls back to the Phú An curve).
export function stationBlock(json, code = 'PA') {
  return json?.stations?.[code] ?? json?.stations?.PA ?? json;
}

// §20a Lag + bias fit for one station. Lag: for each candidate, residuals OM(t − lag) − obs peak at the exact hour
// (omPeakNear's ±2 h max would blur the timing) over peaks ≥ minH; the smallest median absolute deviation wins
// (ties → the earlier candidate). Bias: computeBias at that lag (same rule as Phú An §10b).
export function fitLagBias(observed, omAt, { lags = [1, 2, 3, 4, 5], minH = 1.0, minN = 3, fallback = DEFAULT_TIDE } = {}) {
  let best = null;
  for (const lagH of lags) {
    const diffs = [];
    for (const e of observed ?? []) {
      if (e.kind !== 'peak' || e.h < minH) continue;
      const om = omAt(Math.round((Date.parse(e.t) - lagH * HOUR) / HOUR) * HOUR);
      if (om != null) diffs.push(om - e.h);
    }
    if (diffs.length < minN) continue;
    const c = median(diffs);
    const mad = Math.round(median(diffs.map((d) => Math.abs(d - c))) * 1000) / 1000;
    if (!best || mad < best.mad) best = { lagH, mad };
  }
  if (!best) return { lagH: fallback.lagH, bias: fallback.bias, n: 0, mad: null };
  const { bias, n } = computeBias(observed, omAt, { lagH: best.lagH, minH, minN, fallback: fallback.bias });
  return { lagH: best.lagH, bias, n, mad: best.mad };
}

// Effective parameters from tide-phuan.json: missing or older than staleDays → default bias, no bulletin.
// `station` picks a §20a block (stationBlock); fetchedAt/alerts stay file-level.
export function tideParams(json, now = Date.now(), defaults = DEFAULT_TIDE, station = 'PA') {
  const fetched = json?.fetchedAt ? Date.parse(json.fetchedAt) : NaN;
  const stale = !(now - fetched <= defaults.staleDays * 24 * HOUR);
  const name = STATION_NAMES[station] ?? STATION_NAMES.PA;
  if (stale) return { station, name, stale, bias: defaults.bias, lagH: defaults.lagH, alerts: defaults.alerts, forecast: [], observedPeaks: [] };
  const b = stationBlock(json, station);
  const peaks = (b.observed ?? []).filter((e) => e.kind === 'peak');
  return {
    station,
    name,
    stale,
    bias: typeof b.bias === 'number' ? b.bias : defaults.bias,
    lagH: b.lagH ?? defaults.lagH,
    alerts: json.alerts ?? defaults.alerts,
    forecast: b.forecast ?? [],
    observedPeaks: peaks,
  };
}

// §19b Observed Phú An level at t (server-side evidence for scripts/lib/enrich.mjs): cosine interpolation between the
// two observed extremes (peaks/lows of tide-phuan.json `observed`) around t; null when t is outside the observed
// record or the extremes are more than maxGapH apart (missing bulletin).
// Peak observed Phú An level over the lookback window before t (streets stay flooded after the peak): a peak/low
// event inside the window counts directly, plus the interpolated levels at both window ends.
export function paPeakBefore(observed, t, lookbackH = 3) {
  const from = t - lookbackH * HOUR;
  const vals = [paObservedAt(observed, from), paObservedAt(observed, t)];
  for (const e of observed ?? []) {
    const et = Date.parse(e.t);
    if (et >= from && et <= t) vals.push(e.h);
  }
  const known = vals.filter((v) => v != null);
  return known.length ? Math.max(...known) : null;
}

export function paObservedAt(observed, t, maxGapH = 9) {
  let a = null;
  let b = null;
  for (const e of observed ?? []) {
    const et = Date.parse(e.t);
    if (et <= t && (!a || et > a.t)) a = { t: et, h: e.h };
    if (et >= t && (!b || et < b.t)) b = { t: et, h: e.h };
  }
  if (!a || !b) return null;
  if (a.t === b.t) return a.h;
  if (b.t - a.t > maxGapH * HOUR) return null;
  const f = (t - a.t) / (b.t - a.t);
  return Math.round((a.h + ((b.h - a.h) * (1 - Math.cos(Math.PI * f))) / 2) * 100) / 100;
}
