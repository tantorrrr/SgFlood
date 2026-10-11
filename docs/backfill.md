# Press backfill (one month at a time)

Goal: add heavy street-flood mentions from HCMC press for month M (YYYY-MM) to `public/data/news-floods.json`,
each with its own `weather` (ERA5 rain 3 h + observed Phú An peak) so it feeds the learned thresholds.
No API key needed: the agent does the extraction itself and passes it via `--llm-responses`.

1. **Find articles for M.** Search tag/archive pages of Tuổi Trẻ, Thanh Niên, VnExpress, Dân Trí, SGGP, VietNamNet
   (e.g. tags "ngập", "triều cường", "mưa lớn TP.HCM"; site search limited to M). Keep only articles about
   specific HCMC streets flooding. Write `<scratch>/M/urls.txt`, one URL per line (`#` comments allowed).
2. **Fetch text.** `curl -sL <url> -o <scratch>/M/html/<n>.html` per URL (gently, a few seconds apart). Read the
   article body; check it has `article:published_time` meta (otherwise the run would stamp it "now" — skip it).
3. **Write extraction JSON** per article at `<scratch>/M/resp/<sha1(url)>.json`
   (`node -e "console.log(require('crypto').createHash('sha1').update(process.argv[1]).digest('hex'))" <url>`):
   `{"mentions":[{street, from, to, cross, ward, oldDistrict, observedAt, depthCm, signals, cause, quote}]}` —
   same schema and rules as `SCHEMA`/`SYSTEM` in `scripts/lib/news-llm.mjs` (all keys present, null when unknown;
   `signals` ⊂ dat_bo, chet_may, ket_xe, sau_30cm, nua_banh; `observedAt` ISO +07:00 or null; quote ≤ 25 words,
   verbatim). Articles with no heavy mention: `{"mentions":[]}`.
4. **Run** `node scripts/fetch-news.mjs --urls-file <scratch>/M/urls.txt --llm-responses <scratch>/M/resp`.
   One road-network load, one merged write (existing records kept), weather filled from Open-Meteo (cached in
   `data/cache/news-weather.json`). Check the summary and the `unresolved` lines; fix street names in the JSON
   and re-run if needed (`--ignore-seen` not required for `--urls-file`).
   Do not set `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` in this shell.
5. **Verify** `node --test` passes; spot-check a few new records (point on the right street, `weather.r3` set,
   `weather.paPeak` set when M ≥ 2024-09).
6. **Commit only** `public/data/news-floods.json`: `git commit -m "feat: press backfill M (N records)"`, then push.
