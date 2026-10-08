import { pointToPathM } from './geo.js';
import { cellLevel } from './cells.js';

export const ANALOG_RADIUS_M = 60; // matches INFLUENCE_M
export const ANALOG_AREA_M = 500;
export const LEVEL_THRESHOLDS = [0.25, 0.5, 0.75];

export function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function axisPos(axis, v) {
  const n = axis.length;
  const f = ((v - axis[0]) / (axis[n - 1] - axis[0])) * (n - 1);
  const clamped = Math.min(n - 1, Math.max(0, f));
  const i = Math.min(n - 2, Math.floor(clamped));
  return [i, clamped - i];
}

export function bilinear(grid, values, lat, lng) {
  const [r, fy] = axisPos(grid.lats, lat);
  const [c, fx] = axisPos(grid.lngs, lng);
  const at = (rr, cc) => values[rr * grid.cols + cc];
  const south = at(r, c) * (1 - fx) + at(r, c + 1) * fx;
  const north = at(r + 1, c) * (1 - fx) + at(r + 1, c + 1) * fx;
  return south * (1 - fy) + north * fy;
}

export function rainAt(weather, [lat, lng], ti) {
  const values = weather.precip[ti];
  return values ? bilinear(weather.grid, values, lat, lng) : 0;
}

export function weightedR3(p0, p1, p2) {
  return p0 + 0.6 * p1 + 0.3 * p2;
}

export function rain3h(weather, mid, ti) {
  return weightedR3(rainAt(weather, mid, ti), rainAt(weather, mid, ti - 1), rainAt(weather, mid, ti - 2));
}

export function phuAnAt(weather, ti) {
  return weather.pa?.[ti] ?? null;
}

export function levelOf(risk) {
  return LEVEL_THRESHOLDS.filter((th) => risk >= th).length;
}

// Hotspot segments get HOTSPOT_S for their cause; everything else a flat rain base and no tide term.
export function susceptibility(hotspot, model) {
  const cause = hotspot?.cause;
  const sRain = cause === 'rain' || cause === 'both' ? model.HOTSPOT_S : model.S_RAIN_BASE;
  const sTide = cause === 'tide' || cause === 'both' ? model.HOTSPOT_S : 0;
  return { sRain, sTide };
}

export function segmentRisk(mid, hotspot, weather, ti, model, analogs = []) {
  const R3 = rain3h(weather, mid, ti);
  const pa = phuAnAt(weather, ti);
  const rainF = smoothstep(model.RAIN_START, model.RAIN_FULL, R3);
  const tideF = pa == null ? 0 : smoothstep(model.TIDE_START, model.TIDE_FULL, pa);
  const s = susceptibility(hotspot, model);
  const rainRisk = s.sRain * rainF;
  const tideRisk = s.sTide * tideF;
  const risk = Math.max(rainRisk, tideRisk);
  const hit = bestAnalog(analogs, R3, pa, model);
  const heuristic = levelOf(risk);
  const byAnalog = hit && hit.level > heuristic;
  return {
    risk,
    level: byAnalog ? hit.level : heuristic,
    cause: byAnalog ? hit.cause : tideRisk > rainRisk ? 'tide' : 'rain',
    reason: { R3, pa, hotspot: hotspot ?? null, analog: hit },
  };
}

// analogs = §18 history cells (cells.js prepareCell); the strongest firing one wins.
function bestAnalog(analogs, R3, pa, model) {
  const hits = analogs.map((analog) => ({ analog, ...cellLevel(analog, R3, pa, model) })).filter((h) => h.level > 0);
  if (!hits.length) return null;
  const best = hits.reduce((a, b) => (b.level > a.level ? b : a));
  return { ...best, count: hits.length };
}

// Analogs within ANALOG_RADIUS_M of each segment i ≥ from, measured from the cell's actual event
// locations (the cell centre can sit ~75 m off the reported street, more than the radius).
export function segmentAnalogs(analogs, segs, index, from = 0) {
  const out = new Map();
  for (const a of analogs) {
    const pts = a.events?.length ? a.events.map((e) => [e.lat, e.lng]) : [[a.lat, a.lng]];
    const hit = new Set();
    for (const p of pts) {
      for (const i of index.near(p[0], p[1])) {
        if (i >= from && !hit.has(i) && pointToPathM(p, segs[i].c) <= ANALOG_RADIUS_M) hit.add(i);
      }
    }
    for (const i of hit) out.set(i, [...(out.get(i) ?? []), a]);
  }
  return out;
}

// Name of the closest segment within ANALOG_AREA_M, for labelling an analog point.
export function nearestRoadName(lat, lng, segs, index) {
  let best = null;
  for (const i of index.near(lat, lng)) {
    const d = pointToPathM([lat, lng], segs[i].c);
    if (d <= ANALOG_AREA_M && segs[i].n && (!best || d < best.d)) best = { d, name: segs[i].n };
  }
  return best?.name ?? '';
}
