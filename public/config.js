window.FLOOD_CONFIG = {
  // Leave empty to run in local demo mode (reports stored in this browser only).
  supabaseUrl: 'https://pepwrkramglgktxpxtmn.supabase.co',
  supabaseAnonKey: 'sb_publishable_S03u2asi-vU3yZO1x7dgRg_NDAhiR2_',

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
  },

  // Heuristic model constants — NOT calibrated against observed flooding depth.
  // Tide thresholds are Phú An levels (m, Hòn Dấu datum): BĐ I = 1.40; lag/bias live in public/js/tide.js.
  // Terrain z = FABDEM (m, Hòn Dấu), lowest point along each segment.
  model: {
    RAIN_START: 3,
    RAIN_FULL: 25,
    TIDE_START: 1.4,
    TIDE_FULL: 1.95,
    HOTSPOT_S: 0.95,
    S_RAIN_BASE: 0.1, // off-hotspot rain susceptibility on high ground
    S_RAIN_LOW: 0.35, // extra rain susceptibility on low ground
    Z_LOW: 1.0,
    Z_HIGH: 3.0,
    Z_TIDE: 1.2, // off-hotspot segments at or below this can pond at high tide
    // Off by default: chronic tide hotspots sit at median z ≈ 2.0 m (above the 1.78 m record),
    // while 16% of all segments are ≤ 1.2 m — DTM height does not predict tide flooding here.
    S_TIDE_LOW: 0,
    // §18 history cells (~150 m, past reports + press): rain threshold Tcell = max(p25 of flood Rh_eff, ANALOG_RAIN_MIN);
    // forecast R3 ≥ Tcell → median level of floods at ≤ R3, from ANALOG_NEAR_RATIO · Tcell one level less, and one less
    // again when dry reports outnumber floods. Tide likewise on Phú An, from max(p25, TIDE_START) − ANALOG_TIDE_TOL.
    // An event is tide-driven if Phú An ≥ TIDE_START and Rh_eff < ANALOG_RAIN_MIN when it flooded.
    ANALOG_RAIN_MIN: 8,
    ANALOG_NEAR_RATIO: 0.7,
    ANALOG_TIDE_TOL: 0.05,
  },
};
