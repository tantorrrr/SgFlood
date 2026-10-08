// Minor roads (residential/unclassified/…) as lazily loaded tiles: public/data/minor/<tileId>.json + index.json.
// Run after build-roads (reuses its Overpass cache to skip ways already in roads.json and to resolve hotspots).
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { midpoint, pathLengthM } from '../public/js/geo.js';
import { TILE_DEG, tileId, tileBbox, gridTiles } from '../public/js/tiles.js';
import { normalizeName } from './lib/hotspot-geom.mjs';
import { loadDtm, minAlong } from './lib/dtm.mjs';
import { ROOT, CACHE, BBOX, HEADERS, REFRESH, cached, overpassAt, loadWays, simplify, splitPath, resolveHotspots, matchHotspot, round } from './lib/osm.mjs';

const OUT_DIR = new URL('public/data/minor/', ROOT);
const SIMPLIFY_M = 3;
const PIECE_MAX_M = 150;
const HOTSPOT_PIECE_MAX_M = 100;
const Z_SAMPLE_M = 30;
const BLOCK = 3; // output tiles per block side: one Overpass request covers 0.06° × 0.06°
const MAX_STRIKES = 3;
const KEEP_TAGS = ['name', 'ref', 'highway', 'bridge'];
const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const BBOX_ARR = [BBOX.s, BBOX.w, BBOX.n, BBOX.e];

const minorQuery = (b) => `[out:json][timeout:180];(way["highway"~"^(residential|unclassified|living_street)$"](${b});way["highway"~"^(service|pedestrian)$"]["name"](${b}););out geom qt;`;

// Only the tags the build reads; keeps the per-tile caches small.
const slim = (el) => ({ type: 'way', id: el.id, tags: Object.fromEntries(KEEP_TAGS.filter((k) => k in el.tags).map((k) => [k, el.tags[k]])), geometry: el.geometry });

// Uncached output tiles grouped into BLOCK×BLOCK blocks, one Overpass request each.
function pendingBlocks(tiles) {
  const blocks = new Map();
  for (const id of tiles) {
    if (!REFRESH && existsSync(new URL(`minor-${id}.json`, CACHE))) continue;
    const [r, c] = id.split('-').map(Number);
    const key = `${Math.floor(r / BLOCK)}-${Math.floor(c / BLOCK)}`;
    blocks.set(key, [...(blocks.get(key) ?? []), id]);
  }
  return [...blocks.values()];
}

// Splits a block response into per-tile caches (same file layout as one request per tile). Each way goes to
// the pending tile of its first node inside the block; segments are re-assigned by midpoint at output time.
async function writeBlock(ids, elements) {
  const out = new Map(ids.map((id) => [id, []]));
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry) continue;
    const id = el.geometry.map((p) => tileId(BBOX_ARR, p.lat, p.lon)).find((t) => out.has(t)) ?? ids[0];
    out.get(id).push(slim(el));
  }
  await mkdir(CACHE, { recursive: true });
  for (const [id, elements] of out) await writeFile(new URL(`minor-${id}.json`, CACHE), JSON.stringify({ elements }));
}

async function fetchBlocks(blocks) {
  const queue = [...blocks];
  let done = 0; // blocks fetched (a split block counts once per tile)
  // One request at a time per endpoint; an endpoint that keeps failing is retired and its block requeued.
  const worker = async (endpoint) => {
    let strikes = 0;
    for (let ids; strikes < MAX_STRIKES && (ids = queue.shift());) {
      const bboxes = ids.map((id) => tileBbox(BBOX_ARR, id));
      const b = [Math.min(...bboxes.map((x) => x[0])), Math.min(...bboxes.map((x) => x[1])), Math.max(...bboxes.map((x) => x[2])), Math.max(...bboxes.map((x) => x[3]))];
      try {
        const json = await overpassAt(endpoint, minorQuery(b.join(',')), `minor block ${ids[0]}…${ids.at(-1)}`);
        await writeBlock(ids, json.elements);
        strikes = 0;
        console.log(`  block ${ids[0]}…${ids.at(-1)} (${ids.length} tiles) via ${new URL(endpoint).host}: ${json.elements.length} ways  [${++done}/${blocks.length}]`);
      } catch (err) {
        console.warn(`  ${err.message}`);
        strikes++;
        // A failing block is retried tile by tile, so one bad tile cannot hold back its neighbours.
        if (ids.length > 1) queue.push(...ids.map((id) => [id]));
        else queue.push(ids);
        if (strikes >= MAX_STRIKES) console.warn(`  retiring ${new URL(endpoint).host}`);
      }
    }
  };
  await Promise.all(OVERPASS_ENDPOINTS.map(worker));
  return queue.flat(); // left over once every endpoint is retired
}

async function loadMinorWays(skipIds) {
  const tiles = gridTiles(BBOX_ARR);
  const blocks = pendingBlocks(tiles);
  const t0 = Date.now();
  const failed = blocks.length ? await fetchBlocks(blocks) : [];
  if (blocks.length) console.log(`  fetched ${blocks.length} blocks in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  const ways = new Map();
  for (const id of tiles) {
    if (failed.includes(id)) continue;
    const json = await cached(`minor-${id}.json`, () => { throw new Error(`missing cache for ${id}`); });
    for (const el of json.elements) if (el.type === 'way' && el.geometry && !skipIds.has(el.id)) ways.set(el.id, el);
  }
  return { ways: [...ways.values()], failed, tiles: tiles.length };
}

async function main() {
  const hotspots = JSON.parse(await readFile(new URL('data/hotspots.json', ROOT), 'utf8'));
  console.log('Loading major OSM ways (cache of build-roads)…');
  const major = await loadWays(hotspots);
  // Hotspots resolve on the major ways only, so minor roads add pieces without moving their endpoints.
  const resolved = resolveHotspots(hotspots, major);
  const hotspotNames = new Set(resolved.flatMap((r) => [...r.names]));

  console.log('Loading minor roads per tile…');
  const { ways, failed, tiles } = await loadMinorWays(new Set(major.map((w) => w.id)));
  if (failed.length) {
    console.error(`\n${failed.length}/${tiles} tiles failed: ${failed.join(' ')}\nRe-run to fetch only the missing tiles.`);
    process.exit(1);
  }
  console.log(`  ${ways.length} minor ways`);

  console.log('Loading DTM…');
  const dtm = await loadDtm({ cacheDir: CACHE, headers: HEADERS });

  const byTile = new Map();
  const hsPieces = new Map();
  for (const way of ways) {
    const coords = simplify(way.geometry.map((p) => [p.lat, p.lon]), SIMPLIFY_M);
    if (coords.length < 2) continue;
    const name = normalizeName(way.tags.name ?? '');
    for (const piece of splitPath(coords, hotspotNames.has(name) ? HOTSPOT_PIECE_MAX_M : PIECE_MAX_M)) {
      const c = piece.map(([lat, lng]) => [round(lat), round(lng)]);
      const mid = midpoint(c);
      if (mid[0] < BBOX.s || mid[0] > BBOX.n || mid[1] < BBOX.w || mid[1] > BBOX.e) continue;
      const tile = tileId(BBOX_ARR, mid[0], mid[1]);
      const segs = byTile.get(tile) ?? [];
      const z = way.tags.bridge && way.tags.bridge !== 'no' ? null : minAlong(c, dtm.at, Z_SAMPLE_M);
      const seg = { i: `m${tile}-${segs.length}`, n: way.tags.name ?? way.tags.ref ?? '', h: way.tags.highway, c, z };
      const hs = matchHotspot(name, mid, resolved);
      if (hs) {
        seg.hs = hs;
        hsPieces.set(hs, (hsPieces.get(hs) ?? 0) + pathLengthM(c));
      }
      segs.push(seg);
      byTile.set(tile, segs);
    }
  }

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  const index = [];
  for (const id of gridTiles(BBOX_ARR)) {
    const segs = byTile.get(id);
    if (!segs) continue;
    const body = JSON.stringify({ v: 1, tile: id, segs });
    await writeFile(new URL(`${id}.json`, OUT_DIR), body);
    index.push({ id, bbox: tileBbox(BBOX_ARR, id), segs: segs.length, size: Buffer.byteLength(body) });
  }
  await writeFile(new URL('index.json', OUT_DIR), JSON.stringify({ v: 1, builtAt: new Date().toISOString(), bbox: BBOX_ARR, tileDeg: TILE_DEG, tiles: index }));

  const total = index.reduce((a, t) => a + t.size, 0);
  const segCount = index.reduce((a, t) => a + t.segs, 0);
  const largest = index.reduce((a, t) => (t.size > a.size ? t : a));
  const mb = (b) => (b / 1024 / 1024).toFixed(2);
  console.log(`\nMinor segments: ${segCount} in ${index.length}/${tiles} tiles  |  total ${mb(total)} MB, avg ${(total / index.length / 1024).toFixed(0)} KB, largest ${largest.id} ${(largest.size / 1024).toFixed(0)} KB (${largest.segs} segs)`);
  console.log(`Hotspot pieces added on minor roads: ${hsPieces.size ? [...hsPieces].map(([id, m]) => `${id} ${(m / 1000).toFixed(2)} km`).join(', ') : 'none'}`);
}

main();
