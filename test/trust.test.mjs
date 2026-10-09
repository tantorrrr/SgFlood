import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceOf, withTrust, isLearnable, nearM, TRUST_DEFAULTS } from '../public/js/trust.js';
import { reportEvent, groupCells, prepareCell, cellLevel } from '../public/js/cells.js';
import { paObservedAt } from '../public/js/tide.js';

const T0 = Date.parse('2026-10-01T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const snap = ({ R3 = 0, pa = 0.5 } = {}) => ({ features: { ecmwf_ifs: { R3 } }, tide: { phuAn: pa } });
const rep = (id, o = {}) => ({ id, user_id: o.uid ?? id, lat: o.lat ?? 10.78, lng: o.lng ?? 106.7, level: o.level ?? 2,
  created_at: iso(o.t ?? T0), observed_at: iso(o.t ?? T0), snapshot: snap(o), confirms: o.confirms ?? 0, denies: o.denies ?? 0,
  withdrawn_at: o.withdrawn ? iso(T0) : null });
const trustOfOne = (r, others = [], enr = null) => withTrust([reportEvent(r, enr), ...others.map((o) => reportEvent(o))])[0];

test('news is trusted press; untrusted events excluded from learning', () => {
  assert.equal(evidenceOf({ source: 'news' }, []), 'press');
  assert.equal(isLearnable({ trust: 'untrusted' }), false);
  assert.equal(isLearnable({ trust: 'provisional' }), true);
  assert.equal(isLearnable({ source: 'news' }), true);
});

test('server observations: r3_obs ≥ 3 → obs_rain, pa_obs ≥ 1.40 → obs_tide; enrichment overrides the snapshot', () => {
  assert.deepEqual(pick(trustOfOne(rep('a'), [], { r3_obs: 3, pa_obs: null })), ['trusted', 'obs_rain']);
  assert.deepEqual(pick(trustOfOne(rep('a'), [], { r3_obs: 0.2, pa_obs: 1.42 })), ['trusted', 'obs_tide']);
  // Spoofed snapshot (R3 = 50) only counts until enrichment says otherwise.
  assert.deepEqual(pick(trustOfOne(rep('a', { R3: 50 }))), ['provisional', 'client_rain']);
  assert.deepEqual(pick(trustOfOne(rep('a', { R3: 50 }), [], { r3_obs: 0.5, pa_obs: 0.9 })), ['untrusted', null]);
  assert.deepEqual(pick(trustOfOne(rep('a', { pa: 1.45 }))), ['provisional', 'client_tide']);
  assert.deepEqual(pick(trustOfOne(rep('a', { R3: 1 }))), ['untrusted', null]);
});

const pick = (e) => [e.trust, e.evidence];

test('corroboration: another user within 150 m and ±3 h; same user, withdrawn or denied do not count', () => {
  const near = { lat: 10.78 + 100 / 111320, t: T0 + 2.5 * 3_600_000 };
  assert.ok(nearM({ lat: 10.78, lng: 106.7 }, { lat: near.lat, lng: 106.7 }) < 150);
  assert.deepEqual(pick(trustOfOne(rep('a'), [rep('b', near)])), ['trusted', 'corroborated']);
  assert.deepEqual(pick(trustOfOne(rep('a'), [rep('b', { ...near, uid: 'a' })])), ['untrusted', null], 'same user');
  assert.deepEqual(pick(trustOfOne(rep('a'), [rep('b', { ...near, withdrawn: true })])), ['untrusted', null], 'withdrawn');
  assert.deepEqual(pick(trustOfOne(rep('a'), [rep('b', { ...near, denies: 2 })])), ['untrusted', null], 'denied');
  assert.deepEqual(pick(trustOfOne(rep('a'), [rep('b', { lat: 10.78 + 200 / 111320 })])), ['untrusted', null], 'too far');
  assert.deepEqual(pick(trustOfOne(rep('a'), [rep('b', { t: T0 + 4 * 3_600_000 })])), ['untrusted', null], 'too late');
  // A news item corroborates (and corroboration beats an enrichment with no evidence).
  const news = { source: 'news', id: 'n', lat: 10.78, lng: 106.7005, t: iso(T0 + 3_600_000), level: 2 };
  const [ev] = withTrust([reportEvent(rep('a'), { r3_obs: 0, pa_obs: 0 }), news]);
  assert.deepEqual(pick(ev), ['trusted', 'corroborated']);
  assert.ok(!('uid' in ev) && !('enriched' in ev) && !('RhClient' in ev), 'internals stripped');
});

test('dry reports go through the same gate; untrusted events are not learned but cells still list them', () => {
  assert.deepEqual(pick(trustOfOne(rep('d', { level: 0, R3: 1 }))), ['untrusted', null]);
  assert.deepEqual(pick(trustOfOne(rep('d', { level: 0, R3: 20 }))), ['provisional', 'client_rain']);
  const model = { ANALOG_RAIN_MIN: 8, ANALOG_NEAR_RATIO: 0.7, ANALOG_TIDE_TOL: 0.05, TIDE_START: 1.4 };
  const events = withTrust([rep('a', { R3: 1 }), rep('b', { R3: 1, lng: 106.75 })].map((r) => reportEvent(r)));
  const [cell] = groupCells(events);
  assert.equal(cell.events.length, 1, 'still present (displayed)');
  assert.equal(prepareCell({ ...cell, events: cell.events.filter(isLearnable) }, model), null, 'nothing learned');
  const good = withTrust([reportEvent(rep('a', { R3: 12 }), { r3_obs: 12, pa_obs: null })]);
  const c = prepareCell(groupCells(good)[0], model);
  const hit = cellLevel(c, 12, null, model);
  assert.deepEqual([hit.level, hit.n, hit.verified], [2, 1, 1]);
  assert.equal(TRUST_DEFAULTS.EVIDENCE_TIDE_M, 1.4);
});

test('paObservedAt: cosine between observed extremes; null outside or across gaps', () => {
  const obs = [{ t: '2026-10-01T06:00:00+07:00', h: 1.5, kind: 'peak' }, { t: '2026-10-01T12:00:00+07:00', h: -0.5, kind: 'low' }];
  assert.equal(paObservedAt(obs, Date.parse('2026-10-01T06:00:00+07:00')), 1.5);
  assert.equal(paObservedAt(obs, Date.parse('2026-10-01T09:00:00+07:00')), 0.5);
  assert.equal(paObservedAt(obs, Date.parse('2026-10-01T13:00:00+07:00')), null);
  assert.equal(paObservedAt(obs, Date.parse('2026-10-01T09:00:00+07:00'), 5), null);
});
