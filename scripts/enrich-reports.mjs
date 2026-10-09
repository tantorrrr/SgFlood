// §18 daily post-event enrichment: rain 3 h re-read from Open-Meteo (ERA5 / Historical Forecast) for reports
// 2–10 days old → Supabase table report_enrichment (flood_cells uses max(Rh_eff, r3_obs)).
// Run daily (scripts/register-cron.ps1) or by hand: `npm run enrich`. Needs env SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY;
// without them it does nothing (local demo mode has no server history to enrich).
import { readFile } from 'node:fs/promises';
import { enrichReports } from './lib/enrich.mjs';

// §19b observed Phú An (pa_obs); missing file → pa_obs null, rain enrichment still runs.
async function loadTide() {
  try {
    return JSON.parse(await readFile(new URL('../public/data/tide-phuan.json', import.meta.url), 'utf8'));
  } catch (err) {
    console.log(`enrich-reports: tide-phuan.json unreadable (${err.message}) → pa_obs null`);
    return null;
  }
}

const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = process.env;
if (!url || !key) {
  console.log('enrich-reports: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set → skipped');
} else {
  loadTide().then((tide) => enrichReports({ url, key, tide })).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
