import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStore } from '../public/js/store.js';

class MemoryStorage {
  map = new Map();
  getItem(k) { return this.map.get(k) ?? null; }
  setItem(k, v) { this.map.set(k, String(v)); }
}

const SNAP = { features: { ecmwf_ifs: { R3: 4 }, gfs_global: { R3: 9 } } };

async function makeStore(storage = new MemoryStorage(), clock = { t: Date.parse('2026-10-08T07:00:00Z') }) {
  const store = new LocalStore(storage, () => clock.t);
  await store.init();
  return { store, storage, clock };
}

test('rejects a second report within 60 s', async () => {
  const { store, clock } = await makeStore();
  await store.createReport({ lat: 10.78, lng: 106.7, level: 2 });
  clock.t += 30_000;
  await assert.rejects(store.createReport({ lat: 10.78, lng: 106.7, level: 2 }), { code: 'rate_limited' });
  clock.t += 31_000;
  await store.createReport({ lat: 10.78, lng: 106.7, level: 1 });
});

test('allows at most 10 reports per hour', async () => {
  const { store, clock } = await makeStore();
  for (let i = 0; i < 10; i++) {
    await store.createReport({ lat: 10.78, lng: 106.7, level: 1 });
    clock.t += 61_000;
  }
  await assert.rejects(store.createReport({ lat: 10.78, lng: 106.7, level: 1 }), { code: 'rate_limited' });
  clock.t += 3600_000;
  await store.createReport({ lat: 10.78, lng: 106.7, level: 1 });
});

test('votes: one per user (changeable), not on own report', async () => {
  const storage = new MemoryStorage();
  const clock = { t: Date.parse('2026-10-08T07:00:00Z') };
  const { store: alice } = await makeStore(storage, clock);
  const report = await alice.createReport({ lat: 10.78, lng: 106.7, level: 3 });
  await assert.rejects(alice.vote(report.id, 1), { code: 'own_report' });

  storage.setItem('hcmflood.user', JSON.stringify('bob'));
  const { store: bob } = await makeStore(storage, clock);
  await bob.vote(report.id, 1);
  await bob.vote(report.id, -1);
  const [listed] = await bob.listReports();
  assert.deepEqual([listed.confirms, listed.denies, listed.myVote], [0, 1, -1]);
});

test('observed_at: defaults to now, rejects outside 48h, max 3 late reports per 24h', async () => {
  const { store, clock } = await makeStore();
  const first = await store.createReport({ lat: 10.78, lng: 106.7, level: 2 });
  assert.equal(first.observed_at, first.created_at);
  clock.t += 61_000;
  await assert.rejects(store.createReport({ lat: 10.78, lng: 106.7, level: 2, observedAt: clock.t - 49 * 3600_000 }), { code: 'invalid_time' });
  await assert.rejects(store.createReport({ lat: 10.78, lng: 106.7, level: 2, observedAt: clock.t + 5 * 60_000 }), { code: 'invalid_time' });
  for (let i = 0; i < 3; i++) {
    await store.createReport({ lat: 10.78, lng: 106.7, level: 2, observedAt: clock.t - 3600_000 });
    clock.t += 61_000;
  }
  await assert.rejects(store.createReport({ lat: 10.78, lng: 106.7, level: 2, observedAt: clock.t - 3600_000 }), { code: 'late_limited' });
  await store.createReport({ lat: 10.78, lng: 106.7, level: 1, observedAt: clock.t - 10 * 60_000 });
  clock.t += 24 * 3600_000;
  const r = await store.createReport({ lat: 10.78, lng: 106.7, level: 2, observedAt: clock.t - 3600_000 });
  assert.equal(r.observed_at, new Date(clock.t - 3600_000).toISOString());
});

test('editReport: owner only, no votes, max 5 edits, time anchored at created_at', async () => {
  const storage = new MemoryStorage();
  const clock = { t: Date.parse('2026-10-08T07:00:00Z') };
  const { store: alice } = await makeStore(storage, clock);
  const r = await alice.createReport({ lat: 10.78, lng: 106.7, level: 2, snapshot: { v: 1 } });
  const created = Date.parse(r.created_at);
  clock.t += 3600_000;
  const e = await alice.editReport(r.id, { lat: 10.79, lng: 106.71, level: 3, observedAt: created - 1800_000 });
  assert.deepEqual([e.lat, e.level, e.edit_count, e.created_at, e.edited_at], [10.79, 3, 1, r.created_at, new Date(clock.t).toISOString()]);
  assert.deepEqual(e.snapshot, { v: 1 });
  await assert.rejects(alice.editReport(r.id, { lat: 10.78, lng: 106.7, level: 2, observedAt: clock.t }), { code: 'invalid_time' });
  await assert.rejects(alice.editReport(r.id, { lat: 10.78, lng: 106.7, level: 2, observedAt: created - 49 * 3600_000 }), { code: 'invalid_time' });
  for (let i = 0; i < 4; i++) await alice.editReport(r.id, { lat: 10.78, lng: 106.7, level: 1, observedAt: created });
  await assert.rejects(alice.editReport(r.id, { lat: 10.78, lng: 106.7, level: 1, observedAt: created }), { code: 'edit_limit' });

  clock.t += 61_000;
  const r2 = await alice.createReport({ lat: 10.78, lng: 106.7, level: 2 });
  storage.setItem('hcmflood.user', JSON.stringify('bob'));
  const { store: bob } = await makeStore(storage, clock);
  await assert.rejects(bob.editReport(r2.id, { lat: 10.78, lng: 106.7, level: 1, observedAt: Date.parse(r2.created_at) }), { code: 'not_owner' });
  await bob.vote(r2.id, 1);
  await assert.rejects(alice.editReport(r2.id, { lat: 10.78, lng: 106.7, level: 1, observedAt: Date.parse(r2.created_at) }), { code: 'has_votes' });
});

test('editReport: switching to late counts against 3 late reports per 24h', async () => {
  const { store, clock } = await makeStore();
  for (let i = 0; i < 3; i++) {
    await store.createReport({ lat: 10.78, lng: 106.7, level: 2, observedAt: clock.t - 3600_000 });
    clock.t += 61_000;
  }
  const r = await store.createReport({ lat: 10.78, lng: 106.7, level: 2 });
  const created = Date.parse(r.created_at);
  await assert.rejects(store.editReport(r.id, { lat: 10.78, lng: 106.7, level: 2, observedAt: created - 3600_000 }), { code: 'late_limited' });
  await store.editReport(r.id, { lat: 10.78, lng: 106.7, level: 2, observedAt: created - 10 * 60_000 });
});

test('withdrawReport: soft delete hides from lists, kept flagged in export, allowed with votes', async () => {
  const storage = new MemoryStorage();
  const clock = { t: Date.parse('2026-10-08T07:00:00Z') };
  const { store: alice } = await makeStore(storage, clock);
  const r = await alice.createReport({ lat: 10.78, lng: 106.7, level: 2, snapshot: SNAP });
  storage.setItem('hcmflood.user', JSON.stringify('bob'));
  const { store: bob } = await makeStore(storage, clock);
  await bob.vote(r.id, 1);
  await assert.rejects(bob.withdrawReport(r.id), { code: 'not_owner' });
  storage.setItem('hcmflood.user', JSON.stringify(alice.userId));
  await alice.withdrawReport(r.id);
  assert.equal((await alice.listReports()).length, 0);
  assert.equal((await alice.listCells()).length, 0);
  const { reports } = await alice.exportAll();
  assert.equal(reports[0].withdrawn_at, new Date(clock.t).toISOString());
  await assert.rejects(alice.editReport(r.id, { lat: 10.78, lng: 106.7, level: 1, observedAt: clock.t }), { code: 'withdrawn' });
});

test('§18 listCells: reports with a snapshot per ~150 m cell, kept 730 days (client applies ANALOG_MIN_NET)', async () => {
  const { store, clock } = await makeStore();
  const start = clock.t;
  await store.createReport({ lat: 10.78, lng: 106.7, level: 2, snapshot: SNAP });
  clock.t += 61_000;
  await store.createReport({ lat: 10.7801, lng: 106.7001, level: 0, snapshot: SNAP });
  clock.t += 61_000;
  await store.createReport({ lat: 10.78, lng: 106.7, level: 3 }); // no snapshot → no weather → not history
  const [cell, ...rest] = await store.listCells();
  assert.equal(rest.length, 0);
  assert.deepEqual(cell.events.map((e) => [e.level, e.net, e.Rh, e.RhSrc]), [[2, 0, 9, 'gfs'], [0, 0, 9, 'gfs']]);
  clock.t = start + 729 * 24 * 3600_000;
  assert.equal((await store.listCells()).length, 1, 'past the old 30-day limit');
  clock.t = start + 731 * 24 * 3600_000;
  assert.equal((await store.listCells()).length, 0);
});
