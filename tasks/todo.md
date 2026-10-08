# HCMC Flood Map — POC plan

## Decisions (2026-10-08)
- Base map: Leaflet + OSM tiles (no key; CARTO now requires a key). Google Maps swap later.
- Storage: Supabase (anonymous sign-in + RLS + triggers + Realtime). Fallback: localStorage mode when no keys configured.
- Prediction: heuristic (chronic hotspots + ECMWF rain + Vũng Tàu tide + elevation), labelled clearly. Reports carry a weather snapshot (ECMWF + GFS + RainViewer radar pixel + tide) as future training data.
- UI language: Vietnamese.

## Plan
- [x] Research existing solutions + data APIs → `tasks/spec.md`
- [x] Data build script: Overpass + hotspot matching + elevation → `public/data/roads.json` (14,549 segments, 1.7 MB, 25/25 hotspots matched)
- [x] Frontend: map, rain overlay, roads colored by flood level, Windy-style timeline (−24h → +48h), play
- [x] Prediction panel (6/12/24h)
- [x] Crowd reports + confirm/deny votes (Supabase adapter + local fallback), realtime, snapshot, export JSON
- [x] `supabase/schema.sql`
- [x] Verify in browser

## Review (2026-10-08)
Verified in browser (LocalStore mode): load, OSM tiles, hotspot layer, 24h panel (12 tide routes predicted 10–30cm at 02:00 T6), click row → fitBounds + timeline jump, roads recolor, play (2 steps/s), rain overlay, radar toggle loads tiles, report flow + snapshot (all 4 sources captured, radar pixel readable via CORS), crowd override recolors roads within 200 m, vote as a second user, mobile layout. No console errors. `node --test`: 17/17.

Fixed during verification:
- Report markers were unclickable (road canvas renderer swallowed clicks) → own pane + SVG renderer.
- Hotspot dry style too faint → orange dashed.
- Panel peak time lacked the day → `fmtHourDay`.
- Snapshot lacked timezone of its local hourly timestamps.
- Schema: client could set `created_at` (bypass rate limit / extend TTL) → trigger forces `now()`; votes get server-owned `created_at`/`updated_at`. LocalStore votes now carry timestamps.

Not verified: `schema.sql` / `SupabaseStore` / Realtime against a real Supabase project.

### Round 2 (2026-10-08)
- Hotspots v2: 107 points from primary articles (CSGT 122-point list on the city portal, Sở XD lists), geometry between/junction/near; spot-checked 4 quotes against the source. Old radius matching (142 km painted) removed.
- Tide: Phú An from KTTV Nam Bộ bulletins (bias 0.60, n=558, lag 3 h), thresholds on Phú An alert levels. Removed the uncalibrated assumption that predicted 12 tide routes flooding 10–30 cm at a forecast 1.53 m peak (false alarm).
- Terrain: FABDEM (CC BY-NC-SA) replaces the Copernicus DSM. Off-hotspot tide rule disabled after audit (tide hotspots median z 2.0 m > 1.78 m record; 16% of segments ≤ 1.2 m).
- Snapshot: terrain z + Phú An estimate + alert level verified in browser.
- Open: 2 of 14 recent bulletins (6-column layout) not parsed; FABDEM license is non-commercial.

Known POC limitations: hotspot matching by street name + radius is coarse (e.g. Võ Văn Kiệt matches 81 segments); legend can cover markers on mobile; heuristic thresholds uncalibrated.
