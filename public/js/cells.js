// §18 long-term history per ~150 m cell (pure). Reports + press articles → events → cells (same grid as the
// Supabase view `flood_cells`) → per-cell thresholds that replace the per-report analogs of §14.
import { isDenied, isWithdrawn, observedMs } from './reports.js';

export const CELL_DEG = 0.00135; // ~150 m; keep in sync with supabase/schema.sql flood_cells
export const HISTORY_DAYS = 730;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function cellOf(lat, lng) {
  const i = Math.floor(lat / CELL_DEG);
  const j = Math.floor(lng / CELL_DEG);
  return { cell_id: `${i}:${j}`, lat: +((i + 0.5) * CELL_DEG).toFixed(6), lng: +((j + 0.5) * CELL_DEG).toFixed(6) };
}

// Effective rain of an event: the largest of ECMWF R3, GFS R3, radar max mm/h × 1 h and the post-event
// re-analysis R3 (enrich-reports.mjs), with its source. Ties go to obs, radar, gfs, ecmwf (same order as the SQL view).
export function rhEff({ ecmwf = null, gfs = null, radarMmH = null, r3Obs = null }) {
  let best = { Rh: null, src: null };
  for (const [src, v] of [['obs', r3Obs], ['radar', radarMmH], ['gfs', gfs], ['ecmwf', ecmwf]]) {
    if (isNum(v) && (best.Rh == null || v > best.Rh)) best = { Rh: v, src };
  }
  return best;
}

export const num = (v) => (isNum(v) ? v : null);

// Valid report (not withdrawn/denied, has a snapshot) → event; mirrors the report half of flood_cells.
export function reportEvent(r, r3Obs = null) {
  if (!r.snapshot || isWithdrawn(r) || isDenied(r)) return null;
  const s = r.snapshot;
  const radarMmH = num(s.radar?.maxMmH);
  const { Rh, src } = rhEff({ ecmwf: num(s.features?.ecmwf_ifs?.R3), gfs: num(s.features?.gfs_global?.R3), radarMmH, r3Obs });
  return {
    id: r.id, source: 'report', lat: r.lat, lng: r.lng, t: new Date(observedMs(r)).toISOString(), level: r.level,
    net: (r.confirms ?? 0) - (r.denies ?? 0), Rh, RhSrc: src, PAh: num(s.tide?.phuAn), cause: null, radarMmH,
  };
}

// Events → cells, dropping duplicates (same source + id; the first one wins).
export function groupCells(events) {
  const seen = new Set();
  const cells = new Map();
  for (const ev of events) {
    const key = ev && `${ev.source}:${ev.id}`;
    if (!ev || seen.has(key)) continue;
    seen.add(key);
    const c = cellOf(ev.lat, ev.lng);
    if (!cells.has(c.cell_id)) cells.set(c.cell_id, { ...c, events: [] });
    cells.get(c.cell_id).events.push(ev);
  }
  return [...cells.values()];
}

export function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo);
}

// Rain vs tide like §14: high Phú An with little rain → tide; articles keep their own cause ('both' counts as rain).
export const eventCause = (e, model) => (e.cause === 'tide' || (e.cause == null && isNum(e.PAh) && e.PAh >= model.TIDE_START
  && !(e.Rh >= model.ANALOG_RAIN_MIN)) ? 'tide' : 'rain');

function side(floods, dry, key, floor) {
  const fl = floods.filter((e) => isNum(e[key])).sort((a, b) => a[key] - b[key]);
  if (!fl.length) return null;
  return { floods: fl, dry: dry.map((e) => e[key]).filter(isNum), T: Math.max(quantile(fl.map((e) => e[key]), 0.25), floor), key };
}

// Cell with ≥ 1 flood event (level ≥ 1) passing ANALOG_MIN_NET (articles always pass) → thresholds, else null.
export function prepareCell(cell, model, minNet = 0) {
  const events = cell.events.filter((e) => e.net == null || e.net >= minNet);
  const floods = events.filter((e) => e.level >= 1);
  if (!floods.length) return null;
  const dry = events.filter((e) => e.level === 0);
  const latest = floods.reduce((a, b) => (Date.parse(b.t) > Date.parse(a.t) ? b : a));
  const outlets = [...new Set(floods.map((e) => e.outlet).filter(Boolean))];
  return {
    id: cell.cell_id, lat: cell.lat, lng: cell.lng, events, at: Date.parse(latest.t),
    source: floods.some((e) => e.source === 'report') ? 'report' : 'news', outlet: outlets.join(', ') || null,
    rain: side(floods.filter((e) => eventCause(e, model) === 'rain'), dry, 'Rh', model.ANALOG_RAIN_MIN),
    tide: side(floods.filter((e) => eventCause(e, model) === 'tide'), dry, 'PAh', model.TIDE_START),
  };
}

const lowerMedian = (xs) => [...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1];

// One side (rain on Rh, tide on PAh) at forecast value x. reach = x needed for the full level, near = x for level − 1.
function sideLevel(s, x, reach, near) {
  if (!s || x == null || x < near) return null;
  const under = s.floods.filter((e) => e[s.key] <= x);
  let level = under.length ? lowerMedian(under.map((e) => e.level)) : Math.min(...s.floods.map((e) => e.level));
  if (x < reach) level -= 1;
  // Negative samples: more dry events at ≥ x than floods at ≤ x → one level down.
  if (s.dry.filter((v) => v >= x).length > under.length) level -= 1;
  if (level < 1) return null;
  const above = s.floods.filter((e) => e[s.key] >= s.T);
  const srcs = [...new Set(s.floods.map((e) => e.RhSrc).filter(Boolean))];
  const total = s.floods.length;
  return { level, threshold: s.T, n: above.length, m: above.length + s.dry.filter((v) => v >= s.T).length, total, srcs };
}

// Level a cell forecasts for rain R3 / Phú An pa (0 = none). Rain: full from Tcell = max(p25 Rh_eff, ANALOG_RAIN_MIN),
// level − 1 from ANALOG_NEAR_RATIO · Tcell. Tide: from max(p25 PAh, TIDE_START) − ANALOG_TIDE_TOL.
export function cellLevel(c, R3, pa, model) {
  const rain = c.rain && sideLevel(c.rain, R3, c.rain.T, model.ANALOG_NEAR_RATIO * c.rain.T);
  const tideAt = c.tide && c.tide.T - model.ANALOG_TIDE_TOL;
  const tide = c.tide && sideLevel(c.tide, pa, tideAt, tideAt);
  if (!rain && !tide) return { level: 0 };
  return tide && (!rain || tide.level > rain.level) ? { ...tide, cause: 'tide' } : { ...rain, cause: 'rain' };
}
