import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tileId, tileBbox, gridTiles, tilesForView } from '../public/js/tiles.js';
import { BucketIndex } from '../public/js/geo.js';
import { Forecast } from '../public/js/forecast.js';
import { groupCells, prepareCell } from '../public/js/cells.js';

const BBOX = [10.66, 106.58, 10.9, 106.84];
const MODEL = {
  RAIN_START: 3, RAIN_FULL: 25, TIDE_START: 1.4, TIDE_FULL: 1.95, HOTSPOT_S: 0.95,
  S_RAIN_BASE: 0.1, S_RAIN_LOW: 0.35, Z_LOW: 1.0, Z_HIGH: 3.0, Z_TIDE: 1.2, S_TIDE_LOW: 0.45,
  ANALOG_RAIN_MIN: 8, ANALOG_NEAR_RATIO: 0.7, ANALOG_TIDE_TOL: 0.05,
};

test('tile ids are anchored at the bbox SW corner and stable on exact edges', () => {
  assert.equal(tileId(BBOX, 10.66, 106.58), '0-0');
  assert.equal(tileId(BBOX, 10.68, 106.6), '1-1'); // 10.66 + 0.02 is not floored to row 0
  assert.equal(tileId(BBOX, 10.7799, 106.7001), '5-6');
  assert.deepEqual(tileBbox(BBOX, '5-6'), [10.76, 106.7, 10.78, 106.72]);
  const id = tileId(BBOX, 10.771, 106.698);
  const [s, w, n, e] = tileBbox(BBOX, id);
  assert.ok(s <= 10.771 && 10.771 < n && w <= 106.698 && 106.698 < e);
});

test('grid covers the bbox with 12 × 13 tiles', () => {
  const ids = gridTiles(BBOX);
  assert.equal(ids.length, 156);
  assert.equal(ids[0], '0-0');
  assert.equal(ids.at(-1), '11-12');
});

test('tilesForView returns the touched tiles plus a margin ring', () => {
  assert.deepEqual(tilesForView(BBOX, [10.761, 106.701, 10.769, 106.709], 0), ['5-6']);
  const ring = tilesForView(BBOX, [10.761, 106.701, 10.769, 106.709]);
  assert.equal(ring.length, 9);
  assert.ok(ring.includes('4-5') && ring.includes('6-7'));
  assert.deepEqual(tilesForView(BBOX, [10.761, 106.701, 10.781, 106.709], 0), ['5-6', '6-6']);
});

test('BucketIndex finds segments added after construction', () => {
  const index = new BucketIndex();
  index.add(0, [[10.7, 106.7], [10.701, 106.7]]);
  assert.deepEqual([...index.near(10.7, 106.7)], [0]);
  index.add(1, [[10.7005, 106.7002], [10.7008, 106.7004]]);
  assert.deepEqual([...index.near(10.7, 106.7)].sort(), [0, 1]);
});

const GRID = { rows: 2, cols: 2, lats: [10.6, 11], lngs: [106.5, 107] };
const T = 6;
const weather = {
  grid: GRID,
  times: Array.from({ length: T }, (_, i) => i * 3600_000),
  precip: Array.from({ length: T }, (_, i) => new Float32Array(4).fill(i * 4)),
  pa: Array(T).fill(null),
};
// One past flood (Rh_eff 8 mm) at 10.7004, 106.7 as a §18 history cell.
const historyCell = (level) => groupCells([{ id: 'a', source: 'report', lat: 10.7004, lng: 106.7, t: '2026-09-01T00:00:00Z', level, net: 0, Rh: 8, RhSrc: 'ecmwf', PAh: null, cause: null }])
  .map((c) => prepareCell(c, MODEL));
const seg = (lat, z, extra = {}) => ({ n: 'x', h: 'residential', c: [[lat, 106.7], [lat + 0.001, 106.7]], z, ...extra });

test('Forecast.addSegments computes only new segments and matches a full recompute', () => {
  const major = [seg(10.7, 0.5), seg(10.71, 4)];
  const minor = [seg(10.7003, 0.2, { minor: true }), seg(10.75, 5, { minor: true })];
  const analogs = historyCell(3);

  const index = new BucketIndex();
  const incSegs = [...major];
  incSegs.forEach((s, i) => index.add(i, s.c));
  const inc = new Forecast({ segs: incSegs, hotspots: [] }, weather, MODEL, index);
  inc.setAnalogs(analogs);
  const before = inc.levels[0];
  minor.forEach((s) => {
    index.add(incSegs.length, s.c);
    incSegs.push(s);
  });
  inc.addSegments(2);
  assert.equal(inc.levels[0], before, 'existing rows are not recomputed');

  const fullIndex = new BucketIndex();
  const allSegs = [...major, ...minor];
  allSegs.forEach((s, i) => fullIndex.add(i, s.c));
  const full = new Forecast({ segs: allSegs, hotspots: [] }, weather, MODEL, fullIndex);
  full.setAnalogs(analogs);

  for (let i = 0; i < allSegs.length; i++) for (let ti = 0; ti < T; ti++) assert.equal(inc.level(ti, i), full.level(ti, i));
  assert.deepEqual([...inc.segAnalogs.keys()].sort(), [...full.segAnalogs.keys()].sort());
  assert.equal(inc.level(T - 1, 2), 3, 'minor segment next to the analog fires it');
});

test('summary lists minor roads only when they are a hotspot or carry an analog', () => {
  const segs = [seg(10.7, 0.2, { minor: true, n: 'Hẻm A' }), seg(10.8, 0.2, { minor: true, n: 'Hẻm B' }), seg(10.85, 0.2, { minor: true, hs: 'h1' })];
  const index = new BucketIndex();
  segs.forEach((s, i) => index.add(i, s.c));
  const wet = { ...weather, precip: weather.precip.map(() => new Float32Array(4).fill(40)) };
  const f = new Forecast({ segs, hotspots: [{ id: 'h1', title: 'Điểm ngập', area: '', cause: 'rain' }] }, wet, MODEL, index);
  f.setAnalogs(historyCell(2));
  const titles = f.summary(0, T - 1).map((r) => r.title);
  assert.ok(titles.includes('Hẻm A'));
  assert.ok(!titles.includes('Hẻm B'));
  assert.ok(titles.includes('Điểm ngập'));
});
