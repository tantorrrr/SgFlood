import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellOf, rhEff, reportEvent, groupCells, quantile, prepareCell, cellLevel, CELL_DEG } from '../public/js/cells.js';
import { newsEvent, withWeather } from '../public/js/news-layer.js';
import { cellTrigger } from '../public/js/format.js';

const MODEL = { TIDE_START: 1.4, ANALOG_RAIN_MIN: 8, ANALOG_NEAR_RATIO: 0.7, ANALOG_TIDE_TOL: 0.05 };
let seq = 0;
const ev = (level, Rh, extra = {}) => ({
  id: `e${seq++}`, source: 'report', lat: 10.78, lng: 106.7, t: '2026-09-01T10:00:00Z', level, net: 0, Rh, RhSrc: 'ecmwf', PAh: null, cause: null, ...extra,
});
const cell = (events, minNet) => prepareCell({ cell_id: 'c', lat: 10.78, lng: 106.7, events }, MODEL, minNet);
const at = (c, R3, pa = null) => cellLevel(c, R3, pa, MODEL);

test('cellOf: ~150 m grid, same id for points in one cell, centre of the cell', () => {
  const a = cellOf(10.78, 106.7);
  assert.equal(a.cell_id, `${Math.floor(10.78 / CELL_DEG)}:${Math.floor(106.7 / CELL_DEG)}`);
  assert.ok(Math.abs(a.lat - 10.78) <= CELL_DEG / 2 && Math.abs(a.lng - 106.7) <= CELL_DEG / 2);
  assert.equal(cellOf(a.lat + CELL_DEG * 0.4, a.lng - CELL_DEG * 0.4).cell_id, a.cell_id);
  assert.notEqual(cellOf(a.lat + CELL_DEG, a.lng).cell_id, a.cell_id);
});

test('rhEff = max(ECMWF R3, GFS R3, radar 1-h accumulation, enrichment), with its source', () => {
  assert.deepEqual(rhEff({ ecmwf: 3, gfs: 5, radarMm: 12, r3Obs: null }), { Rh: 12, src: 'radar' });
  assert.deepEqual(rhEff({ ecmwf: 3, gfs: 5 }), { Rh: 5, src: 'gfs' });
  assert.deepEqual(rhEff({ ecmwf: 3, gfs: 5, radarMm: 1, r3Obs: 20 }), { Rh: 20, src: 'obs' });
  assert.deepEqual(rhEff({ ecmwf: 4, gfs: 4 }), { Rh: 4, src: 'gfs' }); // ties: obs > radar > gfs > ecmwf (as in SQL)
  assert.deepEqual(rhEff({}), { Rh: null, src: null });
});

test('reportEvent reads the snapshot (radar maxMmH included); groupCells dedupes by source + id', () => {
  const r = { id: 'r', lat: 10.78, lng: 106.7, level: 2, confirms: 2, denies: 1, observed_at: '2026-10-01T03:00:00.000Z',
    snapshot: { features: { ecmwf_ifs: { R3: 2 }, gfs_global: { R3: 'x' } }, radar: { maxMmH: 9, accumMm: 6.5 }, tide: { phuAn: 1.2 } } };
  const e = reportEvent(r);
  assert.deepEqual(e, { id: 'r', source: 'report', lat: 10.78, lng: 106.7, t: '2026-10-01T03:00:00.000Z', level: 2, net: 1, Rh: 6.5, RhSrc: 'radar', PAh: 1.2, cause: null, radarMmH: 9,
    uid: null, enriched: false, r3Obs: null, paObs: null, RhClient: 6.5 });
  const cells = groupCells([e, { ...e }, { ...e, source: 'news' }, null, { ...e, id: 'far', lat: 10.8 }]);
  assert.deepEqual(cells.map((c) => c.events.length), [2, 1]);
});

test('quantile: linear between order statistics', () => {
  assert.equal(quantile([10], 0.25), 10);
  assert.equal(quantile([10, 20, 30, 40, 50], 0.25), 20);
  assert.equal(quantile([10, 20], 0.25), 12.5);
});

test('one event: Tcell = max(Rh, ANALOG_RAIN_MIN); level − 1 from 0.7·Tcell', () => {
  const c = cell([ev(2, 10)]);
  assert.equal(c.rain.T, 10);
  assert.equal(at(c, 9.99).level, 1);
  assert.equal(at(c, 7).level, 1);
  assert.equal(at(c, 6.9).level, 0);
  assert.deepEqual(at(c, 10), { level: 2, threshold: 10, n: 1, verified: 0, m: 1, total: 1, srcs: ['ecmwf'], cause: 'rain' });
  // Light-rain flood: floored at ANALOG_RAIN_MIN (false-alarm guard).
  const light = cell([ev(2, 1)]);
  assert.equal(light.rain.T, 8);
  assert.equal(at(light, 5.5).level, 0);
  assert.equal(at(light, 5.6).level, 1);
  assert.equal(at(light, 8).level, 2);
  assert.equal(at(cell([ev(1, 0)]), 7.9).level, 0); // level − 1 = 0
});

test('many events: Tcell = p25 of Rh_eff; level = median of floods at ≤ R3, else the smallest', () => {
  const c = cell([ev(1, 10), ev(3, 30), ev(2, 20), ev(3, 40), ev(3, 50, { RhSrc: 'radar' })]);
  assert.equal(c.rain.T, 20);
  assert.equal(at(c, 20).level, 1); // floods ≤ 20: levels 1, 2 → lower median 1
  assert.equal(at(c, 30).level, 2); // 1, 2, 3
  assert.equal(at(c, 60).level, 3); // 1, 2, 3, 3, 3
  assert.equal(at(c, 14).level, 0); // 0.7·20 = 14, floods ≤ 14: level 1 → − 1
  const hit = at(c, 60);
  assert.deepEqual([hit.n, hit.m, hit.srcs], [4, 4, ['ecmwf', 'radar']]);
  assert.equal(cellTrigger(hit), 'Ô này ngập 4/4 lần khi mưa 3h ≥ 20.0 mm (nguồn: ECMWF, radar)');
  // No flood at or below R3 (all above Tcell's floor) → smallest level.
  const high = cell([ev(3, 30), ev(2, 31)]);
  assert.equal(high.rain.T, 30.25);
  assert.equal(at(high, 30.25).level, 3); // the 30 mm flood is ≤ 30.25
  assert.equal(at(high, 25).level, 1); // near: none ≤ 25 → min level 2, − 1
});

test('negative samples: more dry events at ≥ R3 than floods at ≤ R3 → one level down', () => {
  const floods = [ev(2, 10), ev(2, 12)];
  assert.equal(at(cell(floods), 12).level, 2);
  const c = cell([...floods, ev(0, 15), ev(0, 20), ev(0, 25)]);
  assert.equal(at(c, 12).level, 1); // 3 dry at ≥ 12 > 2 floods at ≤ 12
  assert.equal(at(c, 20).level, 2); // 2 dry at ≥ 20, not more than 2 floods
  const hit = at(c, 20);
  assert.deepEqual([hit.n, hit.m], [1, 4]); // floods with Rh ≥ Tcell = 10.5 vs all events ≥ 10.5
  assert.equal(at(c, 7.5).level, 0); // near (− 1) and negatives (− 1) → 0
  assert.equal(cell([ev(0, 5)]), null); // dry-only cell: nothing to forecast
});

test('tide: threshold max(p25 PAh, TIDE_START) − tolerance, negatives on PAh; rain ignored', () => {
  const tide = (level, PAh) => ev(level, 0.5, { PAh });
  const c = cell([tide(2, 1.6), tide(1, 1.5), tide(2, 1.7)]);
  assert.equal(c.rain, null);
  assert.ok(Math.abs(c.tide.T - 1.55) < 1e-9);
  assert.equal(at(c, 50, 1.49).level, 0);
  assert.equal(at(c, 50, 1.5).level, 1); // ≥ 1.55 − 0.05; floods ≤ 1.5: level 1
  assert.equal(at(c, 0, 1.7).level, 2);
  assert.equal(at(c, 0, 1.7).cause, 'tide');
  assert.equal(cellTrigger(at(c, 0, 1.7)), 'Ô này ngập 2/2 lần khi triều Phú An ≥ 1.55 m');
  const dryHigh = cell([tide(2, 1.6), ev(0, 0, { PAh: 1.8 }), ev(0, 0, { PAh: 1.9 })]);
  assert.equal(at(dryHigh, 0, 1.6).level, 1); // 2 dry tides at ≥ 1.6 > 1 flood at ≤ 1.6
  assert.equal(cell([tide(2, 1.2)]).tide, null); // below TIDE_START → a rain event, not tide
  assert.equal(cell([ev(2, null, { PAh: 1.2, cause: 'tide' })]).tide.T, 1.4); // article says tide: floored at TIDE_START
});

test('ANALOG_MIN_NET filters events; articles always count', () => {
  assert.equal(cell([ev(2, 10)], 1), null);
  assert.ok(cell([ev(2, 10, { net: null, source: 'news' })], 1));
});

test('news events: point/level/cause/outlets from the record; weather filled from the loaded window', () => {
  const T0 = Date.parse('2026-10-07T18:00:00+07:00');
  const weather = { times: [T0 - 3600_000, T0, T0 + 3600_000], grid: { rows: 2, cols: 2, lats: [10, 11], lngs: [106, 107] }, precip: [0, 1, 2].map((v) => new Float32Array(4).fill(v * 5)), pa: [1.2, 1.6, 1.7] };
  const rec = { id: 'n1', level: 3, cause: 'rain', observedAt: '2026-10-07T18:30:00+07:00', publishedAt: '2026-10-07T19:05:00+07:00', geometry: { point: [10.8, 106.705] }, sources: [{ outlet: 'VnExpress' }, { outlet: 'Tuổi Trẻ' }, { outlet: 'VnExpress' }] };
  const e = newsEvent(rec);
  assert.deepEqual([e.source, e.level, e.cause, e.outlet, e.Rh], ['news', 3, 'rain', 'VnExpress, Tuổi Trẻ', null]);
  const w = withWeather(e, weather);
  assert.deepEqual([w.Rh, w.RhSrc, w.PAh], [5 + 0.6 * 0, 'ecmwf', 1.6]);
  assert.equal(withWeather({ ...e, t: '2026-10-01T08:00:00+07:00' }, weather).Rh, null); // outside the window
  assert.equal(newsEvent({ ...rec, geometry: {} }), null);
});

test('cellTrigger: floor above every recorded Rh reads as history, not "0/0"', async () => {
  const { cellTrigger } = await import('../public/js/format.js');
  const text = cellTrigger({ cause: 'rain', n: 0, m: 0, total: 1, threshold: 8, srcs: ['gfs'] });
  assert.equal(text, 'Ô này từng ngập 1 lần với mưa 3h thấp hơn; dự báo từ ngưỡng tối thiểu 8.0 mm (nguồn: GFS)');
});

test('reportEvent: old snapshot without accumMm → radar term from frames (Σ mmH × 10 min), not the peak rate', () => {
  const mm = [1.33, 48.62, 23.68, 99.85, 48.62, 1.33];
  const frames = mm.map((mmH, i) => ({ time: 1_790_000_000 + i * 600, mmH }));
  const r = { id: 'o', lat: 10.78, lng: 106.7, level: 2, observed_at: '2026-10-01T03:00:00.000Z', snapshot: { radar: { maxMmH: 99.85, frames } } };
  const e = reportEvent(r);
  assert.equal(e.Rh, 37.24);
  assert.equal(e.RhSrc, 'radar');
  assert.equal(e.radarMmH, 99.85);
});
