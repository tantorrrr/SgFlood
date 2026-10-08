import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findIntersection, buildChains, selectBetween, resolveGeometry } from '../scripts/lib/hotspot-geom.mjs';
import { distanceM } from '../public/js/geo.js';

const LAT = 10.8;
const way = (nodes, coords) => ({ nodes, coords });
const row = (lat, lngs, firstId) => way(lngs.map((_, i) => firstId + i), lngs.map((lng) => [lat, lng]));
const lookup = (byName) => (name) => byName[name] ?? [];

// Street A along LAT; street B is a U crossing A at node 2 (106.705) and node 4 (106.715).
const A = [row(LAT, [106.700, 106.705, 106.710, 106.715, 106.720], 1)];
const B = [way([10, 2, 11, 12, 4, 13], [[10.799, 106.705], [LAT, 106.705], [10.801, 106.705], [10.801, 106.715], [LAT, 106.715], [10.799, 106.715]])];

test('findIntersection picks the shared node nearest to near', () => {
  assert.deepEqual(findIntersection(A, B, [LAT, 106.714]), [LAT, 106.715]);
  assert.deepEqual(findIntersection(A, B, [LAT, 106.704]), [LAT, 106.705]);
});

test('findIntersection falls back to a close vertex pair and rejects far candidates', () => {
  const nearMiss = [way([20, 21], [[10.79991, 106.710], [10.799, 106.710]])];
  const p = findIntersection(A, nearMiss, [LAT, 106.71]);
  assert.ok(distanceM(p, [LAT, 106.71]) < 10);
  assert.equal(findIntersection(A, B, [10.9, 106.8]), null);
});

test('resolveGeometry fails with names when there is no intersection', () => {
  const far = [row(10.85, [106.70, 106.71], 30)];
  const waysOf = lookup({ A, F: far });
  assert.throws(() => resolveGeometry({ type: 'junction', streets: ['A', 'F'], radiusM: 100, near: [LAT, 106.7] }, waysOf), /A × F/);
  assert.throws(() => resolveGeometry({ type: 'near', street: 'Nope', point: [LAT, 106.7], radiusM: 100 }, waysOf), /Nope/);
});

// Dual carriageway S (two parallel chains ~22 m apart, each split into two ways) crossed by C1 and C2.
const S = [
  way([100, 101, 102], [[LAT, 106.700], [LAT, 106.705], [LAT, 106.710]]),
  way([102, 103, 104], [[LAT, 106.710], [LAT, 106.715], [LAT, 106.720]]),
  way([204, 203, 202], [[10.8002, 106.720], [10.8002, 106.715], [10.8002, 106.710]]),
  way([202, 201, 200], [[10.8002, 106.710], [10.8002, 106.705], [10.8002, 106.700]]),
];
const C1 = [way([300, 101, 201, 301], [[10.799, 106.705], [LAT, 106.705], [10.8002, 106.705], [10.801, 106.705]])];
const C2 = [way([400, 103, 203, 401], [[10.799, 106.715], [LAT, 106.715], [10.8002, 106.715], [10.801, 106.715]])];
const dualWays = lookup({ S, C1, C2 });

test('buildChains joins consecutive ways into one chain per carriageway', () => {
  const chains = buildChains(S);
  assert.equal(chains.length, 2);
  chains.forEach((c) => assert.equal(c.coords.length, 5));
});

test('between keeps only the stretch between cross streets on both carriageways', () => {
  const { names, contains } = resolveGeometry({ type: 'between', street: 'S', from: 'C1', to: 'C2', near: [LAT, 106.71] }, dualWays);
  assert.deepEqual([...names], ['s']);
  assert.ok(contains([LAT, 106.71]));
  assert.ok(contains([10.8002, 106.71]));
  assert.ok(!contains([LAT, 106.718]));
  assert.ok(!contains([10.8002, 106.702]));
});

test('between accepts an explicit point as endpoint', () => {
  const { contains } = resolveGeometry({ type: 'between', street: 'S', from: { point: [10.8001, 106.703], label: 'X' }, to: 'C1', near: [LAT, 106.704] }, dualWays);
  assert.ok(contains([LAT, 106.704]));
  assert.ok(!contains([LAT, 106.702]));
  assert.ok(!contains([LAT, 106.707]));
});

test('selectBetween returns nothing when endpoints are off the street', () => {
  assert.equal(selectBetween(buildChains(S), [10.81, 106.705], [10.81, 106.715]).length, 0);
});

test('junction covers both streets within radius of the intersection', () => {
  const { names, contains } = resolveGeometry({ type: 'junction', streets: ['A', 'B'], radiusM: 150, near: [LAT, 106.714] }, lookup({ A, B }));
  assert.deepEqual([...names], ['a', 'b']);
  assert.ok(contains([LAT, 106.716]));
  assert.ok(!contains([LAT, 106.717]));
  assert.ok(!contains([LAT, 106.705]));
});
