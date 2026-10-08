const L = window.L;
const API = 'https://api.rainviewer.com/public/weather-maps.json';
const WINDOW_MS = 2 * 3600_000;
const MATCH_MS = 30 * 60_000;

export class Radar {
  constructor(map) {
    this.map = map;
    this.enabled = false;
    this.frames = null;
    this.layer = null;
    this.path = null;
  }

  async setEnabled(on, t) {
    this.enabled = on;
    if (on && !this.frames) {
      const res = await fetch(API);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      this.host = json.host;
      this.frames = json.radar.past.map((f) => ({ ms: f.time * 1000, path: f.path }));
    }
    return this.show(t);
  }

  // Returns a short note when no frame covers t, otherwise null.
  show(t) {
    if (!this.enabled || !this.frames?.length) return this.hide(null);
    const latest = this.frames[this.frames.length - 1].ms;
    if (t < latest - WINDOW_MS || t > latest + MATCH_MS) return this.hide('Radar chỉ có trong 2 giờ qua');
    const frame = this.frames.reduce((a, b) => (Math.abs(b.ms - t) < Math.abs(a.ms - t) ? b : a));
    if (frame.path !== this.path) {
      this.layer?.remove();
      this.layer = L.tileLayer(`${this.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
        maxNativeZoom: 7, maxZoom: 19, opacity: 0.6, attribution: 'Radar © RainViewer',
      }).addTo(this.map);
      this.path = frame.path;
    }
    return null;
  }

  hide(note) {
    this.layer?.remove();
    this.layer = null;
    this.path = null;
    return note;
  }
}
