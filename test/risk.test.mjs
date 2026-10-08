import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smoothstep, bilinear, rain3h, levelOf, segmentRisk, susceptibility, segmentAnalogs, nearestRoadName } from '../public/js/risk.js';
import { reportEvent, groupCells, prepareCell, cellLevel } from '../public/js/cells.js';
import { BucketIndex } from '../public/js/geo.js';

const MODEL = {
  RAIN_START: 3, RAIN_FULL: 25, TIDE_START: 1.4, TIDE_FULL: 1.95, HOTSPOT_S: 0.95,
  S_RAIN_BASE: 0.1, S_RAIN_LOW: 0.35, Z_LOW: 1.0, Z_HIGH: 3.0, Z_TIDE: 1.2, S_TIDE_LOW: 0.45,
  ANALOG_RAIN_MIN: 8, ANALOG_NEAR_RATIO: 0.7, ANALOG_TIDE_TOL: 0.05,
};
const GRID = { rows: 2, cols: 2, lats: [10, 11], lngs: [106, 107] };
const uniform = (v) => new Float32Array(4).fill(v);
const weather = (precip, pa = precip.map(() => null)) => ({ grid: GRID, precip, pa });

test('smoothstep clamps at edges and is 0.5 at midpoint', () => {
  assert.equal(smoothstep(3, 25, 0), 0);
  assert.equal(smoothstep(3, 25, 3), 0);
  assert.equal(smoothstep(3, 25, 25), 1);
  assert.equal(smoothstep(3, 25, 100), 1);
  assert.equal(smoothstep(3, 25, 14), 0.5);
});

test('bilinear interpolates corners, center and clamps outside', () => {
  const v = [0, 10, 20, 30]; // SW, SE, NW, NE
  assert.equal(bilinear(GRID, v, 10, 106), 0);
  assert.equal(bilinear(GRID, v, 11, 107), 30);
  assert.equal(bilinear(GRID, v, 10.5, 106.5), 15);
  assert.equal(bilinear(GRID, v, 10, 106.5), 5);
  assert.equal(bilinear(GRID, v, 12, 108), 30);
});

test('rain3h weights the last three hours and treats missing hours as 0', () => {
  const w = weather([uniform(10), uniform(10), uniform(10)]);
  assert.ok(Math.abs(rain3h(w, [10.5, 106.5], 2) - 19) < 1e-6);
  assert.ok(Math.abs(rain3h(w, [10.5, 106.5], 0) - 10) < 1e-6);
});

test('levelOf thresholds', () => {
  assert.equal(levelOf(0.249), 0);
  assert.equal(levelOf(0.25), 1);
  assert.equal(levelOf(0.5), 2);
  assert.equal(levelOf(0.749), 2);
  assert.equal(levelOf(0.75), 3);
});

test('rain hotspot floods under heavy rain, high ground does not, low ground ponds', () => {
  const w = weather([uniform(30)]);
  const hot = segmentRisk({ z: 5 }, [10.5, 106.5], { cause: 'rain' }, w, 0, MODEL);
  assert.equal(hot.level, 3);
  assert.equal(hot.cause, 'rain');
  assert.equal(segmentRisk({ z: 5 }, [10.5, 106.5], undefined, w, 0, MODEL).level, 0);
  assert.equal(segmentRisk({ z: null }, [10.5, 106.5], undefined, w, 0, MODEL).level, 0);
  const low = segmentRisk({ z: 0.5 }, [10.5, 106.5], undefined, w, 0, MODEL);
  assert.equal(low.level, 1);
  assert.equal(low.reason.z, 0.5);
});

test('terrain rain susceptibility: 0.45 below Z_LOW, 0.1 above Z_HIGH, smooth between', () => {
  const s = (z) => susceptibility({ z }, undefined, MODEL).sRain;
  assert.ok(Math.abs(s(0.2) - 0.45) < 1e-9);
  assert.ok(Math.abs(s(1.0) - 0.45) < 1e-9);
  assert.ok(Math.abs(s(2.0) - 0.275) < 1e-9);
  assert.ok(Math.abs(s(3.0) - 0.1) < 1e-9);
  assert.equal(s(null), 0.1);
  assert.equal(susceptibility({ z: 0 }, { cause: 'both' }, MODEL).sRain, 0.95);
});

test('terrain tide susceptibility only for low ground below the current Phú An level', () => {
  const t = (z, pa) => susceptibility({ z }, undefined, MODEL, pa).sTide;
  assert.equal(t(1.0, 1.5), 0.45);
  assert.equal(t(1.2, 1.5), 0.45);
  assert.equal(t(1.21, 1.6), 0); // above Z_TIDE
  assert.equal(t(1.0, 0.9), 0); // tide below ground
  assert.equal(t(1.0, null), 0);
  assert.equal(t(null, 1.8), 0);
  assert.equal(susceptibility({ z: 9 }, { cause: 'tide' }, MODEL, 0).sTide, 0.95);
});

test('tide uses the Phú An level at t; off-hotspot low ground is capped at level 1', () => {
  const w = weather([uniform(0), uniform(0), uniform(0)], [1.0, 1.7, 2.0]);
  const tide = segmentRisk({ z: 3 }, [10.5, 106.5], { cause: 'tide' }, w, 2, MODEL);
  assert.equal(tide.level, 3);
  assert.equal(tide.cause, 'tide');
  assert.equal(tide.reason.pa, 2.0);
  assert.equal(segmentRisk({ z: 3 }, [10.5, 106.5], { cause: 'tide' }, w, 0, MODEL).level, 0); // below BĐ I
  assert.equal(segmentRisk({ z: 3 }, [10.5, 106.5], { cause: 'rain' }, w, 2, MODEL).level, 0);
  assert.equal(segmentRisk({ z: 0.8 }, [10.5, 106.5], undefined, w, 2, MODEL).level, 1);
  assert.equal(segmentRisk({ z: 0.8 }, [10.5, 106.5], undefined, weather([uniform(0)]), 0, MODEL).reason.pa, null);
});

const SEGS = [{ z: 5, n: 'Nguyễn Hữu Cảnh', c: [[10.5, 106.499], [10.5, 106.501]] }, { z: 5, c: [[10.52, 106.499], [10.52, 106.501]] }];
const segIndex = (segs) => {
  const index = new BucketIndex();
  segs.forEach((s, i) => index.add(i, s.c));
  return index;
};
const pastReport = (extra) => ({
  id: 'r1', lat: 10.5, lng: 106.5, level: 2, confirms: 0, denies: 0, observed_at: '2026-10-01T10:00:00Z',
  snapshot: { features: { ecmwf_ifs: { R3: 1 } }, tide: { phuAn: 1.1 } }, ...extra,
});
// Reports → §18 history cells (what the app feeds Forecast / segmentRisk).
const cellsOf = (reports, minNet = 0) => groupCells(reports.map((r) => reportEvent(r))).map((c) => prepareCell(c, MODEL, minNet)).filter(Boolean);

test('bug §14: past flood at R3 = 1 mm now forecasts its level when forecast R3 = 8 mm', () => {
  const cells = cellsOf([pastReport()]);
  assert.equal(cells.length, 1);
  const near = segmentAnalogs(cells, SEGS, segIndex(SEGS));
  assert.deepEqual([...near.keys()], [0]);
  const w = weather([uniform(8)]);
  assert.equal(segmentRisk(SEGS[0], [10.5, 106.5], undefined, w, 0, MODEL).level, 0); // heuristic alone
  const hit = segmentRisk(SEGS[0], [10.5, 106.5], undefined, w, 0, MODEL, near.get(0));
  assert.equal(hit.level, 2);
  assert.equal(hit.cause, 'rain');
  assert.equal(hit.reason.analog.count, 1);
  assert.equal(hit.reason.analog.threshold, 8);
});

test('heavy forecast rain: max(heuristic, cell)', () => {
  const tiny = cellsOf([pastReport({ level: 1, snapshot: { features: { ecmwf_ifs: { R3: 0 } } } })]);
  assert.equal(segmentRisk(SEGS[0], [10.5, 106.5], { cause: 'rain' }, weather([uniform(30)]), 0, MODEL, tiny).level, 3);
});

test('tide cell drives segmentRisk with cause tide', () => {
  const cells = cellsOf([pastReport({ snapshot: { features: { ecmwf_ifs: { R3: 0.5 } }, tide: { phuAn: 1.6 } } })]);
  const near = segmentAnalogs(cells, SEGS, segIndex(SEGS)).get(0);
  const at = (pa) => segmentRisk(SEGS[0], [10.5, 106.5], undefined, weather([uniform(0)], [pa]), 0, MODEL, near);
  assert.equal(at(1.55).level, 2);
  assert.equal(at(1.55).cause, 'tide');
  assert.equal(at(1.54).level, 0);
  assert.equal(at(null).level, 0);
});

test('cell with no segment within 200 m is still listed, labelled by nearest road within 500 m', () => {
  const index = segIndex(SEGS);
  const far = cellsOf([pastReport({ lat: 10.503, lng: 106.5 })]); // ~330 m north of seg 0
  assert.equal(far.length, 1);
  assert.equal(segmentAnalogs(far, SEGS, index).size, 0);
  assert.equal(nearestRoadName(10.503, 106.5, SEGS, index), 'Nguyễn Hữu Cảnh');
  assert.equal(nearestRoadName(10.51, 106.5, SEGS, index), '');
  assert.equal(cellLevel(far[0], 8, null, MODEL).level, 2);
});

test('history cells follow ANALOG_MIN_NET, drop denied / withdrawn / no-snapshot reports; dry-only cells fire nothing', () => {
  const ok = (rs, minNet) => cellsOf(rs, minNet).length;
  assert.equal(ok([pastReport()], 0), 1);
  assert.equal(ok([pastReport()], 1), 0);
  assert.equal(ok([pastReport({ denies: 2 })], -5), 0);
  assert.equal(ok([pastReport({ withdrawn_at: '2026-10-02T00:00:00Z' })], 0), 0);
  assert.equal(ok([pastReport({ level: 0 })], 0), 0);
  assert.equal(ok([pastReport({ snapshot: null })], 0), 0);
});
