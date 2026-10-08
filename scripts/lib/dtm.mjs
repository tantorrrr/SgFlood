// Terrain for the build. The source (FABDEM today) is isolated in SOURCES so it can be swapped
// (e.g. DeltaDTM, CC BY 4.0) without touching segment sampling or the dtm.bin export.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { distanceM } from '../../public/js/geo.js';
import { rasterSampler } from './tiff.mjs';
import { extractRemoteEntry } from './zip-range.mjs';

export const DTM_DATUM_OFFSET = 0.89; // z_HonDau = z_EGM2008 − offset (documented 0.86–0.89, not surveyed)
export const NODATA = -32768;
export const SCALE = 0.01; // dtm.bin stores centimetres

const FABDEM = {
  source: 'fabdem',
  label: 'FABDEM v1-2',
  license: 'CC BY-NC-SA 4.0 (non-commercial)',
  url: 'https://data.bris.ac.uk/datasets/s5hqmjcdj8yo2ibzi9b4ew3sn/N10E100-N20E110_FABDEM_V1-2.zip',
  tile: 'N10E106_FABDEM_V1-2.tif',
  datum: `Hòn Dấu (EGM2008 − ${DTM_DATUM_OFFSET})`,
};

async function loadFabdem(cacheDir, headers, log) {
  const file = new URL(FABDEM.tile, cacheDir);
  if (!existsSync(file)) {
    log(`  downloading ${FABDEM.tile} via HTTP Range…`);
    const data = await extractRemoteEntry(FABDEM.url, (n) => n.endsWith(FABDEM.tile), { headers, log });
    await mkdir(cacheDir, { recursive: true });
    await writeFile(file, data);
  }
  const raster = rasterSampler(await readFile(file));
  const [x0, y0] = raster.meta.origin;
  const [step] = raster.meta.scale;
  return {
    ...FABDEM,
    step,
    // Pixel-centre grid in Hòn Dấu metres.
    pixel: (i, j) => {
      const v = raster.pixel(i, j);
      return v == null ? null : v - DTM_DATUM_OFFSET;
    },
    colOf: raster.colOf,
    rowOf: raster.rowOf,
    lngOf: (i) => x0 + i * step,
    latOf: (j) => y0 - j * raster.meta.scale[1],
  };
}

const SOURCES = { fabdem: loadFabdem };

export async function loadDtm({ source = 'fabdem', cacheDir, headers = {}, log = console.log }) {
  const dtm = await SOURCES[source](cacheDir, headers, log);
  dtm.at = (lat, lng) => dtm.pixel(dtm.colOf(lng), dtm.rowOf(lat));
  return dtm;
}

// Points every ≤ stepM along a polyline (both ends included).
export function samplePath(coords, stepM) {
  const pts = [coords[0]];
  for (let k = 1; k < coords.length; k++) {
    const [a, b] = [coords[k - 1], coords[k]];
    const n = Math.max(1, Math.ceil(distanceM(a, b) / stepM));
    for (let s = 1; s <= n; s++) pts.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
  }
  return pts;
}

// Lowest terrain along the segment: the low point decides where water ponds. null if no data.
export function minAlong(coords, zAt, stepM = 30) {
  let min = Infinity;
  for (const [lat, lng] of samplePath(coords, stepM)) {
    const z = zAt(lat, lng);
    if (z != null && z < min) min = z;
  }
  return min === Infinity ? null : Math.round(min * 100) / 100;
}

// Crop pixel centres inside bbox [s,w,n,e] into an Int16 cm grid, rows north → south.
export function cropGrid(dtm, [s, w, n, e]) {
  const EPS = 1e-9;
  let [iStart, iEnd, jStart, jEnd] = [dtm.colOf(w), dtm.colOf(e), dtm.rowOf(n), dtm.rowOf(s)];
  if (dtm.lngOf(iStart) < w - EPS) iStart++;
  if (dtm.lngOf(iEnd) > e + EPS) iEnd--;
  if (dtm.latOf(jStart) > n + EPS) jStart++;
  if (dtm.latOf(jEnd) < s - EPS) jEnd--;
  const width = iEnd - iStart + 1;
  const height = jEnd - jStart + 1;
  const data = new Int16Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const z = dtm.pixel(iStart + i, jStart + j);
      data[j * width + i] = z == null ? NODATA : Math.max(-32767, Math.min(32767, Math.round(z / SCALE)));
    }
  }
  const round = (x) => Math.round(x * 1e7) / 1e7;
  const meta = {
    v: 1,
    bbox: [s, w, n, e],
    width,
    height,
    step: dtm.step,
    north: round(dtm.latOf(jStart)), // centre of the first row
    west: round(dtm.lngOf(iStart)), // centre of the first column
    scale: SCALE,
    units: 'cm',
    dtype: 'int16le',
    order: 'row-major, north → south',
    nodata: NODATA,
    source: dtm.label,
    license: dtm.license,
    datum: dtm.datum,
    offset: DTM_DATUM_OFFSET,
  };
  return { meta, data };
}
