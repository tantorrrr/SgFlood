import { readFile, writeFile, stat } from 'node:fs/promises';
import { pathLengthM, midpoint } from '../public/js/geo.js';
import { normalizeName } from './lib/hotspot-geom.mjs';
import { loadDtm, minAlong, cropGrid, DTM_DATUM_OFFSET } from './lib/dtm.mjs';
import { ROOT, CACHE, BBOX, HEADERS, loadWays, simplify, splitPath, resolveHotspots, matchHotspot, round } from './lib/osm.mjs';

const OUT = new URL('public/data/roads.json', ROOT);
const DTM_BIN = new URL('public/data/dtm.bin', ROOT);
const DTM_JSON = new URL('public/data/dtm.json', ROOT);
const SIMPLIFY_M = 5;
const PIECE_MAX_M = 400;
const HOTSPOT_PIECE_MAX_M = 100;
const WARN_KM = 2.5;
const Z_SAMPLE_M = 30;
const CHECK_POINTS = [['Nguyễn Hữu Cảnh', 10.789, 106.718, 1.6], ['Bến Thành', 10.772, 106.698, 5.3]];

function report(hotspots, segs) {
  const km = new Map(hotspots.map((h) => [h.id, { pieces: 0, m: 0 }]));
  for (const s of segs) if (s.hs) {
    const k = km.get(s.hs);
    k.pieces++;
    k.m += pathLengthM(s.c);
  }
  console.log(`\n${'id'.padEnd(34)} ${'type'.padEnd(9)} pieces     km`);
  let failed = false;
  for (const h of hotspots) {
    const { pieces, m } = km.get(h.id);
    const len = m / 1000;
    const flag = pieces === 0 ? 'FAIL' : len > (h.maxKm ?? WARN_KM) ? 'WARN' : '';
    failed ||= pieces === 0;
    console.log(`${h.id.padEnd(34)} ${h.geometry.type.padEnd(9)} ${String(pieces).padStart(6)} ${len.toFixed(2).padStart(6)} ${flag}`);
  }
  if (failed) process.exitCode = 1;
}

function terrainReport(segs, dtm) {
  const zs = segs.map((s) => s.z).filter((z) => z != null).sort((a, b) => a - b);
  const q = (p) => zs[Math.min(zs.length - 1, Math.floor(p * zs.length))].toFixed(2);
  console.log(`Segment z (${dtm.datum}, min every ${Z_SAMPLE_M} m): p5 ${q(0.05)}  p50 ${q(0.5)}  p95 ${q(0.95)}  |  null (bridge/no data): ${segs.length - zs.length}`);
  for (const [name, lat, lng, expect] of CHECK_POINTS) console.log(`  check ${name} (${lat}, ${lng}): z ${dtm.at(lat, lng)?.toFixed(2)} m (expected ≈ ${expect})`);
}

async function main() {
  const hotspots = JSON.parse(await readFile(new URL('data/hotspots.json', ROOT), 'utf8'));

  console.log('Loading OSM ways…');
  const ways = await loadWays(hotspots);
  console.log(`  ${ways.length} ways`);
  const resolved = resolveHotspots(hotspots, ways);
  const hotspotNames = new Set(resolved.flatMap((r) => [...r.names]));

  console.log('Loading DTM…');
  const dtm = await loadDtm({ cacheDir: CACHE, headers: HEADERS });

  const segs = [];
  for (const way of ways) {
    const coords = simplify(way.geometry.map((p) => [p.lat, p.lon]), SIMPLIFY_M);
    if (coords.length < 2) continue;
    const name = normalizeName(way.tags.name ?? '');
    for (const piece of splitPath(coords, hotspotNames.has(name) ? HOTSPOT_PIECE_MAX_M : PIECE_MAX_M)) {
      const c = piece.map(([lat, lng]) => [round(lat), round(lng)]);
      const mid = midpoint(c);
      if (mid[0] < BBOX.s || mid[0] > BBOX.n || mid[1] < BBOX.w || mid[1] > BBOX.e) continue;
      // Bridges sit above the terrain: sampling them would return the river/canal surface.
      const z = way.tags.bridge && way.tags.bridge !== 'no' ? null : minAlong(c, dtm.at, Z_SAMPLE_M);
      const seg = { i: segs.length, n: way.tags.name ?? way.tags.ref ?? '', h: way.tags.highway, c, z };
      const hs = matchHotspot(name, mid, resolved);
      if (hs) seg.hs = hs;
      segs.push(seg);
    }
  }

  const out = {
    v: 1,
    bbox: [BBOX.s, BBOX.w, BBOX.n, BBOX.e],
    builtAt: new Date().toISOString(),
    hotspots,
    dtm: { source: dtm.label, datum: dtm.datum, offset: DTM_DATUM_OFFSET, sampleM: Z_SAMPLE_M, stat: 'min' },
    segs: segs.map(({ i, n, h, c, z, hs }) => (hs ? { i, n, h, c, z, hs } : { i, n, h, c, z })),
  };
  await writeFile(OUT, JSON.stringify(out));
  const { size } = await stat(OUT);

  const grid = cropGrid(dtm, out.bbox);
  await writeFile(DTM_BIN, Buffer.from(grid.data.buffer));
  await writeFile(DTM_JSON, JSON.stringify(grid.meta, null, 2));

  console.log(`\nSegments: ${segs.length}  |  roads.json: ${(size / 1024 / 1024).toFixed(2)} MB  |  dtm.bin: ${grid.meta.width}×${grid.meta.height} = ${(grid.data.byteLength / 1024 / 1024).toFixed(2)} MB`);
  terrainReport(segs, dtm);
  report(hotspots, segs);
}

main();
