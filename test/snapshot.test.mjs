import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rainFeatures, tideAt, sliceHours, radarFramesBefore, radarRates } from '../public/js/snapshot.js';

test('rainFeatures uses the same weighted R3 and a 6h sum ending at the current hour', () => {
  const times = ['2026-10-08T05:00', '2026-10-08T06:00', '2026-10-08T07:00', '2026-10-08T08:00', '2026-10-08T09:00', '2026-10-08T10:00', '2026-10-08T11:00', '2026-10-08T12:00'];
  const precip = [1, 1, 1, 1, 2, 4, 10, 50];
  const now = Date.parse('2026-10-08T11:20:00+07:00');
  const f = rainFeatures(times, precip, now);
  assert.equal(f.p1, 10);
  assert.ok(Math.abs(f.R3 - (10 + 0.6 * 4 + 0.3 * 2)) < 1e-9);
  assert.equal(f.p6sum, 1 + 1 + 1 + 2 + 4 + 10);
  assert.equal(rainFeatures(times, precip, Date.parse('2026-10-09T00:00:00+07:00')), null);
});

test('tideAt records Phú An level, alert, source and latest observed peak', () => {
  const weather = {
    times: [0, 1, 2, 3].map((i) => Date.parse('2026-10-08T09:00:00+07:00') + i * 3600_000),
    sea: [1.1, 1.5, 2.0, 2.2],
    pa: [0.9, 1.2, 1.4, 1.556],
    paCorrected: [false, false, false, true],
    tide: { lagH: 3, bias: 0.6, alerts: { I: 1.4, II: 1.5, III: 1.6 }, observedPeaks: [{ t: '2026-10-07T02:00:00+07:00', h: 1.36, kind: 'peak' }, { t: '2026-10-08T10:00:00+07:00', h: 1.4, kind: 'peak' }] },
  };
  const at = (h) => Date.parse(`2026-10-08T${h}:30:00+07:00`);
  assert.deepEqual(tideAt(weather, at(12)), {
    source: 'open-meteo-marine@10.375,106.958', seaLevel: 2.2, seaLevelLagged: 1.1,
    phuAn: 1.56, phuAnSource: 'om+3h−bias+bulletin', bias: 0.6, alert: 'II',
    latestObservedPeak: weather.tide.observedPeaks[1],
  });
  assert.equal(tideAt(weather, at(10)).phuAnSource, 'om+3h−bias');
  assert.equal(tideAt(weather, at(10)).alert, '<I');
  assert.deepEqual(tideAt(weather, at('09')).latestObservedPeak, weather.tide.observedPeaks[0]);
  assert.equal(tideAt(weather, at('08')), null);
  assert.equal(tideAt({}, 0), null);
});

test('sliceHours keeps t − 6h .. t + 3h around the observed hour', () => {
  const times = Array.from({ length: 24 }, (_, i) => `2026-10-08T${String(i).padStart(2, '0')}:00`);
  const vals = times.map((_, i) => i);
  const s = sliceHours(times, vals, Date.parse('2026-10-08T10:40:00+07:00'));
  assert.deepEqual(s.precipitation, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.equal(s.time[0], '2026-10-08T04:00');
  assert.deepEqual(sliceHours(times, vals, Date.parse('2026-10-08T22:10:00+07:00')).precipitation, [16, 17, 18, 19, 20, 21, 22, 23]);
  assert.deepEqual(sliceHours(times, vals, Date.parse('2026-10-09T05:00:00+07:00')).time, []);
});

test('radarFramesBefore keeps every frame in [t − 60 min, t] while t is within the last 2h', () => {
  const last = Date.parse('2026-10-08T12:00:00Z') / 1000;
  const past = Array.from({ length: 13 }, (_, i) => ({ time: last - (12 - i) * 600, path: `/p${i}` }));
  assert.deepEqual(radarFramesBefore(past, last * 1000).map((f) => f.path), ['/p6', '/p7', '/p8', '/p9', '/p10', '/p11', '/p12']);
  assert.deepEqual(radarFramesBefore(past, (last - 3600 + 100) * 1000).map((f) => f.path), ['/p1', '/p2', '/p3', '/p4', '/p5', '/p6']);
  assert.deepEqual(radarFramesBefore(past, (last - 3 * 3600) * 1000), []);
  assert.deepEqual(radarFramesBefore([], last * 1000), []);
});

test('radarRates decodes each frame and keeps the max mm/h', () => {
  const r = radarRates([{ time: 1, rgba: [0, 0, 0, 0] }, { time: 2, rgba: [255, 170, 0, 255] }, { time: 3, rgba: [0, 163, 224, 255] }]);
  assert.deepEqual(r.frames.map((f) => [f.dBZ, f.mmH]), [[null, 0], [40, 11.53], [20, 0.65]]);
  assert.equal(r.maxMmH, 11.53);
  assert.equal(radarRates([]).maxMmH, null);
});
