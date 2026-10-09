window.FLOOD_CONFIG = {
  // Leave empty to run in local demo mode (reports stored in this browser only).
  supabaseUrl: 'https://pepwrkramglgktxpxtmn.supabase.co',
  supabaseAnonKey: 'sb_publishable_S03u2asi-vU3yZO1x7dgRg_NDAhiR2_',
  // §19a Cloudflare Turnstile site key (public). Empty = no captcha on anonymous sign-in. Setup order: see README.
  turnstileSiteKey: '0x4AAAAAAFSISfBcq-K0-9c2', // public site key (Cloudflare Turnstile widget SgFlood)

  // Crowd trust. Cold start (few users): a report confirms itself, late ones too, and any
  // non-denied past flood counts as a historical analog. With many users set
  // LATE_SELF_CONFIRM: false and ANALOG_MIN_NET: 1.
  crowd: {
    MIN_CONFIDENCE: 1, // confidence (1 + net) needed for a flood report to override the forecast
    LATE_SELF_CONFIRM: true,
    ANALOG_MIN_NET: 0,
    // Hot crowd cluster: distinct people needed (press articles are always enough). Cold start: 1; with many users: 3.
    CLUSTER_MIN_SOURCES: 1,
    CLUSTER_MIN_REPORTS: 1,
    // §18 report lifetime: active (overrides the forecast, counts in hot clusters) for REPORT_TTL_H + 1 h per net
    // confirm, at most REPORT_TTL_MAX_H; then drawn faded for FADE_H more.
    REPORT_TTL_H: 6,
    REPORT_TTL_MAX_H: 12,
    FADE_H: 24,
    // §19b learning gate (display is unaffected): a report feeds history thresholds only with evidence —
    // server rain/tide (r3_obs ≥ EVIDENCE_RAIN_MM / Phú An pa_obs ≥ EVIDENCE_TIDE_M), another user's report or a news
    // item within CORROBORATE_M and ±CORROBORATE_H, or (until enriched) the same thresholds on its client snapshot.
    // Mirrored in supabase/schema.sql flood_cells — change both.
    EVIDENCE_RAIN_MM: 3,
    EVIDENCE_TIDE_M: 1.4,
    CORROBORATE_M: 150,
    CORROBORATE_H: 3,
  },

  // Heuristic model constants — NOT calibrated against observed flooding depth.
  // Tide thresholds are Phú An levels (m, Hòn Dấu datum): BĐ I = 1.40; lag/bias live in public/js/tide.js.
  model: {
    RAIN_START: 3,
    RAIN_FULL: 25,
    TIDE_START: 1.4,
    TIDE_FULL: 1.95,
    HOTSPOT_S: 0.95,
    S_RAIN_BASE: 0.1, // off-hotspot rain susceptibility (flat; no terrain term)
    // §18 history cells (~150 m, past reports + press): rain threshold Tcell = max(p25 of flood Rh_eff, ANALOG_RAIN_MIN);
    // forecast R3 ≥ Tcell → median level of floods at ≤ R3, from ANALOG_NEAR_RATIO · Tcell one level less, and one less
    // again when dry reports outnumber floods. Tide likewise on Phú An, from max(p25, TIDE_START) − ANALOG_TIDE_TOL.
    // An event is tide-driven if Phú An ≥ TIDE_START and Rh_eff < ANALOG_RAIN_MIN when it flooded.
    ANALOG_RAIN_MIN: 8,
    ANALOG_NEAR_RATIO: 0.7,
    ANALOG_TIDE_TOL: 0.05,
  },
};
