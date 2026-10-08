// §18 daily post-event enrichment: rain 3 h re-read from Open-Meteo (ERA5 / Historical Forecast) for reports
// 2–10 days old → Supabase table report_enrichment (flood_cells uses max(Rh_eff, r3_obs)).
// Run daily (scripts/register-cron.ps1) or by hand: `npm run enrich`. Needs env SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY;
// without them it does nothing (local demo mode has no server history to enrich).
import { enrichReports } from './lib/enrich.mjs';

const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = process.env;
if (!url || !key) {
  console.log('enrich-reports: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set → skipped');
} else {
  enrichReports({ url, key }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
