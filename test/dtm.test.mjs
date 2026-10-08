import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { undoPredictor32, parseTiff, rasterSampler } from '../scripts/lib/tiff.mjs';
import { findCentralDirectory, parseCentralDirectory, localDataOffset } from '../scripts/lib/zip-range.mjs';
import { samplePath, minAlong, cropGrid, NODATA } from '../scripts/lib/dtm.mjs';
import { dtmValueAt } from '../public/js/dtm.js';
import { distanceM } from '../public/js/geo.js';

// Predictor-2 encode on 32-bit words (inverse of undoPredictor32).
function encodePredictor32(words, w, h) {
  const out = Uint32Array.from(words);
  for (let r = 0; r < h; r++) for (let c = w - 1; c > 0; c--) out[r * w + c] = (words[r * w + c] - words[r * w + c - 1]) >>> 0;
  return out;
}

// Single-tile little-endian float32 GeoTIFF (FABDEM-like tags).
function makeTiff(values, size, { x0 = 106, y0 = 11, step = 1 / 3600, nodata = -9999 } = {}) {
  const words = new Uint32Array(new Float32Array(values).buffer);
  const tile = deflateSync(Buffer.from(encodePredictor32(words, size, size).buffer));
  const tags = [];
  const extra = [];
  let extraOff = 8 + 2 + 13 * 12 + 4;
  const blob = (buf) => { const off = extraOff; extra.push(buf); extraOff += buf.length; return off; };
  const f64 = (arr) => { const b = Buffer.alloc(arr.length * 8); arr.forEach((v, i) => b.writeDoubleLE(v, i * 8)); return b; };
  const scaleOff = blob(f64([step, step, 0]));
  const tieOff = blob(f64([0, 0, 0, x0, y0, 0]));
  const nd = Buffer.from(`${nodata}\0`, 'latin1');
  const ndOff = blob(nd);
  const tileOff = extraOff;
  tags.push([256, 3, 1, size], [257, 3, 1, size], [258, 3, 1, 32], [259, 3, 1, 8], [317, 3, 1, 2],
    [322, 3, 1, size], [323, 3, 1, size], [324, 4, 1, tileOff], [325, 4, 1, tile.length], [339, 3, 1, 3],
    [33550, 12, 3, scaleOff], [33922, 12, 6, tieOff], [42113, 2, nd.length, ndOff]);
  const head = Buffer.alloc(8 + 2 + tags.length * 12 + 4);
  head.write('II', 0, 'latin1');
  head.writeUInt16LE(42, 2);
  head.writeUInt32LE(8, 4);
  head.writeUInt16LE(tags.length, 8);
  tags.forEach(([tag, type, cnt, val], k) => {
    const e = 10 + k * 12;
    head.writeUInt16LE(tag, e);
    head.writeUInt16LE(type, e + 2);
    head.writeUInt32LE(cnt, e + 4);
    if (type === 3 && cnt === 1) head.writeUInt16LE(val, e + 8);
    else head.writeUInt32LE(val, e + 8);
  });
  return Buffer.concat([head, ...extra, tile]);
}

test('undoPredictor32 restores horizontally differenced rows with uint32 wrap-around', () => {
  const words = Uint32Array.from([5, 0xffffffff, 3, 10, 1, 1]);
  assert.deepEqual([...undoPredictor32(Uint32Array.from(encodePredictor32(words, 3, 2)), 3, 2)], [...words]);
  assert.deepEqual([...undoPredictor32(Uint32Array.from([1, 2, 3, 4]), 2, 2)], [1, 3, 3, 7]);
});

test('TIFF: Deflate + predictor 2 float32 tile decodes; PixelIsPoint nearest sampling; nodata → null', () => {
  const vals = [1.5, 2.25, -0.5, 3, 0.1, -9999, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const buf = makeTiff(vals, 4);
  const meta = parseTiff(buf);
  assert.equal(meta.width, 4);
  assert.equal(meta.predictor, 2);
  assert.equal(meta.nodata, -9999);
  const r = rasterSampler(buf);
  const s = 1 / 3600;
  assert.equal(r.at(11, 106), 1.5);
  assert.equal(r.at(11 - 0.4 * s, 106 + 1.4 * s), 2.25); // nearest centre
  assert.ok(Math.abs(r.at(11 - s, 106) - 0.1) < 1e-6);
  assert.equal(r.at(11 - s, 106 + s), null);
  assert.equal(r.at(11 - 3 * s, 106 + 3 * s), 16);
  assert.equal(r.at(12, 106), null); // outside
});

test('zip: EOCD → central directory → local header data offset', () => {
  const name = Buffer.from('dir/N10E106_FABDEM_V1-2.tif');
  const data = Buffer.from('hello tiles');
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(name.length, 26);
  lfh.writeUInt16LE(4, 28);
  const local = Buffer.concat([lfh, name, Buffer.alloc(4), data]);
  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(0, 10);
  cdh.writeUInt32LE(data.length, 20);
  cdh.writeUInt32LE(data.length, 24);
  cdh.writeUInt16LE(name.length, 28);
  cdh.writeUInt32LE(0, 42);
  const cd = Buffer.concat([cdh, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  const zip = Buffer.concat([local, cd, eocd]);

  const loc = findCentralDirectory(zip.subarray(zip.length - 40));
  assert.deepEqual(loc, { offset: local.length, size: cd.length });
  const [entry] = parseCentralDirectory(zip.subarray(loc.offset, loc.offset + loc.size));
  assert.deepEqual(entry, { name: name.toString(), method: 0, csize: data.length, usize: data.length, localOffset: 0 });
  const start = localDataOffset(zip.subarray(0, 30), entry);
  assert.equal(zip.subarray(start, start + entry.csize).toString(), 'hello tiles');
  assert.throws(() => findCentralDirectory(Buffer.alloc(30)), /end of central directory/);
});

test('samplePath spaces points ≤ step; minAlong takes the lowest valid sample', () => {
  const coords = [[10.8, 106.7], [10.8, 106.701]];
  const pts = samplePath(coords, 30);
  assert.equal(pts.length, Math.ceil(distanceM(...coords) / 30) + 1);
  assert.deepEqual(pts.at(-1), coords[1]);
  const zAt = (lat, lng) => (lng > 106.7004 && lng < 106.7006 ? 0.42 : lng > 106.7008 ? null : 2);
  assert.equal(minAlong(coords, zAt, 30), 0.42);
  assert.equal(minAlong(coords, () => null, 30), null);
});

test('cropGrid keeps pixel centres inside bbox (north → south, cm) and dtmValueAt reads them back', () => {
  const step = 0.1;
  const dtm = {
    step, label: 'test', license: 'x', datum: 'Hòn Dấu',
    colOf: (lng) => Math.round((lng - 106) / step),
    rowOf: (lat) => Math.round((11 - lat) / step),
    lngOf: (i) => 106 + i * step,
    latOf: (j) => 11 - j * step,
    pixel: (i, j) => (i === 3 && j === 2 ? null : i + j / 10),
  };
  const { meta, data } = cropGrid(dtm, [10.66, 106.12, 10.9, 106.36]);
  assert.equal(meta.width, 2); // columns 2,3 (106.2, 106.3)
  assert.equal(meta.height, 3); // rows 1..3 (10.9 … 10.7)
  assert.equal(meta.north, 10.9);
  assert.equal(meta.west, 106.2);
  assert.deepEqual([...data], [210, 310, 220, NODATA, 230, 330]);
  assert.equal(dtmValueAt({ meta, data }, 10.9, 106.2), 2.1);
  assert.equal(dtmValueAt({ meta, data }, 10.71, 106.31), 3.3);
  assert.equal(dtmValueAt({ meta, data }, 10.8, 106.3), null);
  assert.equal(dtmValueAt({ meta, data }, 10.0, 106.3), null);
});
