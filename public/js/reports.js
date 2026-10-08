import { pointToPathM } from './geo.js';

const HOUR = 3600_000;
// §18 defaults for FLOOD_CONFIG.crowd REPORT_TTL_H / REPORT_TTL_MAX_H / FADE_H.
export const BASE_TTL_MS = 6 * HOUR;
export const MAX_TTL_MS = 12 * HOUR;
export const FADE_MS = 24 * HOUR;
export const INFLUENCE_M = 200;
export const LATE_MS = 15 * 60_000;
export const BACKDATE_MS = 48 * HOUR;
export const FUTURE_SKEW_MS = 2 * 60_000;

export const observedMs = (report) => Date.parse(report.observed_at ?? report.created_at);
export const isLate = (report) => Date.parse(report.created_at) - observedMs(report) > LATE_MS;

// Mirrors the server trigger: observed_at within [now − 48h, now + 2 min], clamped to now.
export function checkObservedAt(observed, now) {
  if (!Number.isFinite(observed) || observed < now - BACKDATE_MS || observed > now + FUTURE_SKEW_MS) return null;
  return Math.min(observed, now);
}

export const MAX_EDITS = 5;
export const isWithdrawn = (report) => report.withdrawn_at != null;

// Why the owner may not edit (null = editable). Votes are tied to the old place/level, so any vote locks it.
export function editBlock(report) {
  if (isWithdrawn(report)) return 'withdrawn';
  if ((report.confirms ?? 0) + (report.denies ?? 0) > 0) return 'has_votes';
  if ((report.edit_count ?? 0) >= MAX_EDITS) return 'edit_limit';
  return null;
}

// Edit keeps the §11 rule anchored at the original created_at: observed_at in [created_at − 48h, created_at].
export const checkEditObservedAt = (observed, report) => checkObservedAt(observed, Date.parse(report.created_at));

export const isDenied = (report) => (report.denies ?? 0) >= (report.confirms ?? 0) + 2;

// TTL = REPORT_TTL_H + 1 h per net confirm, capped at REPORT_TTL_MAX_H.
export function reportTtlMs(net, crowd = {}) {
  const base = crowd.REPORT_TTL_H == null ? BASE_TTL_MS : crowd.REPORT_TTL_H * HOUR;
  const max = crowd.REPORT_TTL_MAX_H == null ? MAX_TTL_MS : crowd.REPORT_TTL_MAX_H * HOUR;
  return Math.min(max, base + HOUR * Math.max(0, net));
}

// crowd = FLOOD_CONFIG.crowd; LATE_SELF_CONFIRM lets a late report count its sender like an on-time one.
// faded: within FADE_H after the TTL — drawn faint only (no override, no hot cluster).
export function reportState(report, t, crowd = {}) {
  const confirms = report.confirms ?? 0;
  const denies = report.denies ?? 0;
  const net = confirms - denies;
  const ttlMs = reportTtlMs(net, crowd);
  const fadeMs = crowd.FADE_H == null ? FADE_MS : crowd.FADE_H * HOUR;
  const start = observedMs(report);
  const late = isLate(report);
  const hidden = isDenied(report);
  const active = !hidden && start <= t && t < start + ttlMs;
  const faded = !hidden && t >= start + ttlMs && t < start + ttlMs + fadeMs;
  return { net, confidence: late && !crowd.LATE_SELF_CONFIRM ? net : 1 + net, ttlMs, hidden, active, faded, late };
}

export function crowdEffects(reports, segs, index, t, crowd = {}) {
  const effects = new Map();
  for (const report of reports) {
    const state = reportState(report, t, crowd);
    if (!state.active) continue;
    for (const i of index.near(report.lat, report.lng)) {
      if (pointToPathM([report.lat, report.lng], segs[i].c) > INFLUENCE_M) continue;
      const list = effects.get(i) ?? [];
      list.push({ level: report.level, confidence: state.confidence });
      effects.set(i, list);
    }
  }
  return effects;
}

export function applyCrowd(predLevel, effects = [], minConfidence = 1) {
  let level = predLevel;
  let confirmedBy = 0;
  let cleared = false;
  for (const e of effects) {
    if (e.level > 0 && e.confidence >= minConfidence) {
      level = Math.max(level, e.level);
      confirmedBy = Math.max(confirmedBy, e.confidence);
    }
  }
  if (!confirmedBy && effects.some((e) => e.level === 0 && e.confidence >= minConfidence + 1)) {
    level = Math.min(level, 1);
    cleared = true;
  }
  return { level, confirmedBy, cleared };
}
