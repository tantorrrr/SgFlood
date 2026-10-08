import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertLevel, computeBias, omPeakNear, phuAnModel, tideParams, latestPeakBefore, forecastDayPeaks, HOUR } from '../public/js/tide.js';

const T0 = Date.parse('2026-10-10T00:00:00+07:00');
// Synthetic semi-diurnal-ish OM: one peak of `amp` at 13:00 local each day, linear falloff.
const omSeries = (amp = 2.2) => (t) => {
  if (t < T0 - 2 * 24 * HOUR || t > T0 + 4 * 24 * HOUR) return null;
  const h = ((((t - T0) / HOUR) % 24) + 24) % 24;
  return amp - 0.1 * Math.abs(h - 13);
};

test('alertLevel maps Phú An levels to BĐ I/II/III', () => {
  assert.equal(alertLevel(1.39), '<I');
  assert.equal(alertLevel(1.4), 'I');
  assert.equal(alertLevel(1.55), 'II');
  assert.equal(alertLevel(1.6), 'III');
  assert.equal(alertLevel(null), null);
});

test('omPeakNear takes the max within ±2 h of t − lag', () => {
  const om = omSeries();
  assert.equal(omPeakNear(om, T0 + 16 * HOUR, 3), 2.2); // 13:00 exactly
  assert.ok(Math.abs(omPeakNear(om, T0 + 19 * HOUR, 3) - 2.1) < 1e-9); // window 14–18 → 14:00
  assert.equal(omPeakNear(() => null, T0, 3), null);
});

test('computeBias = median(OM peak(t−3h) − PA peak), only peaks ≥ 1.0, fallback when < 3 pairs', () => {
  const om = omSeries();
  const peak = (day, h) => ({ t: new Date(T0 + day * 24 * HOUR + 16 * HOUR).toISOString(), h, kind: 'peak' });
  const obs = [peak(0, 1.6), peak(1, 1.7), peak(2, 1.5), peak(-1, 0.8), { ...peak(0, 1.6), kind: 'low' }];
  assert.deepEqual(computeBias(obs, om), { bias: 0.6, n: 3 });
  assert.deepEqual(computeBias(obs.slice(0, 2), om), { bias: 0.6, n: 2 }); // fallback
  assert.deepEqual(computeBias(obs.slice(0, 2), om, { fallback: 0.5 }), { bias: 0.5, n: 2 });
  assert.equal(computeBias([peak(0, 1.6), peak(1, 1.4), peak(2, 1.2), peak(3, 1.0)], om).bias, 0.9);
});

test('phuAnModel: PA(t) = OM(t − 3h) − bias, without bulletin', () => {
  const m = phuAnModel(omSeries(), { bias: 0.6, lagH: 3 });
  const p = m.at(T0 + 16 * HOUR);
  assert.ok(Math.abs(p.h - 1.6) < 1e-9);
  assert.equal(p.corrected, false);
  assert.equal(m.at(T0 + 10 * 24 * HOUR), null);
});

test('phuAnModel shifts each forecast day so its highest hour matches the official peak', () => {
  const forecast = [
    { t: '2026-10-10T16:30:00+07:00', h: 1.75, kind: 'peak' },
    { t: '2026-10-10T04:00:00+07:00', h: 1.5, kind: 'peak' },
    { t: '2026-10-10T22:00:00+07:00', h: -1.2, kind: 'low' },
    { t: '2026-10-11T17:00:00+07:00', h: 1.45, kind: 'peak' },
  ];
  assert.deepEqual([...forecastDayPeaks(forecast)], [['2026-10-10', 1.75], ['2026-10-11', 1.45]]);
  const m = phuAnModel(omSeries(), { bias: 0.6, lagH: 3, forecast });
  assert.ok(Math.abs(m.offsets.get('2026-10-10') - 0.15) < 1e-9);
  assert.ok(Math.abs(m.offsets.get('2026-10-11') + 0.15) < 1e-9);
  // Day max (16:00 local) now equals the official peak; the offset applies to every hour of that day.
  assert.ok(Math.abs(m.at(T0 + 16 * HOUR).h - 1.75) < 1e-9);
  assert.ok(Math.abs(m.at(T0 + 2 * HOUR).h - (2.2 - 0.1 * 10 - 0.6 + 0.15)) < 1e-9); // OM at 23:00 the day before
  assert.equal(m.at(T0 + 2 * HOUR).corrected, true);
  assert.ok(Math.abs(m.at(T0 + 24 * HOUR + 16 * HOUR).h - 1.45) < 1e-9);
  assert.equal(m.at(T0 + 2 * 24 * HOUR + 16 * HOUR).corrected, false); // no bulletin that day
});

test('phuAnModel skips the correction when the base curve covers too little of the day', () => {
  const partial = (t) => (t >= T0 + 12 * HOUR ? 2.0 : null);
  const m = phuAnModel(partial, { bias: 0.6, lagH: 0, forecast: [{ t: '2026-10-10T16:00:00+07:00', h: 1.9, kind: 'peak' }] });
  assert.equal(m.offsets.size, 0);
  assert.equal(m.at(T0 + 15 * HOUR).corrected, false);
});

test('tideParams falls back to defaults when the file is missing or older than 3 days', () => {
  const now = Date.parse('2026-10-08T12:00:00+07:00');
  const json = {
    fetchedAt: '2026-10-08T09:30:00+07:00', bias: 0.58, lagH: 3, alerts: { I: 1.4, II: 1.5, III: 1.6 },
    observed: [{ t: '2026-10-06T14:00:00+07:00', h: 1.3, kind: 'peak' }, { t: '2026-10-07T02:00:00+07:00', h: 1.36, kind: 'peak' }, { t: '2026-10-07T20:00:00+07:00', h: -1.4, kind: 'low' }],
    forecast: [{ t: '2026-10-08T14:00:00+07:00', h: 1.27, kind: 'peak' }],
  };
  const fresh = tideParams(json, now);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.bias, 0.58);
  assert.equal(fresh.forecast.length, 1);
  assert.deepEqual(fresh.observedPeaks, json.observed.slice(0, 2));
  assert.deepEqual(latestPeakBefore(fresh.observedPeaks, now), json.observed[1]);
  assert.deepEqual(latestPeakBefore(fresh.observedPeaks, Date.parse('2026-10-07T01:00:00+07:00')), json.observed[0]);
  assert.equal(latestPeakBefore(fresh.observedPeaks, Date.parse('2026-10-06T00:00:00+07:00')), null);
  const old = tideParams(json, now + 4 * 24 * HOUR);
  assert.equal(old.stale, true);
  assert.equal(old.bias, 0.6);
  assert.deepEqual(old.forecast, []);
  assert.equal(tideParams(null, now).stale, true);
});
