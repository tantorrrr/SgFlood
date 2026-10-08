# Lessons

## 2026-10-08 — Chronic flood hotspots rendered wrong
- **Pattern**: Turned text sources ("Lê Đức Thọ từ Phạm Văn Chiêu đến Cầu Cụt") into "street name + guessed center + km radius". This dropped the stretch endpoints and painted whole streets (142 km for 25 points). I even saw "81 segments for one intersection" during verification and filed it as a "limitation" instead of a defect.
- **Rule**: When turning text into geodata, keep the granularity the source gives (endpoints, intersection, house number). Coordinates must come from a lookup (OSM/Nominatim), never be estimated. Before calling it done, check the output against a reality yardstick (one flood point ≈ 100–500 m, so total length must match). A number that is off by orders of magnitude is a bug, not a limitation.
- **Rule**: Verifying a data-driven POC = checking the data is correct, not only that the UI renders it.

## 2026-10-08 — Test report written to the user's real Supabase
- **Pattern**: I created a test report through the UI without re-checking `public/config.js`. The user had already added a real Supabase URL/key, so the test data landed in their production DB.
- **Rule**: Before any test that writes data (report, vote, edit), check which backend the app is pointing at (config + the `sb-*` localStorage key). If it is the user's real backend, ask first or test in a separate local mode. Always brief subagents not to write to the real backend.
