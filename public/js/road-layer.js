import { LEVELS } from './format.js';

const L = window.L;
const HOTSPOT_DRY = { color: '#ef6c00', weight: 3, opacity: 0.85, dashArray: '6 6' };
const MINOR_THINNER = 1; // px: minor roads draw one pixel lighter than major ones
const HIDDEN_CASING = { weight: 0, opacity: 0 };

function weightFor(zoom) {
  return Math.max(3, Math.min(7, zoom - 9));
}

export class RoadLayer {
  constructor(map, segs, onClick) {
    this.map = map;
    this.segs = segs;
    this.onClick = onClick;
    this.renderer = L.canvas({ tolerance: 6 });
    this.group = L.layerGroup().addTo(map);
    this.layers = new Map();
    this.states = [];
    this.showHotspots = true;
    map.on('zoomend', () => this.states.forEach((st, i) => this.layers.has(i) && this.applyStyle(i, st)));
  }

  update(states) {
    states.forEach((st, i) => {
      const prev = this.states[i];
      if (prev && prev.level === st.level && prev.confirmed === st.confirmed) return;
      this.states[i] = st;
      this.sync(i);
    });
  }

  setShowHotspots(on) {
    this.showHotspots = on;
    this.segs.forEach((s, i) => s.hs && this.states[i] && this.sync(i));
  }

  sync(i) {
    const st = this.states[i];
    const visible = st.level > 0 || (this.showHotspots && Boolean(this.segs[i].hs));
    if (!visible) {
      this.layers.get(i)?.forEach((l) => this.group.removeLayer(l));
      this.layers.delete(i);
      return;
    }
    if (!this.layers.has(i)) {
      const make = () => L.polyline(this.segs[i].c, { renderer: this.renderer })
        .on('click', (e) => this.onClick(i, e.latlng))
        .addTo(this.group);
      this.layers.set(i, [make(), make()]);
    }
    this.applyStyle(i, st);
  }

  applyStyle(i, st) {
    const [casing, line] = this.layers.get(i);
    if (st.level === 0) {
      casing.setStyle(HIDDEN_CASING);
      line.setStyle(this.segs[i].minor ? { ...HOTSPOT_DRY, weight: HOTSPOT_DRY.weight - MINOR_THINNER } : HOTSPOT_DRY);
      return;
    }
    const w = weightFor(this.map.getZoom()) - (this.segs[i].minor ? MINOR_THINNER : 0);
    const solid = st.confirmed;
    // Crowd-confirmed: thick white casing + heavier line, so it reads apart from the forecast.
    casing.setStyle(solid
      ? { color: '#fff', weight: w + 6, opacity: 1, dashArray: null }
      : { color: '#1a237e', weight: w + 2, opacity: 0.4, dashArray: null });
    line.setStyle({ color: LEVELS[st.level].color, weight: solid ? w + 2 : w, opacity: solid ? 1 : 0.75, dashArray: null });
  }
}
