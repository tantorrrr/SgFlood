// §19b Evidence-gated learning (pure). Every report is still DISPLAYED (reports.js / crowd config); only events with
// evidence feed the history-cell thresholds (cells.js prepareCell). Mirrored in supabase/schema.sql view flood_cells:
// keep thresholds, distance formula and precedence identical in both places.
//   evidence precedence: press (news) → obs_rain (r3_obs ≥ EVIDENCE_RAIN_MM) → obs_tide (pa_obs ≥ EVIDENCE_TIDE_M)
//   → corroborated (another user's valid report or a news item within CORROBORATE_M and ±CORROBORATE_H)
//   → only while NOT enriched: client_rain (snapshot Rh_eff ≥ EVIDENCE_RAIN_MM) / client_tide (snapshot PAh ≥ EVIDENCE_TIDE_M).
//   trust: press/obs_*/corroborated → 'trusted'; client_* → 'provisional'; none → 'untrusted'.
// Dry reports (level 0) go through the same gate.

export const TRUST_DEFAULTS = { EVIDENCE_RAIN_MM: 3, EVIDENCE_TIDE_M: 1.4, CORROBORATE_M: 150, CORROBORATE_H: 3 };
const M_PER_DEG = 111320;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Equirectangular metres (same formula as the SQL mirror; fine at 150 m).
export function nearM(a, b) {
  const dy = (a.lat - b.lat) * M_PER_DEG;
  const dx = (a.lng - b.lng) * M_PER_DEG * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dx * dx + dy * dy);
}

const TRUST = { press: 'trusted', obs_rain: 'trusted', obs_tide: 'trusted', corroborated: 'trusted', client_rain: 'provisional', client_tide: 'provisional' };

// ev: report event with internals {uid, enriched, r3Obs, paObs, RhClient, PAh}; peers: other valid events (reports
// already exclude withdrawn/denied) incl. news. Returns the evidence key or null.
export function evidenceOf(ev, peers, cfg = TRUST_DEFAULTS) {
  if (ev.source === 'news') return 'press';
  if (ev.enriched && isNum(ev.r3Obs) && ev.r3Obs >= cfg.EVIDENCE_RAIN_MM) return 'obs_rain';
  if (ev.enriched && isNum(ev.paObs) && ev.paObs >= cfg.EVIDENCE_TIDE_M) return 'obs_tide';
  const t = Date.parse(ev.t);
  const corroborates = (p) => p !== ev && (p.source === 'news' || (p.source === 'report' && p.uid != null && p.uid !== ev.uid))
    && Math.abs(Date.parse(p.t) - t) <= cfg.CORROBORATE_H * 3_600_000 && nearM(ev, p) <= cfg.CORROBORATE_M;
  if (peers.some(corroborates)) return 'corroborated';
  if (ev.enriched) return null; // server result replaces the (spoofable) client snapshot
  if (isNum(ev.RhClient) && ev.RhClient >= cfg.EVIDENCE_RAIN_MM) return 'client_rain';
  if (isNum(ev.PAh) && ev.PAh >= cfg.EVIDENCE_TIDE_M) return 'client_tide';
  return null;
}

export const trustOf = (evidence) => TRUST[evidence] ?? 'untrusted';

// Adds {trust, evidence} to events lacking them and strips the internal fields (same shape as flood_cells events).
export function withTrust(events, cfg = TRUST_DEFAULTS) {
  const list = events.filter(Boolean);
  return list.map((ev) => {
    const { uid, enriched, r3Obs, paObs, RhClient, ...out } = ev;
    if (ev.trust) return out;
    const evidence = evidenceOf(ev, list, cfg);
    return { ...out, trust: trustOf(evidence), evidence };
  });
}

// Events without a trust field (press file, pre-§19 server view) count as trusted.
export const isLearnable = (e) => e.trust !== 'untrusted';
