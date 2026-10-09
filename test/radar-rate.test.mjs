import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbaToDbz, dbzToMmH, rgbaToMmH } from '../public/js/radar-rate.js';

// Sample colours read from a live RainViewer tile (scheme 2, options 0_0) over HCMC, 2026-10-08.
test('Universal Blue colours decode to the official dBZ', () => {
  assert.equal(rgbaToDbz([206, 192, 135, 150]), 10);
  assert.equal(rgbaToDbz([136, 221, 238, 255]), 15);
  assert.equal(rgbaToDbz([0, 163, 224, 255]), 20);
  assert.equal(rgbaToDbz([0, 85, 136, 255]), 30);
  assert.equal(rgbaToDbz([255, 238, 0, 255]), 35);
  assert.equal(rgbaToDbz([255, 170, 0, 255]), 40);
  assert.equal(rgbaToDbz([99, 97, 89, 20]), -10); // first table row
  assert.equal(rgbaToDbz([255, 170, 255, 255]), 55);
  assert.equal(rgbaToDbz([0, 255, 0, 255]), 75); // table end
});

test('transparent / missing pixel = no echo', () => {
  assert.equal(rgbaToDbz([0, 0, 0, 0]), null);
  assert.equal(rgbaToDbz(null), null);
  assert.equal(rgbaToMmH([0, 0, 0, 0]), 0);
});

test('near colours are no longer snapped (exact match only)', () => {
  assert.equal(rgbaToDbz([1, 162, 225, 254]), null);
});

test('Marshall–Palmer: R = (10^(dBZ/10) / 200)^(1/1.6)', () => {
  assert.ok(Math.abs(dbzToMmH(23) - 1) < 0.03); // Z = 200 → 1 mm/h at ≈ 23 dBZ
  assert.ok(Math.abs(dbzToMmH(40) - 11.53) < 0.01);
  assert.ok(Math.abs(dbzToMmH(50) - 48.62) < 0.01);
  assert.equal(dbzToMmH(null), 0);
  assert.ok(Math.abs(rgbaToMmH([255, 238, 0, 255]) - 5.62) < 0.01);
});

test('radar: opaque colours exact; partial-alpha colours tolerate ±2 canvas rounding; others are no echo', async () => {
  const { rgbaToDbz, rgbaToMmH } = await import('../public/js/radar-rate.js');
  assert.equal(rgbaToDbz([206, 192, 135, 150]), 10); // official partial-alpha entry
  assert.equal(rgbaToDbz([206, 192, 134, 150]), 10); // same entry after un-premultiply rounding
  assert.equal(rgbaToDbz([206, 192, 130, 150]), null); // beyond tolerance
  assert.equal(rgbaToDbz([206, 192, 135, 255]), null); // right RGB, wrong alpha
  assert.equal(rgbaToDbz([0, 86, 136, 255]), null); // opaque: exact only
  assert.equal(rgbaToMmH([10, 10, 10, 255]), 0);
});

test('radarAccumMm: Σ rate × frame spacing (default 10 min), windowed to the hour before t', async () => {
  const { radarAccumMm } = await import('../public/js/radar-rate.js');
  const t0 = 1_790_000_000;
  const frames = [1.33, 48.62, 23.68, 99.85, 48.62, 1.33].map((mmH, i) => ({ time: t0 + i * 600, mmH }));
  assert.equal(radarAccumMm(frames), 37.24);
  assert.equal(radarAccumMm(frames, (t0 + 3000) * 1000), 37.24);
  assert.equal(radarAccumMm(frames, (t0 + 1200) * 1000), 12.27); // only the first 3 frames ≤ t
  assert.equal(radarAccumMm([{ time: t0, mmH: 6 }]), 1);
  assert.equal(radarAccumMm([{ time: t0, mmH: 6 }, { time: t0 + 300, mmH: 6 }]), 1); // 5-min spacing
  assert.equal(radarAccumMm([]), null);
  assert.equal(radarAccumMm(undefined), null);
});
