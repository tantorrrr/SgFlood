# Bản đồ ngập TP.HCM (POC)

Web app tĩnh hiển thị nguy cơ ngập đường phố TP.HCM theo timeline (48 giờ qua → 48 giờ tới), tô màu đoạn đường kiểu Google Traffic, cho người dân báo ngập và xác nhận ẩn danh (không cần đăng nhập).

- Không có build step, không có npm dependency. Cần Node.js ≥ 22.
- Frontend: ES modules thuần, Leaflet 1.9.4 (unpkg), supabase-js 2.45.4 (jsdelivr, chỉ tải khi đã cấu hình Supabase).

## Chạy

```bash
npm start          # http://localhost:5173
npm test           # node:test cho logic thuần (risk, triều Phú An, parser bản tin, report TTL/fade/override, rate limit, ô lịch sử + ngưỡng theo ô, radar màu → mm/h, enrich)
npm run fetch:tide # cập nhật public/data/tide-phuan.json (chạy hằng ngày)
npm run fetch:news # quét báo chí → public/data/news-floods.json (chạy hằng ngày, cần ANTHROPIC_API_KEY)
```

Khi `public/config.js` để trống `supabaseUrl`/`supabaseAnonKey`, app chạy ở **chế độ demo cục bộ**: báo cáo và xác nhận chỉ lưu trong `localStorage` của trình duyệt (có banner báo).

## Build lại dữ liệu đường

`public/data/roads.json` đã được build sẵn. Để build lại:

```bash
npm run build:data              # dùng cache trong data/cache/ nếu có
node scripts/build-roads.mjs --refresh   # ép tải lại Overpass
```

Script làm các bước:

1. Tải đường chính (motorway → tertiary) từ Overpass theo 4 ô bbox + các đường được nhắc tới trong `data/hotspots.json` (kể cả đường làm đầu mút/giao lộ). Overpass hay trả 504/429 → tự retry (5s/15s/30s) và thử mirror `overpass.kumi.systems`.
2. Đơn giản hoá hình học (Douglas–Peucker 5 m), cắt way thành đoạn ≤ 400 m (đường có điểm ngập: ≤ 100 m để tô đúng đoạn).
3. Gán điểm ngập kinh niên theo hình học của từng điểm (`scripts/lib/hotspot-geom.mjs`):
   - `between`: đoạn của một đường giữa 2 đầu mút (giao lộ thật trên OSM hoặc toạ độ mốc tra từ OSM).
   - `junction`: các đoạn quanh giao lộ trong `radiusM`.
   - `near`: đoạn của một đường quanh 1 điểm, dùng khi nguồn không ghi đoạn cụ thể (`status: "uncertain"`).

Cuối cùng script in bảng id / số đoạn / km. Không tìm được giao lộ hoặc 0 đoạn → build fail. Vượt 2.5 km (hoặc `maxKm`) → `WARN`. Lưu ý: km cộng mọi làn song song cùng tên nên đại lộ trông dài hơn đoạn ngập thực.

### Đường nhỏ (tải lười theo ô)

`npm run build:minor` (`scripts/build-minor.mjs`, chạy sau `build-roads`; `npm run build:data` chạy cả hai):

- Overpass `residential | unclassified | living_street` + `service`/`pedestrian` có tên, chia bbox thành ô 0.02° (~2.2 km, 12×13 ô, id `<hàng>-<cột>` tính từ góc tây nam, `public/js/tiles.js`). Mỗi ô 1 request, cache `data/cache/minor-<ô>.json`, 2 request song song. Ô lỗi → log và build fail ở cuối; chạy lại chỉ tải các ô còn thiếu.
- Bỏ way đã có trong `roads.json` (theo OSM id). Simplify 3 m, cắt ≤ 150 m (≤ 100 m nếu trùng tên đường của điểm ngập). Hình học điểm ngập được giải trên đường lớn rồi áp thêm cho đường nhỏ cùng tên: chỉ thêm đoạn, không đổi đoạn của đường lớn.
- Output `public/data/minor/<ô>.json` (`segs` cùng format `roads.json`, id dạng `m<ô>-<n>`) + `index.json` (ô, bbox, số đoạn, size). Mỗi đoạn thuộc ô chứa midpoint của nó.

Frontend (`public/js/minor-roads.js`): tải ô khi zoom ≥ 15 cho các ô giao viewport + 1 ô biên, và luôn tải ô chứa báo cáo gần đây / điểm lịch sử (ô §18) ở mọi zoom. Ô đã tải được giữ lại. Đoạn mới nối vào cùng mảng đoạn + BucketIndex; dự báo chỉ tính cho đoạn mới (`Forecast.addSegments`, log `console.debug` thời gian mỗi ô). Đường nhỏ chỉ vẽ khi mức ≥ 1 hoặc là điểm ngập, nét mảnh hơn 1 px. Panel không liệt kê đường nhỏ trừ khi là điểm ngập hoặc có analog.

Danh sách 107 điểm (mưa 65, triều 37, cả hai 5) lấy từ bài gốc. Mỗi điểm có link bài gốc, ngày và câu trích nguyên văn; chi tiết đối chiếu và các điểm bị loại xem `tasks/hotspots-sources.md`. Nguồn chính:
- Danh sách 122 điểm của CSGT, Cổng TTĐT TP.HCM 06/10/2026: nguồn chính thức duy nhất có đoạn "từ… đến…".
- Danh sách 34 tuyến của Sở Xây dựng (06/2026) và 23 tuyến ngập triều (12/2025): chỉ có tên đường.

## Triều Phú An (`npm run fetch:tide`)

`scripts/fetch-tide.mjs` (chạy tay hoặc cron **hằng ngày**; file quá 3 ngày thì app quay về hiệu chỉnh mặc định và hiện banner "Số liệu triều Phú An chưa cập nhật"):

1. Đọc RSS chuyên mục Thủy văn của Đài KTTV Nam Bộ (`http://kttvnb.vn`, **HTTP** vì chứng chỉ HTTPS hết hạn), lọc bài "dự báo thủy văn … TP HCM" trong 14 ngày, mở từng bài lấy file đính kèm `HCMC_TVHN_YYYYMMDD.pdf` (id bài không suy ra được từ ngày, không dò id). PDF cache ở `data/cache/tvhn/`.
2. Parse PDF bằng `node:zlib` (`scripts/lib/tvhn.mjs`): thực đo hôm trước tại Phú An (2 đỉnh + 2 chân) và dự báo 5 ngày. Bố cục bản tin thay đổi theo thời gian → file không nhận ra được thì bỏ qua và log, không dừng script.
3. Lấy Open-Meteo marine tại (10.375, 106.958) cùng khoảng ngày, tính `bias = median(OM_peak(t − 3h) − PA_đỉnh_thực_đo)` trên các đỉnh ≥ 1.0 m (mặc định 0.60 nếu < 3 cặp).
4. Ghi `public/data/tide-phuan.json` (`observed` cộng dồn qua các lần chạy; bản commit sẵn được seed từ ~360 bản tin 09/2024–10/2026 bằng `--seed obs.jsonl`).

Frontend: `PA(t) = OM(t − 3h) − bias` (m, hệ Hòn Dấu); ngày nào có dự báo chính thức thì cả ngày được cộng một hiệu chỉnh để đỉnh cao nhất khớp đỉnh dự báo (`public/js/tide.js`). Timeline vẽ đường PA, 3 vạch BĐ I/II/III (1.40/1.50/1.60 m, QĐ 05/2020/QĐ-TTg) và chấm đỉnh dự báo chính thức.

Hiệu chỉnh (research, 697 cặp đỉnh thực đo Phú An – Open-Meteo): trễ ≈ 3 giờ, bias ≈ 0.60 m (sd 0.12), RMSE ≈ 0.08 m cho các đỉnh cao. Open-Meteo marine là mô hình triều thiên văn + khí tượng thô, không có lũ thượng nguồn/xả hồ → ngày xả lũ lớn có thể thấp hơn thực.

## Quét báo chí hằng ngày (`npm run fetch:news`)

`scripts/fetch-news.mjs` (logic thuần ở `scripts/lib/news.mjs`, gọi LLM ở `scripts/lib/news-llm.mjs`):

1. RSS của VnExpress, Tuổi Trẻ, Thanh Niên, VOH (Tin TP.HCM), SGGP, Dân Trí, VietNamNet, Người Lao Động (URL đã kiểm tra 08/10/2026; feed của NLĐ chậm ~1 ngày so với web). Lấy bài 24 giờ qua có từ khoá ngập (ngập, triều cường, mưa lớn, dắt bộ, chết máy, nước dâng) **và** nhắc TP.HCM/đường/phường. Bài đã xử lý lưu ở `data/cache/news-seen.json` (90 ngày).
2. Tải HTML bài, chỉ lấy các đoạn `<p>` (≤ 8000 ký tự).
3. Claude `claude-haiku-5-5` (Messages API, structured JSON output) trích các điểm ngập: đường, từ/đến, giao lộ, phường, giờ ngập, độ sâu, tín hiệu (`dat_bo`, `chet_may`, `ket_xe`, `sau_30cm`), nguyên nhân, trích ≤ 25 từ. Chỉ gửi text bài + ngày đăng.
4. Chỉ giữ điểm có ít nhất 1 tín hiệu ("nặng mới tính"): level 3 nếu `sau_30cm` hoặc sâu > 30 cm, còn lại level 2.
5. Đổi sang hình học §4b (`between` khi có từ/đến, `junction` 250 m khi có giao lộ) và giải bằng `scripts/lib/hotspot-geom.mjs` trên `roads.json` + các ô đường nhỏ nếu đã build. Bài chỉ nêu tên đường (không có đoạn/giao lộ), giao lộ không có trên OSM, hai đường cắt nhau ở nhiều chỗ cách > 2 km, hoặc ngoài bbox → bỏ và ghi log.
6. Gộp: cùng đường + cùng ngày + cách ≤ 300 m → 1 điểm nhiều nguồn. Ghi `public/data/news-floods.json` (giữ 90 ngày). Nếu có `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` thì upsert vào bảng `news_reports` (schema ở cuối `supabase/schema.sql`; anon/auth chỉ đọc).

Cuối mỗi lần chạy script in số bài quét / khớp từ khoá / gọi LLM / mention / giữ lại / resolve được, token và chi phí ước tính.

Đặt key (user tự làm, key không bao giờ được ghi ra file hay log):

```powershell
setx ANTHROPIC_API_KEY "sk-ant-..."     # mở terminal mới sau khi setx
# tuỳ chọn, chỉ trên máy chạy cron: setx SUPABASE_URL "https://xxxx.supabase.co"; setx SUPABASE_SERVICE_ROLE_KEY "..."
npm run fetch:news                       # chạy tay
```

Không có `ANTHROPIC_API_KEY`: script vẫn quét RSS + lọc từ khoá, in danh sách bài rồi dừng, không ghi gì.

Chạy tự động hằng ngày: `powershell -ExecutionPolicy Bypass -File scripts\register-cron.ps1 [-Time 06:30]` tạo task `HcmFlood-daily` (chạy `fetch-tide`, `fetch-news` rồi `enrich-reports`, log ở `data/logs/<ngày>.log`). Gỡ: `schtasks /Delete /TN HcmFlood-daily /F`.

Chi phí ước tính: ~20–25 bài khớp/ngày × ~3000 ký tự ≈ 30–45K token vào + ~10–20K token ra (cả thinking) ≈ **$0.01/ngày** (Haiku 5.5: $0.10 / $0.50 mỗi 1M token). Con số thật in ở cuối mỗi lần chạy.

Bản quyền: chỉ lưu link, tên báo, ngày và câu trích ≤ 25 từ; không lưu nội dung bài.

## Kết nối Supabase (tuỳ chọn)

1. Tạo project tại <https://supabase.com>.
2. **Authentication → Sign In / Providers** → bật **Allow anonymous sign-ins**.
3. **SQL Editor** → dán toàn bộ `supabase/schema.sql` → Run. Script idempotent, chạy lại được.
4. **Project Settings → API**: copy *Project URL* và *anon public key* vào `public/config.js`:
   ```js
   supabaseUrl: 'https://xxxx.supabase.co',
   supabaseAnonKey: 'eyJ...',
   ```
5. Tải lại trang: banner "chế độ demo" biến mất, báo cáo được chia sẻ giữa mọi người dùng.
6. Production: bật CAPTCHA (Cloudflare Turnstile) trong **Authentication → Attack Protection** để chống spam tài khoản ẩn danh.

Schema gồm bảng `reports`, `votes`, view `reports_with_votes` (96 giờ gần nhất: 48 giờ báo muộn + TTL/mờ), view `flood_cells` + bảng `report_enrichment` (§18, xem "Lịch sử theo ô"; view cũ `reports_history` bị xoá — chạy lại `schema.sql` sau khi cập nhật), RLS (chỉ ghi dữ liệu của chính mình, không tự xác nhận báo cáo của mình, chủ báo cáo chỉ được sửa/rút theo luật bên dưới, không xoá cứng) và trigger giới hạn 1 báo cáo/60 giây, 10 báo cáo/giờ mỗi người dùng. Thời gian (`reports.created_at`, `votes.created_at/updated_at`) do server gán, client không ghi đè được. `reports.observed_at` (lúc ngập) do người dùng chọn nhưng trigger chỉ nhận trong `[now − 48h, now + 2 phút]` (lệch tương lai được kẹp về `now()`, ngoài khoảng → `invalid_time`), bỏ trống → `now()`. `votes.updated_at` là thời điểm vote đổi gần nhất, dùng làm nhãn theo thời gian.

## Mô hình dự báo

`risk = max(sRain · smoothstep(3, 25, R3), sTide · smoothstep(1.40, 1.95, PA(t)))`, trong đó `R3` là lượng mưa 3 giờ có trọng số tại tâm đoạn đường, `PA(t)` là mực nước Phú An (hệ Hòn Dấu), `sRain`/`sTide` là độ nhạy:
- Điểm ngập kinh niên: 0.95 theo nguyên nhân (mưa/triều/cả hai).
- Đoạn khác: mưa `S_RAIN_BASE = 0.1` (phẳng), triều 0. Không dùng địa hình: FABDEM đã bỏ ngày 2026-10-08 vì giá trị dự báo thấp (cao độ trung vị các điểm ngập kinh niên ≈ trung vị mọi đoạn đường).

Ngưỡng triều chưa hiệu chỉnh với độ sâu ngập thực. Mức: < 0.25 khô, < 0.5 đọng nước, < 0.75 ngập 10–30cm, còn lại ngập sâu. Báo cáo của người dân (đang hiệu lực, TTL 6–12 giờ tuỳ số xác nhận) ghi đè dự báo trong bán kính 60 m (`INFLUENCE_M`). Hằng số nằm trong `public/config.js` (`model`).

## Báo ngập quá khứ (báo muộn)

- Khi timeline đang ở quá khứ, nút báo ngập / "Không ngập" báo cho đúng giờ đó; sheet có ô chọn giờ (bước 15 phút, trong 48 giờ qua, mặc định giờ timeline hoặc "Bây giờ"). Timeline ở tương lai thì nhảy về hiện tại như cũ.
- Báo cáo **muộn** khi `created_at − observed_at > 15 phút`: tối đa 3 báo cáo muộn / người / 24 giờ (`late_limited`, áp cả ở trigger và chế độ cục bộ), ngoài giới hạn 1/60 giây, 10/giờ.
- Hiệu lực (TTL 6–12 giờ, `crowd.REPORT_TTL_H` + 1 giờ/xác nhận, tối đa `REPORT_TTL_MAX_H`) tính từ `observed_at`. Hết TTL, báo cáo còn hiện mờ thêm `FADE_H = 24` giờ (vòng nét đứt nhạt, marker xám, "đã báo lúc HH:mm"): không ghi đè dự báo, không tính cụm nóng, nên báo muộn chỉ ảnh hưởng mốc "bây giờ" nếu còn trong TTL. Báo muộn có `confidence = net` (báo thường `1 + net`) → cần ≥ 1 xác nhận mới ghi đè dự báo, trừ khi bật `crowd.LATE_SELF_CONFIRM` (mặc định bật, xem "Cold start"). Marker viền nét đứt, popup "Báo muộn · gửi lúc …", nút vote "Đúng, lúc đó ngập" / "Không đúng".
- Lịch sử theo ô và xuất dữ liệu dùng R3 tại `observed_at` (snapshot chụp theo `observed_at`).

## Lịch sử theo ô (dự báo lại theo các lần ngập cũ, §18)

- Không còn giới hạn 30 ngày. View Supabase `flood_cells` (security_invoker, theo RLS như các view khác) gộp báo cáo hợp lệ (không rút, không bị phủ nhận, có snapshot) + `news_reports` của 730 ngày theo ô ~150 m (lưới 0.00135°, cùng công thức với `public/js/cells.js`). Mỗi ô: `cell_id, lat, lng, events`, mỗi event `{t, level, net, Rh, RhSrc, PAh, cause, source, radarMmH}`. Chế độ cục bộ gộp y hệt từ localStorage. Tin báo chí trong `news-floods.json` được gộp thêm (trùng id thì giữ 1); mưa/triều của tin lấy từ dữ liệu thời tiết đã tải nếu bài nằm trong 48 giờ qua.
- `Rh` = **Rh_eff** = max(ECMWF R3, GFS R3, radar max mm/h × 1 giờ, `r3_obs` bổ sung sau sự kiện), `RhSrc` ghi nguồn thắng (`ecmwf`/`gfs`/`radar`/`obs`). `PAh` = triều Phú An trong snapshot. Event là triều nếu `PAh ≥ TIDE_START` và `Rh < ANALOG_RAIN_MIN` (tin báo: theo `cause` của bài).
- Ngưỡng theo ô (thay analog từng báo cáo): `Tcell` = phân vị 25% `Rh_eff` của các lần ngập do mưa, sàn `ANALOG_RAIN_MIN = 8 mm`. Khi R3 dự báo ≥ `Tcell` → mức = trung vị (cận dưới) mức các lần ngập có `Rh_eff ≤ R3` (không có → mức nhỏ nhất); từ `ANALOG_NEAR_RATIO (0.7)` × `Tcell` → thấp hơn 1 mức. **Mẫu âm**: số lần khô (báo "Không ngập") có `Rh_eff ≥ R3` nhiều hơn số lần ngập có `Rh_eff ≤ R3` → hạ 1 mức. Triều tương tự trên `PAh` (sàn `TIDE_START`, kích hoạt từ ngưỡng − `ANALOG_TIDE_TOL (0.05 m)`). Mức cuối = max(heuristic, ô). Hằng số trong `public/config.js` (`model`).
- Đoạn đường trong 60 m quanh vị trí các lần báo trong ô nhận ngưỡng của ô; popup/panel ghi "Ô này ngập n/m lần khi mưa 3h ≥ X mm (nguồn: radar/ECMWF/thực đo)" (n = lần ngập có `Rh_eff ≥ X`, m = mọi lần ngập + khô có `Rh_eff ≥ X`).
- Ở giờ hiện tại/tương lai, ô kích hoạt vẽ vòng 60 m nét đứt, fill nhạt, màu theo mức dự báo (kể cả khi không có đường nào gần); tooltip nằm trên chấm nhỏ ở tâm. Panel dự báo liệt kê "Điểm từng ngập (người dân báo / báo chí)" kèm tên đường gần nhất trong 500 m.
- **Bổ sung sau sự kiện** (`scripts/enrich-reports.mjs`, `npm run enrich`, chạy trong cron hằng ngày): chỉ chạy khi có env `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (không có → bỏ qua, log rõ). Báo cáo 2–10 ngày tuổi chưa có dòng trong `report_enrichment` → R3 tại điểm/giờ ngập từ Open-Meteo Archive (ERA5), nếu ERA5 chưa có thì Historical Forecast API → upsert `report_enrichment(report_id, r3_obs, source, fetched_at)` (anon/auth chỉ đọc, ghi bằng service role). `flood_cells` dùng max(Rh_eff, r3_obs).

## Sửa / rút báo cáo của chính mình
- Popup báo cáo của bạn có nút **Sửa** và **Rút báo cáo**.
- **Sửa** (vị trí: kéo marker hoặc chạm bản đồ; mức; giờ ngập) chỉ khi chưa có vote nào và tối đa 5 lần (`has_votes`, `edit_limit`). Đã có vote → nút "Sửa" bị khoá vì vote gắn với vị trí/mức cũ.
- Giờ ngập khi sửa theo luật báo muộn nhưng neo vào `created_at` gốc: `[created_at − 48h, created_at]` (`invalid_time`). Đổi thường → muộn tính vào giới hạn 3 báo muộn/24h (`late_limited`).
- Đổi vị trí hoặc giờ → chụp lại snapshot theo vị trí/giờ mới (đổi mức thì giữ snapshot cũ). Server gán `edited_at = now()`, tăng `edit_count`, giữ nguyên `id/user_id/created_at`.
- **Rút báo cáo** = soft delete (`withdrawn_at = now()`, cho phép cả khi đã có vote): ẩn khỏi bản đồ, view `reports_with_votes` / `flood_cells` và lịch sử theo ô; xuất dữ liệu vẫn giữ kèm `withdrawn_at`. Báo cáo đã rút không sửa được. Không có DELETE.
- Supabase: RLS UPDATE chỉ cho chủ báo cáo, trigger `reports_edit` kiểm các luật trên; chế độ cục bộ áp cùng luật. Realtime đã nghe UPDATE nên client khác tự cập nhật.

## Cold start (ít người dùng)

- `public/config.js` → `crowd = { MIN_CONFIDENCE: 1, LATE_SELF_CONFIRM: true, ANALOG_MIN_NET: 0 }`: một báo cáo tự xác nhận chính nó (kể cả báo muộn, `confidence = 1 + net`) nên ghi đè màu đường ngay, và mọi báo ngập không bị phủ nhận đều dùng làm analog lịch sử. Khi đủ người dùng: đặt `LATE_SELF_CONFIRM: false`, `ANALOG_MIN_NET: 1`. Báo cáo "Không ngập" cần `confidence ≥ MIN_CONFIDENCE + 1`.
- Báo cáo bị phủ nhận (`denies ≥ confirms + 2`) luôn bị ẩn và loại khỏi mọi tính toán.
- Mỗi báo cáo đang hiệu lực tô vòng tròn 60 m (bán kính ảnh hưởng `INFLUENCE_M`) màu theo mức, nằm dưới lớp đường, không bấm được; báo muộn viền nét đứt. Đoạn đường do người dân xác nhận có viền trắng dày + nét đậm hơn đoạn dự báo.

## Cụm cộng đồng + heatmap (§17)
- `public/js/clusters.js` (thuần, test ở `test/clusters.test.mjs`): gom báo cáo (+ tin báo chí, mỗi bài = 1 nguồn) bán kính 150 m, greedy theo mật độ, đếm **nguồn khác nhau** (mỗi user_id = 1).
  - ≥ 3 nguồn còn trong TTL (của từng báo cáo, 6–12 giờ; tin báo 3 giờ) tại mốc timeline → "Điểm nóng cộng đồng" (vòng cam đậm + "N người · M lượt", có trong panel, bấm để bay tới). ≥ 2 lượt nhưng < 3 nguồn → vòng xám nét đứt "chưa đủ".
  - ≥ 3 ngày khác nhau trong 90 ngày → ứng viên kinh niên "Cộng đồng phát hiện", bật/tắt cùng lớp điểm kinh niên.
- Heatmap (`heatmap-layer.js`, canvas tự vẽ, mặc định tắt): trọng số = level × decay, half-life 3 giờ khi xem hiện tại/tương lai, 30 ngày khi kéo timeline về quá khứ.

## Real-time và snapshot thời tiết

- Ở chế độ Supabase, app subscribe Realtime (`reports`, `votes`) để cập nhật bản đồ ngay; poll 60 giây vẫn giữ làm dự phòng. Ở chế độ cục bộ, các tab cùng trình duyệt đồng bộ qua sự kiện `storage`.
- Mỗi báo cáo kèm `snapshot` (cột `reports.snapshot`, tối đa 16 KB) chụp ngay lúc gửi, tối đa 6 giây (lỗi/timeout thì báo cáo vẫn gửi, nguồn lỗi ghi `null`):
  - Mọi nguồn lấy theo `observedAt` (lúc ngập, = lúc gửi nếu báo ngay); snapshot ghi thêm `observedAt` và `late`.
  - Mưa ECMWF IFS + GFS tại điểm báo (Open-Meteo `past_days=3`, cắt 6 giờ trước → 3 giờ sau `observedAt`) và đặc trưng tính sẵn `p1`, `R3`, `p6sum` (cùng công thức R3 với mô hình).
  - Radar RainViewer (zoom 7, scheme 2 "Universal Blue", tile không làm mượt `0_0`): mọi frame trong 60 phút trước `observedAt` tại điểm → `radar.frames[{time, rgba, dBZ, mmH}]`, `radar.maxMmH`. Màu → dBZ theo bảng chính thức của RainViewer (<https://www.rainviewer.com/api/color-schemes.html>, `public/js/radar-rate.js`), rồi Marshall–Palmer `R = (10^(dBZ/10)/200)^(1/1.6)`. `null` + `radarError: "out_of_range"` nếu ngoài 2 giờ qua, `null` nếu trình duyệt chặn đọc canvas (CORS).
  - Triều: mực nước Vũng Tàu (Open-Meteo) tại giờ `observedAt` và trễ 3 giờ, `phuAn` = PA(observedAt), `phuAnSource` (`om+3h−bias` hoặc `…+bulletin` nếu đã khớp dự báo chính thức), `bias`, `alert` (`<I`/`I`/`II`/`III`), `latestObservedPeak` (đỉnh thực đo gần nhất ≤ `observedAt`).
- Popup báo cáo hiển thị "Thời tiết lúc ngập".
- **Vòng lặp học tối thiểu**: xem "Lịch sử theo ô" — các lần ngập/khô cũ (kể cả 2 năm trước) đặt ngưỡng mưa/triều cho ô ~150 m quanh đó.
- Nút **Xuất dữ liệu (JSON)** cuối panel tải reports + votes + snapshot để phân tích/train sau.
- **Hạn chế**: snapshot được tạo ở client nên **có thể bị giả mạo**. Khi dùng để train, phải tính lại lượng mưa phía server bằng Open-Meteo Historical Forecast API theo `lat/lng/observed_at`, chỉ dùng snapshot để đối chiếu.

## Giới hạn đã biết

- **Mô hình heuristic, chưa hiệu chỉnh** với dữ liệu ngập thực tế. Chỉ dùng để tham khảo.
- **ECMWF IFS ~9 km** làm mượt mưa đối lưu: các cơn giông cục bộ (rất phổ biến ở TP.HCM) thường bị dự báo thấp hơn và lệch vị trí/thời gian.
- **Triều Phú An suy từ Open-Meteo** (trễ 3 giờ − bias) và chỉ khớp đỉnh dự báo chính thức theo ngày; `fetch-tide` phải chạy hằng ngày, nếu không app dùng bias mặc định 0.60.
- Điểm ngập kinh niên: 42/107 điểm là `uncertain`, vì nguồn chỉ ghi tên đường hoặc mốc không có trên OSM. Một số đầu mút là cầu phải lùi về cuối đoạn OSM liền mạch (khoảng 130–290 m), vì way cầu mang tên khác.
- **Open-Meteo, RainViewer và tile OpenStreetMap chỉ cho phép dùng phi thương mại / lưu lượng nhẹ.** Triển khai thật cần gói trả phí hoặc tile server riêng.
- Radar RainViewer chỉ có ~2 giờ quá khứ, độ phân giải tối đa zoom 7.
- Chế độ demo cục bộ không chia sẻ báo cáo giữa các thiết bị; giới hạn tần suất phía client chỉ mang tính minh hoạ.

## Deploy (Cloudflare Pages)

- Pages → Connect to Git → repo này. Framework preset **None**, build command **để trống**, output directory **`public`**. Mỗi lần push lên `main` là tự deploy.
- `public/_headers`: cache dài cho `roads.json` và `data/minor/*`; code, `config.js` và dữ liệu cập nhật hằng ngày luôn revalidate (file không có hash).
- Supabase → Authentication → URL Configuration: thêm domain `*.pages.dev` (hoặc domain riêng).
- Dữ liệu hằng ngày: `.github/workflows/daily-data.yml` (10:30 giờ VN, chạy tay được qua *Run workflow*) chạy `fetch:tide`, `fetch:news`, `enrich` rồi commit `public/data/tide-phuan.json` và `news-floods.json`. Secrets cần thêm: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (thiếu thì bước tương ứng bỏ qua). `data/cache` được giữ giữa các lần chạy bằng `actions/cache`.
