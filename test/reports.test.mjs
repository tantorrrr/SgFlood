import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportState, applyCrowd, crowdEffects, checkObservedAt, isLate, editBlock, checkEditObservedAt, MAX_EDITS } from '../public/js/reports.js';
import { BucketIndex } from '../public/js/geo.js';

const H = 3600_000;
const T0 = Date.parse('2026-10-08T07:00:00Z');
const rep = (extra) => ({ id: 'r', lat: 10.78, lng: 106.7, level: 2, created_at: new Date(T0).toISOString(), confirms: 0, denies: 0, ...extra });

test('base TTL is 6h', () => {
  assert.equal(reportState(rep(), T0 - 1).active, false);
  assert.equal(reportState(rep(), T0).active, true);
  assert.equal(reportState(rep(), T0 + 6 * H - 1).active, true);
  assert.equal(reportState(rep(), T0 + 6 * H).active, false);
});

test('TTL grows 1h per net confirm, capped at 12h; crowd config overrides', () => {
  assert.equal(reportState(rep({ confirms: 2 }), T0).ttlMs, 8 * H);
  assert.equal(reportState(rep({ confirms: 10 }), T0).ttlMs, 12 * H);
  assert.equal(reportState(rep({ confirms: 1, denies: 1 }), T0).ttlMs, 6 * H);
  assert.equal(reportState(rep({ confirms: 3 }), T0).confidence, 4);
  const crowd = { REPORT_TTL_H: 2, REPORT_TTL_MAX_H: 4 };
  assert.equal(reportState(rep({ confirms: 1 }), T0, crowd).ttlMs, 3 * H);
  assert.equal(reportState(rep({ confirms: 9 }), T0, crowd).ttlMs, 4 * H);
});

test('§18 fade: FADE_H after the TTL the report is faded (not active), then gone; denied never fades', () => {
  const st = (t, extra, crowd) => reportState(rep(extra), t, crowd);
  assert.equal(st(T0 + 6 * H - 1).faded, false);
  assert.deepEqual([st(T0 + 6 * H).active, st(T0 + 6 * H).faded], [false, true]);
  assert.equal(st(T0 + 30 * H - 1).faded, true);
  assert.equal(st(T0 + 30 * H).faded, false);
  assert.equal(st(T0 + 9 * H, { confirms: 2 }).faded, true);
  assert.equal(st(T0 + 8 * H - 1, { confirms: 2 }).faded, false);
  assert.equal(st(T0 + 7 * H, {}, { FADE_H: 1 }).faded, false);
  assert.equal(st(T0 + 7 * H, { denies: 2 }).faded, false);
  assert.equal(st(T0 - 1).faded, false);
});

test('hidden when denies >= confirms + 2', () => {
  assert.equal(reportState(rep({ denies: 1 }), T0).hidden, false);
  const st = reportState(rep({ confirms: 1, denies: 3 }), T0);
  assert.equal(st.hidden, true);
  assert.equal(st.active, false);
});

test('flood report raises predicted level', () => {
  assert.deepEqual(applyCrowd(0, [{ level: 2, confidence: 1 }]), { level: 2, confirmedBy: 1, cleared: false });
  assert.equal(applyCrowd(3, [{ level: 1, confidence: 1 }]).level, 3);
  assert.equal(applyCrowd(0, [{ level: 2, confidence: 0 }]).level, 0);
});

test('dry report caps level at 1 only with confidence >= 2', () => {
  assert.equal(applyCrowd(3, [{ level: 0, confidence: 1 }]).level, 3);
  assert.deepEqual(applyCrowd(3, [{ level: 0, confidence: 2 }]), { level: 1, confirmedBy: 0, cleared: true });
  assert.equal(applyCrowd(0, []).level, 0);
});

test('crowdEffects reaches segments within 200 m only', () => {
  const segs = [
    { c: [[10.78, 106.699], [10.78, 106.701]] },
    { c: [[10.7815, 106.699], [10.7815, 106.701]] },
    { c: [[10.79, 106.699], [10.79, 106.701]] },
  ];
  const index = new BucketIndex();
  segs.forEach((s, i) => index.add(i, s.c));
  const effects = crowdEffects([rep()], segs, index, T0 + H);
  assert.deepEqual([...effects.keys()].sort(), [0, 1]);
  assert.equal(crowdEffects([rep()], segs, index, T0 + 7 * H).size, 0); // faded reports never override
});

test('checkObservedAt allows [now − 48h, now + 2 min], clamped to now', () => {
  assert.equal(checkObservedAt(T0 - 48 * H, T0), T0 - 48 * H);
  assert.equal(checkObservedAt(T0 - 48 * H - 1, T0), null);
  assert.equal(checkObservedAt(T0 + 2 * 60_000, T0), T0);
  assert.equal(checkObservedAt(T0 + 2 * 60_000 + 1, T0), null);
  assert.equal(checkObservedAt(NaN, T0), null);
});

test('late = sent more than 15 min after observed_at; missing observed_at means on time', () => {
  const at = (min) => new Date(T0 - min * 60_000).toISOString();
  assert.equal(isLate(rep({ observed_at: at(15) })), false);
  assert.equal(isLate(rep({ observed_at: at(16) })), true);
  assert.equal(isLate(rep()), false);
});

test('late report: TTL from observed_at, confidence = net', () => {
  const late = rep({ observed_at: new Date(T0 - 7 * H).toISOString() });
  assert.equal(reportState(late, T0 - 4 * H).active, true);
  assert.equal(reportState(late, T0).active, false);
  assert.equal(reportState(late, T0 - 4 * H).confidence, 0);
  assert.equal(applyCrowd(0, [{ level: 2, confidence: reportState(late, T0 - 4 * H).confidence }]).level, 0);
  const confirmed = { ...late, confirms: 1 };
  assert.equal(reportState(confirmed, T0 - 4 * H).confidence, 1);
  assert.equal(applyCrowd(0, [{ level: 2, confidence: 1 }]).level, 2);
  const recentLate = rep({ observed_at: new Date(T0 - 30 * 60_000).toISOString() });
  assert.equal(reportState(recentLate, T0).active, true);
  assert.equal(reportState(recentLate, T0).late, true);
});

test('editBlock: votes lock edits, max 5 edits, withdrawn is final', () => {
  assert.equal(editBlock(rep()), null);
  assert.equal(editBlock(rep({ denies: 1 })), 'has_votes');
  assert.equal(editBlock(rep({ edit_count: MAX_EDITS - 1 })), null);
  assert.equal(editBlock(rep({ edit_count: MAX_EDITS })), 'edit_limit');
  assert.equal(editBlock(rep({ withdrawn_at: new Date(T0).toISOString() })), 'withdrawn');
});

test('checkEditObservedAt is anchored at the original created_at', () => {
  assert.equal(checkEditObservedAt(T0 - 47 * H, rep()), T0 - 47 * H);
  assert.equal(checkEditObservedAt(T0 - 49 * H, rep()), null);
  assert.equal(checkEditObservedAt(T0 + 60_000, rep()), T0);
  assert.equal(checkEditObservedAt(T0 + H, rep()), null);
});

test('cold start: LATE_SELF_CONFIRM counts the sender of a late report, MIN_CONFIDENCE gates overrides', () => {
  const late = rep({ created_at: new Date(T0).toISOString(), observed_at: new Date(T0 - 5 * H).toISOString() });
  const cold = { MIN_CONFIDENCE: 1, LATE_SELF_CONFIRM: true };
  assert.equal(reportState(late, T0 - 4 * H, cold).confidence, 1);
  assert.equal(reportState(late, T0 - 4 * H, { LATE_SELF_CONFIRM: false }).confidence, 0);
  assert.equal(applyCrowd(0, [{ level: 2, confidence: 1 }], 1).level, 2);
  assert.equal(applyCrowd(0, [{ level: 2, confidence: 1 }], 2).level, 0);
  assert.equal(applyCrowd(3, [{ level: 0, confidence: 2 }], 2).cleared, false);
  assert.equal(applyCrowd(3, [{ level: 0, confidence: 3 }], 2).level, 1);
  const denied = reportState(rep({ confirms: 0, denies: 2 }), T0, cold);
  assert.equal(denied.hidden, true);
  assert.equal(denied.active, false);
});
