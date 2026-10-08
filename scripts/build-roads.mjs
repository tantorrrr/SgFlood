import { readFile, writeFile, stat } from 'node:fs/promises';
import { pathLengthM, midpoint } from '../public/js/geo.js';
import { normalizeName } from './lib/hotspot-geom.mjs';
import { ROOT, BBOX, loadWays, simplify, splitPath, resolveHotspots, matchHotspot, round } from './lib/osm.mjs';

const OUT = new URL('public/data/roads.json', ROOT);
const SIMPLIFY_M = 5;
const PIECE_MAX_M = 400;
const HOTSPOT_PIECE_MAX_M = 100;
const WARN_KM = 2.5;

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

async function main() {
  const hotspots = JSON.parse(await readFile(new URL('data/hotspots.json', ROOT), 'utf8'));

  console.log('Loading OSM ways…');
  const ways = await loadWays(hotspots);
  console.log(`  ${ways.length} ways`);
  const resolved = resolveHotspots(hotspots, ways);
  const hotspotNames = new Set(resolved.flatMap((r) => [...r.names]));

  const segs = [];
  for (const way of ways) {
    const coords = simplify(way.geometry.map((p) => [p.lat, p.lon]), SIMPLIFY_M);
    if (coords.length < 2) continue;
    const name = normalizeName(way.tags.name ?? '');
    for (const piece of splitPath(coords, hotspotNames.has(name) ? HOTSPOT_PIECE_MAX_M : PIECE_MAX_M)) {
      const c = piece.map(([lat, lng]) => [round(lat), round(lng)]);
      const mid = midpoint(c);
      if (mid[0] < BBOX.s || mid[0] > BBOX.n || mid[1] < BBOX.w || mid[1] > BBOX.e) continue;
      const seg = { i: segs.length, n: way.tags.name ?? way.tags.ref ?? '', h: way.tags.highway, c };
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
    segs: segs.map(({ i, n, h, c, hs }) => (hs ? { i, n, h, c, hs } : { i, n, h, c })),
  };
  await writeFile(OUT, JSON.stringify(out));
  const { size } = await stat(OUT);

  console.log(`\nSegments: ${segs.length}  |  roads.json: ${(size / 1024 / 1024).toFixed(2)} MB`);
  report(hotspots, segs);
}

main();
