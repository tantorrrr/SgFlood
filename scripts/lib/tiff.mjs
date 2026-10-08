// Minimal GeoTIFF reader for single-band float32 tiled rasters (FABDEM layout):
// Deflate or none, horizontal predictor 2 applied to 32-bit words, ModelPixelScale + ModelTiepoint.
import { inflateSync } from 'node:zlib';

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 };
const TAG = {
  width: 256, height: 257, bits: 258, compression: 259, predictor: 317,
  tileW: 322, tileH: 323, tileOffsets: 324, tileCounts: 325, sampleFormat: 339,
  pixelScale: 33550, tiepoint: 33922, nodata: 42113,
};

export function parseTiff(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const order = buf.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') throw new Error('not a TIFF');
  const le = order === 'II';
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  if (u16(2) !== 42) throw new Error('BigTIFF/unknown TIFF version');
  const ifd = u32(4);
  const tags = {};
  for (let k = 0; k < u16(ifd); k++) {
    const e = ifd + 2 + k * 12;
    const [tag, type, cnt] = [u16(e), u16(e + 2), u32(e + 4)];
    const size = TYPE_SIZE[type];
    if (!size) continue;
    const off = size * cnt <= 4 ? e + 8 : u32(e + 8);
    if (type === 2) { tags[tag] = buf.toString('latin1', off, off + cnt).replace(/\0+$/, ''); continue; }
    const read = (i) => (type === 3 ? u16(off + 2 * i) : type === 4 ? u32(off + 4 * i) : type === 12 ? dv.getFloat64(off + 8 * i, le) : buf[off + i]);
    tags[tag] = Array.from({ length: cnt }, (_, i) => read(i));
  }
  const one = (t, dflt) => tags[t]?.[0] ?? dflt;
  const meta = {
    le,
    width: one(TAG.width), height: one(TAG.height),
    tileW: one(TAG.tileW), tileH: one(TAG.tileH),
    bits: one(TAG.bits), sampleFormat: one(TAG.sampleFormat, 1),
    compression: one(TAG.compression, 1), predictor: one(TAG.predictor, 1),
    offsets: tags[TAG.tileOffsets], counts: tags[TAG.tileCounts],
    scale: tags[TAG.pixelScale]?.slice(0, 2), origin: tags[TAG.tiepoint]?.slice(3, 5),
    nodata: tags[TAG.nodata] == null ? null : Number(tags[TAG.nodata]),
  };
  if (!meta.tileW || !meta.offsets) throw new Error('only tiled TIFFs are supported');
  if (meta.bits !== 32 || meta.sampleFormat !== 3) throw new Error(`unsupported sample type bits=${meta.bits} format=${meta.sampleFormat}`);
  if (![1, 8, 32946].includes(meta.compression)) throw new Error(`unsupported compression ${meta.compression}`);
  if (![1, 2].includes(meta.predictor)) throw new Error(`unsupported predictor ${meta.predictor}`);
  if (!meta.scale || !meta.origin) throw new Error('missing georeferencing tags');
  return meta;
}

// Undo TIFF horizontal differencing (predictor 2) on 32-bit words, row by row, in place.
export function undoPredictor32(words, tileW, tileH) {
  for (let r = 0; r < tileH; r++) {
    const base = r * tileW;
    for (let c = 1; c < tileW; c++) words[base + c] = (words[base + c] + words[base + c - 1]) >>> 0;
  }
  return words;
}

export function decodeTile(buf, meta, index) {
  const start = meta.offsets[index];
  const chunk = buf.subarray(start, start + meta.counts[index]);
  const raw = meta.compression === 1 ? Buffer.from(chunk) : inflateSync(chunk);
  const n = meta.tileW * meta.tileH;
  if (raw.length < n * 4) throw new Error(`tile ${index}: ${raw.length} bytes, expected ${n * 4}`);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const words = new Uint32Array(n);
  for (let i = 0; i < n; i++) words[i] = dv.getUint32(i * 4, meta.le);
  if (meta.predictor === 2) undoPredictor32(words, meta.tileW, meta.tileH);
  return new Float32Array(words.buffer);
}

// Nearest-pixel sampler. With PixelIsPoint the tiepoint is the centre of pixel (0,0).
export function rasterSampler(buf) {
  const meta = parseTiff(buf);
  const [sx, sy] = meta.scale;
  const [x0, y0] = meta.origin;
  const tilesPerRow = Math.ceil(meta.width / meta.tileW);
  const cache = new Map();
  const pixel = (i, j) => {
    if (i < 0 || j < 0 || i >= meta.width || j >= meta.height) return null;
    const key = Math.floor(j / meta.tileH) * tilesPerRow + Math.floor(i / meta.tileW);
    let tile = cache.get(key);
    if (!tile) cache.set(key, (tile = decodeTile(buf, meta, key)));
    const v = tile[(j % meta.tileH) * meta.tileW + (i % meta.tileW)];
    return v === meta.nodata || Number.isNaN(v) ? null : v;
  };
  return {
    meta,
    pixel,
    colOf: (lng) => Math.round((lng - x0) / sx),
    rowOf: (lat) => Math.round((y0 - lat) / sy),
    at(lat, lng) { return pixel(this.colOf(lng), this.rowOf(lat)); },
  };
}
