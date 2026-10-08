const R = 6371000;
const RAD = Math.PI / 180;

export function distanceM([lat1, lng1], [lat2, lng2]) {
  const dLat = (lat2 - lat1) * RAD;
  const dLng = (lng2 - lng1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function pathLengthM(coords) {
  let len = 0;
  for (let i = 1; i < coords.length; i++) len += distanceM(coords[i - 1], coords[i]);
  return len;
}

export function midpoint(coords) {
  const half = pathLengthM(coords) / 2;
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = distanceM(coords[i - 1], coords[i]);
    if (acc + d >= half && d > 0) {
      const f = (half - acc) / d;
      const [a, b] = [coords[i - 1], coords[i]];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    acc += d;
  }
  return coords[0];
}

export function pointToPathM([lat, lng], coords) {
  const kx = Math.cos(lat * RAD) * R * RAD;
  const ky = R * RAD;
  const proj = ([a, b]) => [(b - lng) * kx, (a - lat) * ky];
  let best = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const [x1, y1] = proj(coords[i]);
    if (i === 0 || coords.length === 1) {
      best = Math.min(best, Math.hypot(x1, y1));
      continue;
    }
    const [x0, y0] = proj(coords[i - 1]);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const f = len2 ? Math.max(0, Math.min(1, -(x0 * dx + y0 * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x0 + f * dx, y0 + f * dy));
  }
  return best;
}

export class BucketIndex {
  constructor(cellDeg = 0.005) {
    this.cell = cellDeg;
    this.buckets = new Map();
  }

  key(lat, lng) {
    return `${Math.floor(lat / this.cell)}:${Math.floor(lng / this.cell)}`;
  }

  add(id, coords) {
    const keys = new Set(coords.map(([lat, lng]) => this.key(lat, lng)));
    for (const k of keys) {
      if (!this.buckets.has(k)) this.buckets.set(k, []);
      this.buckets.get(k).push(id);
    }
  }

  near(lat, lng, rings = 1) {
    const r0 = Math.floor(lat / this.cell);
    const c0 = Math.floor(lng / this.cell);
    const out = new Set();
    for (let r = r0 - rings; r <= r0 + rings; r++) {
      for (let c = c0 - rings; c <= c0 + rings; c++) {
        for (const id of this.buckets.get(`${r}:${c}`) ?? []) out.add(id);
      }
    }
    return out;
  }
}
