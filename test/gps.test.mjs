import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inBbox, gpsDecision, gpsMeta } from '../public/js/gps.js';

const BBOX = [10.6, 106.5, 11.0, 106.9];
const pos = (lat, lng, accuracy = 12) => ({ coords: { latitude: lat, longitude: lng, accuracy }, timestamp: 1_700_000_000_000 });

test('inBbox includes edges, excludes outside, accepts missing bbox', () => {
  assert.equal(inBbox(BBOX, 10.8, 106.7), true);
  assert.equal(inBbox(BBOX, 10.6, 106.9), true);
  assert.equal(inBbox(BBOX, 21.0, 105.8), false);
  assert.equal(inBbox(null, 0, 0), true);
});

test('gpsDecision: fix inside bbox', () => {
  assert.deepEqual(gpsDecision(pos(10.8, 106.7, 12.4), BBOX), { fix: { lat: 10.8, lng: 106.7, accuracyM: 12, at: 1_700_000_000_000 } });
});

test('gpsDecision: fallbacks', () => {
  assert.equal(gpsDecision(pos(21, 105.8), BBOX).fallback, 'outside');
  assert.equal(gpsDecision({ code: 1 }, BBOX).fallback, 'denied');
  assert.equal(gpsDecision({ code: 3 }, BBOX).fallback, 'timeout');
  assert.equal(gpsDecision({ code: 2 }, BBOX).fallback, 'error');
  assert.equal(gpsDecision(null, BBOX).fallback, 'unsupported');
  assert.ok(gpsDecision({ code: 1 }, BBOX).message);
});

test('gpsMeta: distance from fix to final point, null without fix', () => {
  const fix = { lat: 10.8, lng: 106.7, accuracyM: 12, at: 1_700_000_000_000 };
  assert.deepEqual(gpsMeta(fix, { lat: 10.8, lng: 106.7 }), { accuracyM: 12, distanceM: 0, at: '2023-11-14T22:13:20.000Z' });
  const m = gpsMeta(fix, { lat: 10.801, lng: 106.7 });
  assert.ok(m.distanceM >= 110 && m.distanceM <= 112);
  assert.equal(gpsMeta(null, { lat: 1, lng: 1 }), null);
});
