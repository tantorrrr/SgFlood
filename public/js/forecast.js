import { midpoint } from './geo.js';
import { segmentRisk, segmentAnalogs, nearestRoadName, rain3h, phuAnAt } from './risk.js';
import { cellLevel } from './cells.js';
import { cellTrigger } from './format.js';

const CAUSE_TIDE = 1;

// Panel label naming where a history cell's floods come from (§14 crowd report / §17 press).
export const analogTitle = (a) => (a.source === 'news' ? `Điểm từng ngập (báo chí${a.outlet ? `: ${a.outlet}` : ''})` : 'Điểm từng ngập (người dân báo)');

export class Forecast {
  constructor(roads, weather, model, index) {
    this.segs = roads.segs;
    this.hotspots = new Map(roads.hotspots.map((h) => [h.id, h]));
    this.weather = weather;
    this.model = model;
    this.index = index;
    this.mids = [];
    this.setAnalogs([]);
  }

  // analogs = prepared §18 history cells. Recomputes every segment; called again when the history changes.
  setAnalogs(analogs) {
    this.analogs = analogs.map((a) => ({ ...a }));
    this.segAnalogs = new Map();
    this.levels = [];
    this.causes = [];
    this.addSegments(0);
  }

  // Computes levels for segs[from..] only (minor-road tiles appended to the shared segs array and index).
  addSegments(from) {
    for (let i = from; i < this.segs.length; i++) this.mids[i] = midpoint(this.segs[i].c);
    for (const [i, list] of segmentAnalogs(this.analogs, this.segs, this.index, from)) this.segAnalogs.set(i, list);
    for (const a of this.analogs) a.road = nearestRoadName(a.lat, a.lng, this.segs, this.index);
    const T = this.weather.times.length;
    for (let i = from; i < this.segs.length; i++) {
      const levels = new Uint8Array(T);
      const causes = new Uint8Array(T);
      for (let ti = 0; ti < T; ti++) {
        const r = this.detail(ti, i);
        levels[ti] = r.level;
        causes[ti] = r.cause === 'tide' ? CAUSE_TIDE : 0;
      }
      this.levels[i] = levels;
      this.causes[i] = causes;
    }
  }

  level(ti, i) {
    return this.levels[i][ti];
  }

  detail(ti, i) {
    const seg = this.segs[i];
    return segmentRisk(this.mids[i], this.hotspots.get(seg.hs), this.weather, ti, this.model, this.segAnalogs.get(i));
  }

  // Cells firing at their own point at hour ti (drawn even with no road nearby): [{ analog, level, cause, n, m, threshold, srcs }].
  activeAnalogs(ti) {
    return this.analogs.map((analog) => ({ analog, ...this.analogLevelAt(analog, ti) })).filter((h) => h.level > 0);
  }

  analogLevelAt(a, ti) {
    return cellLevel(a, rain3h(this.weather, [a.lat, a.lng], ti), phuAnAt(this.weather, ti), this.model);
  }

  summary(fromTi, toTi) {
    const groups = new Map();
    for (let i = 0; i < this.segs.length; i++) {
      const seg = this.segs[i];
      // Minor roads only show up when they are a hotspot or carry a crowd analog (avoids listing every alley).
      if (seg.minor && !seg.hs && !this.segAnalogs.has(i)) continue;
      let best = null;
      for (let ti = fromTi; ti <= toTi; ti++) {
        const lv = this.levels[i][ti];
        if (lv > 0 && (!best || lv > best.level)) best = { level: lv, ti, tide: this.causes[i][ti] === CAUSE_TIDE };
      }
      if (!best || (!seg.hs && best.level < 2)) continue;
      const key = seg.hs ?? `road:${seg.n}`;
      const g = groups.get(key) ?? {
        key,
        title: seg.hs ? this.hotspots.get(seg.hs).title : seg.n || 'Đường không tên',
        area: seg.hs ? this.hotspots.get(seg.hs).area : '',
        level: 0, peakTi: Infinity, causes: new Set(), segIdx: [],
      };
      g.segIdx.push(i);
      g.causes.add(best.tide ? 'tide' : 'rain');
      if (best.level > g.level || (best.level === g.level && best.ti < g.peakTi)) {
        g.level = best.level;
        g.peakTi = best.ti;
      }
      groups.set(key, g);
    }
    for (const a of this.analogs) {
      let best = null;
      for (let ti = fromTi; ti <= toTi; ti++) {
        const hit = this.analogLevelAt(a, ti);
        if (hit.level > 0 && (!best || hit.level > best.level)) best = { ...hit, ti };
      }
      if (!best) continue;
      groups.set(`analog:${a.id}`, {
        key: `analog:${a.id}`,
        title: analogTitle(a),
        area: `${a.road ? `Gần ${a.road}` : 'Không có đường nào gần đó'} · ${cellTrigger(best)}`,
        level: best.level, peakTi: best.ti, causes: new Set([best.cause]), segIdx: [], latlng: [a.lat, a.lng],
      });
    }
    return [...groups.values()].sort((a, b) => b.level - a.level || a.peakTi - b.peakTi);
  }
}
