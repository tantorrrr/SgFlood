import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowDistanceM, sortRows, bySeverity } from '../public/js/forecast.js';
import { fmtDistance } from '../public/js/format.js';

// Segments ~east of the view point along lat 10.78.
const segs = [
  { c: [[10.78, 106.70], [10.78, 106.701]] }, // ~0 m
  { c: [[10.78, 106.71], [10.78, 106.711]] }, // ~1.1 km
  { c: [[10.78, 106.73], [10.78, 106.731]] }, // ~3.3 km
];
const P = [10.78, 106.70];
const rows = [
  { key: 'far-deep', level: 3, peakTi: 5, segIdx: [2] },
  { key: 'mid', level: 2, peakTi: 2, segIdx: [1, 2] },
  { key: 'analog', level: 1, peakTi: 1, segIdx: [], latlng: [10.7845, 106.70] }, // ~500 m
  { key: 'near', level: 1, peakTi: 3, segIdx: [0] },
];
const dist = (r, p) => rowDistanceM(r, p, segs);

test('§20b rowDistanceM: nearest segment of the group, or the row latlng', () => {
  assert.ok(dist(rows[3], P) < 1);
  assert.ok(Math.abs(dist(rows[1], P) - 1094) < 20); // min over its two segments
  assert.ok(Math.abs(dist(rows[2], P) - 500) < 10);
  assert.equal(rowDistanceM({ segIdx: [] }, P, segs), Infinity);
});

test('§20b sortRows: near → distance asc; severe → level/time; no point → old order without distance', () => {
  assert.deepEqual(sortRows(rows, P, 'near', dist).map((r) => r.key), ['near', 'analog', 'mid', 'far-deep']);
  const severe = sortRows(rows, P, 'severe', dist);
  assert.deepEqual(severe.map((r) => r.key), ['far-deep', 'mid', 'analog', 'near']);
  assert.ok(severe.every((r) => Number.isFinite(r.distM)));
  const none = sortRows(rows, null, 'near', dist);
  assert.deepEqual(none.map((r) => r.key), [...rows].sort(bySeverity).map((r) => r.key));
  assert.ok(none.every((r) => r.distM === undefined));
  // ties on distance fall back to severity; input not mutated
  const tie = [{ key: 'a', level: 1, peakTi: 0, latlng: P }, { key: 'b', level: 2, peakTi: 0, latlng: P }];
  assert.deepEqual(sortRows(tie, P, 'near', dist).map((r) => r.key), ['b', 'a']);
  assert.equal(rows[0].distM, undefined);
});

test('§20b fmtDistance', () => {
  assert.equal(fmtDistance(12), '≈ 50 m');
  assert.equal(fmtDistance(349), '≈ 350 m');
  assert.equal(fmtDistance(1234), '≈ 1.2 km');
  assert.equal(fmtDistance(12345), '≈ 12 km');
  assert.equal(fmtDistance(Infinity), '');
});
