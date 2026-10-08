import { tileId, tilesForView } from './tiles.js';

export const MINOR_MIN_ZOOM = 15;

// Lazily loaded minor-road tiles, appended to the shared segs array + BucketIndex (indices stay stable).
export class MinorRoads {
  constructor(segs, index, onAdded) {
    this.segs = segs;
    this.index = index;
    this.onAdded = onAdded;
    this.available = new Set();
    this.loaded = new Map(); // tile id → Promise
  }

  async init() {
    const meta = await fetch('data/minor/index.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!meta) return;
    this.bbox = meta.bbox;
    meta.tiles.forEach((t) => this.available.add(t.id));
  }

  // [s, w, n, e] view, plus one tile of margin.
  loadView(view) {
    return this.bbox ? this.load(tilesForView(this.bbox, view)) : Promise.resolve();
  }

  loadPoints(points) {
    return this.bbox ? this.load(points.map(([lat, lng]) => tileId(this.bbox, lat, lng))) : Promise.resolve();
  }

  load(ids) {
    const wanted = [...new Set(ids)].filter((id) => this.available.has(id) && !this.loaded.has(id));
    for (const id of wanted) this.loaded.set(id, this.fetchTile(id));
    return Promise.all(wanted.map((id) => this.loaded.get(id)));
  }

  async fetchTile(id) {
    try {
      const { segs } = await fetch(`data/minor/${id}.json`).then((r) => r.json());
      const from = this.segs.length;
      for (const s of segs) {
        s.minor = true;
        this.index.add(this.segs.length, s.c);
        this.segs.push(s);
      }
      this.onAdded(id, from);
    } catch {
      this.loaded.delete(id); // retry on the next request for this tile
    }
  }
}
