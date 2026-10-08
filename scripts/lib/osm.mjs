// Shared OSM/Overpass plumbing for the road builds (major roads and lazy minor-road tiles).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { distanceM, pathLengthM } from '../../public/js/geo.js';
import { normalizeName, geometryStreets, resolveGeometry } from './hotspot-geom.mjs';

export const ROOT = new URL('../../', import.meta.url);
export const CACHE = new URL('data/cache/', ROOT);
export const BBOX = { s: 10.66, w: 106.58, n: 10.90, e: 106.84 };
export const HEADERS = { 'User-Agent': 'HcmFlood-POC/0.1 (+local dev)' };
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const BACKOFF_MS = [5000, 15000, 30000];
export const REFRESH = process.argv.includes('--refresh');

export async function cached(name, load) {
  const file = new URL(name, CACHE);
  if (!REFRESH && existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  const data = await load();
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, JSON.stringify(data));
  return data;
}

async function fetchJson(url, init, label, backoff = BACKOFF_MS) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return await res.json();
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt >= backoff.length) throw new Error(`${label}: ${err.message}`);
      console.warn(`  ${label} failed (${err.message}), retry in ${backoff[attempt] / 1000}s`);
      await sleep(backoff[attempt]);
    }
  }
}

// One endpoint, with the retry/backoff of fetchJson.
export function overpassAt(endpoint, query, label) {
  const init = {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: query }).toString(),
  };
  return fetchJson(endpoint, init, `${label} @ ${new URL(endpoint).host}`);
}

export async function overpass(query, label) {
  let lastErr;
  for (const endpoint of OVERPASS) {
    try {
      return await overpassAt(endpoint, query, label);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function quadrants({ s, w, n, e }) {
  const midLat = (s + n) / 2;
  const midLng = (w + e) / 2;
  return [
    [s, w, midLat, midLng], [s, midLng, midLat, e],
    [midLat, w, n, midLng], [midLat, midLng, n, e],
  ];
}

export async function loadWays(hotspots) {
  const ways = new Map();
  const add = (json) => json.elements.filter((el) => el.type === 'way' && el.geometry).forEach((el) => ways.set(el.id, el));

  for (const [i, box] of quadrants(BBOX).entries()) {
    const q = `[out:json][timeout:180];way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"](${box.join(',')});out geom;`;
    add(await cached(`overpass-major-${i}.json`, () => overpass(q, `major roads tile ${i}`)));
  }

  const names = [...new Set(hotspots.flatMap((h) => geometryStreets(h.geometry)))];
  add(await cached('overpass-hotspot-names.json', () => overpass(namesQuery(names), 'hotspot street names')));
  const loaded = new Set([...ways.values()].map((w) => normalizeName(w.tags.name ?? '')));
  const missing = names.filter((n) => !loaded.has(normalizeName(n))).sort();
  if (missing.length) {
    const key = createHash('sha1').update(missing.join('|')).digest('hex').slice(0, 10);
    add(await cached(`overpass-names-${key}.json`, () => overpass(namesQuery(missing), `street names: ${missing.join(', ')}`)));
  }
  return [...ways.values()];
}

function namesQuery(names) {
  const regex = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const bbox = [BBOX.s, BBOX.w, BBOX.n, BBOX.e].join(',');
  return `[out:json][timeout:180];way["highway"]["highway"!~"^(footway|path|service|cycleway|steps|pedestrian|track|construction|proposed)$"]["name"~"(${regex})",i](${bbox});out geom;`;
}

export function simplify(coords, tolM) {
  if (coords.length < 3) return coords;
  const lat0 = coords[0][0] * (Math.PI / 180);
  const xy = coords.map(([lat, lng]) => [lng * 111320 * Math.cos(lat0), lat * 110540]);
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - xy[i][1]) - (ax - xy[i][0]) * (by - ay)) / len;
      if (d > maxD) [maxD, idx] = [d, i];
    }
    if (maxD > tolM) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

export function splitPath(coords, maxM) {
  const total = pathLengthM(coords);
  if (total <= maxM * 1.5) return [coords];
  const pieceLen = total / Math.ceil(total / maxM);
  const pieces = [];
  let current = [coords[0]];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    let a = coords[i - 1];
    const b = coords[i];
    let d = distanceM(a, b);
    while (acc + d > pieceLen + 0.01) {
      const f = (pieceLen - acc) / d;
      const cut = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      current.push(cut);
      pieces.push(current);
      current = [cut];
      d -= pieceLen - acc;
      a = cut;
      acc = 0;
    }
    current.push(b);
    acc += d;
  }
  if (current.length > 1 && acc > 1) pieces.push(current);
  else pieces[pieces.length - 1].push(...current.slice(1));
  return pieces;
}

function toWay(el) {
  return { name: normalizeName(el.tags.name ?? ''), nodes: el.nodes, coords: el.geometry.map((p) => [p.lat, p.lon]) };
}

export function resolveHotspots(hotspots, ways) {
  const byName = Map.groupBy(ways.map(toWay), (w) => w.name);
  const waysOf = (name) => byName.get(normalizeName(name)) ?? [];
  const errors = [];
  const resolved = hotspots.map((h) => {
    try {
      return { id: h.id, ...resolveGeometry(h.geometry, waysOf) };
    } catch (err) {
      errors.push(`${h.id}: ${err.message}`);
      return null;
    }
  });
  if (errors.length) {
    console.error(`\nHotspot geometry errors:\n${errors.map((e) => `  ${e}`).join('\n')}`);
    process.exit(1);
  }
  return resolved;
}

export function matchHotspot(name, mid, resolved) {
  return resolved.find((r) => r.names.has(name) && r.contains(mid))?.id;
}


export const round = (x) => Math.round(x * 1e5) / 1e5;
