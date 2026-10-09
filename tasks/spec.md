# HCMC Flood Map POC — Implementation spec

Mục tiêu: web app tĩnh (không build step) hiển thị nguy cơ ngập đường phố TP.HCM theo timeline kiểu Windy, tô màu đoạn đường kiểu Google Traffic, cho người dân báo ngập + vote xác nhận ẩn danh (không login).

UI tiếng Việt. Code/comment tiếng Anh. Zero npm dependency cho runtime và scripts (Node 22 built-in `fetch`, `node:test`, `node:http`). Thư viện frontend load qua CDN với version pin chính xác.

## 1. Stack (đã chốt, không đổi)
- Map: Leaflet `1.9.4` (unpkg) + OSM standard tiles `https://tile.openstreetmap.org/{z}/{x}/{y}.png` (attribution bắt buộc). CARTO đã bắt key, KHÔNG dùng. Áp CSS filter nhẹ (grayscale ~0.6, brightness) lên tile pane để đường tô màu nổi bật.
- Rain: Open-Meteo forecast API (no key, CORS `*`), gọi trực tiếp từ browser.
- Tide: Open-Meteo Marine API `sea_level_height_msl` tại điểm ven biển (10.375, 106.958). Điểm nội thành trả null.
- Radar (optional toggle): RainViewer `https://api.rainviewer.com/public/weather-maps.json`, chỉ 2h quá khứ, maxNativeZoom 7.
- Roads: Overpass (build-time, Node script) → GeoJSON-like compact JSON tĩnh.
- Elevation: Open-Meteo elevation API (≤100 coords/request) build-time, lấy lưới rồi tra nearest. Copernicus là DSM → chỉ dùng xếp hạng tương đối (percentile).
- Storage: Supabase (anonymous sign-in + RLS + trigger) qua `@supabase/supabase-js@2.45.4` ESM từ jsdelivr. Fallback `LocalStore` (localStorage) khi `config.js` chưa có URL/key → app vẫn chạy được.

## 2. Cấu trúc thư mục
```
package.json            # "type":"module"; scripts: start, build:data, test
scripts/serve.mjs       # static server zero-dep, port 5173, serve public/
scripts/build-roads.mjs # Overpass + hotspot matching + elevation → public/data/roads.json
data/hotspots.json      # danh sách điểm ngập kinh niên (input build)
data/cache/             # cache raw Overpass/elevation (gitignore)
public/index.html
public/styles.css
public/config.js        # window.FLOOD_CONFIG = {...}
public/js/*.js          # ES modules
public/data/roads.json  # output build (commit sẵn)
supabase/schema.sql
test/*.test.mjs         # node:test cho logic thuần (risk, reports, decay)
README.md               # tiếng Việt: chạy, build data, setup Supabase, giới hạn
.claude/launch.json     # preview config: node scripts/serve.mjs, port 5173
.gitignore
```

## 3. Vùng phủ
BBox lõi đô thị (cũ): lat 10.66–10.90, lng 106.58–106.84 (Q1–Q12, Bình Thạnh, Gò Vấp, Tân Bình, Bình Tân, Q7, Nhà Bè, Thủ Đức cũ, Hóc Môn phía nam). Bình Dương / Vũng Tàu: ngoài phạm vi POC.

## 4. Data build (`scripts/build-roads.mjs`)
1. Overpass: `way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"](bbox); out geom;` — chia bbox thành 4 ô, mỗi ô 1 request. Query thứ 2: các way có `name` khớp tên đường trong hotspots (regex, mọi class highway trừ footway/path/service) trong bbox.
   - Overpass bắt "simple request": POST `application/x-www-form-urlencoded` body `data=...`, header `User-Agent` + `Referer` (curl không Referer bị 406). Server hay 504/429 → retry backoff (5s, 15s, 30s), thử mirror `https://overpass.kumi.systems/api/interpreter` nếu main fail. Cache raw vào `data/cache/overpass-*.json`; có cache thì không gọi lại (flag `--refresh` để ép tải).
2. Simplify mỗi way (Douglas–Peucker ~5 m), làm tròn toạ độ 5 chữ số, bỏ tag thừa. Way dài > 600 m cắt thành các đoạn ≤ 400 m (để tô màu cục bộ như traffic).
3. Elevation: lưới bước 0.005° trên bbox (~2.5k điểm, ~25 request x100 coords, delay 300ms), cache `data/cache/elevation-grid.json`. Mỗi segment lấy độ cao tại midpoint (nearest grid) → tính percentile `ep` (0..1) trên toàn bộ segment.
4. Hotspot matching: chuẩn hoá tên (lowercase, bỏ dấu tiếng Việt, bỏ tiền tố "đường"), segment khớp tên trong hotspot.streets VÀ midpoint cách hotspot.center ≤ hotspot.radiusKm → gán `hs = hotspot.id`.
5. Output `public/data/roads.json`, compact:
   ```json
   { "v":1, "bbox":[...], "builtAt":"...", "hotspots":[...nguyên data/hotspots.json...],
     "segs":[ { "i":0, "n":"Huỳnh Tấn Phát", "h":"primary", "c":[[lat,lng],...], "ep":0.12, "hs":"q7-huynh-tan-phat" } ] }
   ```
   Mục tiêu file < 3 MB. In thống kê: số segment, số segment gắn hotspot theo từng hotspot (hotspot match 0 segment → cảnh báo).

### `data/hotspots.json` — tạo từ danh sách sau (nguồn: Sở Xây dựng qua VietNamNet 25/06/2026, Đại biểu Nhân dân 05/12/2025, VOH 10/05/2024)
Mỗi entry: `{ id, title, streets:[...tên đường OSM], area, center:[lat,lng], radiusKm, cause:"rain"|"tide"|"both", note, sources:[url] }`. Center là toạ độ xấp xỉ khu vực (tự ước lượng hợp lý theo địa lý; nếu cần, tra Nominatim 1 lần lúc viết file, KHÔNG gọi lúc runtime). radiusKm 1.5–3.

Triều: Trần Xuân Soạn (Q7, Tân Thuận) · Huỳnh Tấn Phát (Q7/Nhà Bè) · Phạm Hữu Lầu (Q7) · Đào Sư Tích (Nhà Bè) · Nguyễn Bình (Nhà Bè) · Lê Văn Lương (Q7/Nhà Bè, both) · Quốc lộ 50 (Bình Chánh, both) · Nguyễn Văn Hưởng (Thảo Điền/An Khánh, both) · Võ Nguyên Giáp đoạn Phước Long (Thủ Đức) · Mai Chí Thọ (Thủ Thiêm) · Calmette (Q1) · Bình Quới (Bình Thạnh).

Mưa: giao lộ Võ Văn Kiệt – Hồ Học Lãm (Bình Tân) · Ung Văn Khiêm (Bình Thạnh) · Phạm Văn Chiêu (Gò Vấp) · Phan Huy Ích (Gò Vấp) · Song hành QL22 / Quốc lộ 22 (Hóc Môn, Bà Điểm) · Phan Văn Hớn (Q12/Hóc Môn) · Nguyễn Văn Quá (Q12) · Dương Văn Cam, Kha Vạn Cân, Đặng Thị Rành, Tỉnh lộ 43, Lê Thị Hoa (Thủ Đức cũ) · Lê Đức Thọ, Quang Trung, Nguyễn Văn Khối (Gò Vấp) · Thảo Điền, Quốc Hương (Q2) · Bạch Đằng, Đinh Bộ Lĩnh (Bình Thạnh) · Phan Anh, An Dương Vương (Bình Tân/Tân Phú/Q6) · Trường Sơn, Lê Văn Thọ (Tân Bình/Gò Vấp).

## 4b. Hotspot v2 — thay thế cách match "tên đường + bán kính" (2026-10-08)
Lý do: cách cũ tô 142 km đường cho 25 điểm (Mai Chí Thọ 14 km, Võ Văn Kiệt 11.9 km cho 1 giao lộ). Điểm ngập thật chỉ dài vài trăm mét.

`data/hotspots.json` mỗi entry:
```json
{
  "id": "gv-le-duc-tho",
  "title": "Lê Đức Thọ (Phạm Văn Chiêu → Cầu Cụt)",
  "area": "An Hội Đông (Gò Vấp cũ)",
  "cause": "rain" | "tide" | "both",
  "years": [2024, 2026],
  "status": "confirmed" | "uncertain",
  "sources": [{ "url": "<link bài gốc>", "date": "2026-06-25", "quote": "<trích nguyên văn ngắn>" }],
  "geometry": <một trong ba dạng dưới>
}
```
Geometry:
- `{ "type": "between", "street": "Lê Đức Thọ", "from": <End>, "to": <End>, "near": [lat,lng] }` — đoạn của `street` giữa 2 đầu mút.
  `End` = `"Tên đường cắt ngang"` (giao lộ với street) hoặc `{ "point": [lat,lng], "label": "Cầu Cụt" }`.
- `{ "type": "junction", "streets": ["Võ Văn Kiệt", "Hồ Học Lãm"], "radiusM": 250, "near": [lat,lng] }` — các đoạn của các street trong bán kính quanh giao lộ.
- `{ "type": "near", "street": "Trần Xuân Soạn", "point": [lat,lng], "radiusM": 400 }` — fallback khi nguồn không nói đoạn cụ thể; `status` nên là `uncertain`.
`near` = gợi ý để chọn đúng giao lộ khi 2 đường cắt nhau nhiều lần (chọn giao lộ gần `near` nhất, phải ≤ 2 km).

Build:
- Giao lộ = node OSM dùng chung giữa way tên A và way tên B (so tên đã chuẩn hoá), fallback: cặp điểm gần nhất < 30 m. Không tìm thấy → lỗi rõ ràng ghi id + tên, build fail (không âm thầm bỏ qua).
- `between`: lấy path của `street` (nối các way cùng tên thành chuỗi) giữa 2 điểm chiếu của 2 đầu mút; giữ các piece nằm giữa (theo khoảng cách dọc path), không phải toàn bộ đường.
- Way thuộc street của hotspot cắt nhỏ ≤ 100 m (các way khác giữ ≤ 400 m) để tô đúng đoạn.
- Validate + in bảng: id, số piece, chiều dài km. Fail nếu 0 piece; cảnh báo nếu > 2.5 km (trừ khi entry có `"maxKm"` lớn hơn).
- `roads.json.hotspots` giữ nguyên entry (để popup hiện nguồn + quote + năm + status).

## 5. Weather (`public/js/weather.js`)
- Rain grid: 6×6 điểm đều trên bbox, 1 request multi-location Open-Meteo:
  `https://api.open-meteo.com/v1/forecast?latitude=<36 lat csv>&longitude=<36 lng csv>&hourly=precipitation,precipitation_probability&models=ecmwf_ifs&past_days=1&forecast_days=3&timezone=Asia%2FHo_Chi_Minh`
  Response là array 36 phần tử. Chuẩn hoá thành `{ times:[epochMs...], grid:{rows,cols,lats,lngs}, precip: Float32Array[t][cell] }`. Null → 0.
- Tide: Marine API tại (10.375,106.958), `hourly=sea_level_height_msl&past_days=1&forecast_days=3&timezone=Asia%2FHo_Chi_Minh`. Căn theo cùng trục thời gian.
- Cache response trong `sessionStorage` 15 phút (try/catch). Lỗi mạng → banner báo lỗi, app vẫn hiện đường + báo cáo.
- Lưu ý: minutely_15 ở VN chỉ là nội suy hourly → không dùng. Timeline bước 1 giờ.

## 6. Risk model (`public/js/risk.js`, hàm thuần, có test)
Hằng số đặt trong `config.js` (`FLOOD_CONFIG.model`), ghi chú "chưa hiệu chỉnh".
- `rainAt(seg, t)`: nội suy bilinear lưới mưa tại midpoint segment.
- `R3 = p(t) + 0.6·p(t−1h) + 0.3·p(t−2h)` (mm, có trọng số vì nước rút ~30 phút sau mưa).
- `rainF = smoothstep(RAIN_START=3, RAIN_FULL=25, R3)`.
- `tideF = smoothstep(TIDE_START=1.7, TIDE_FULL=2.2, seaLevel(t − TIDE_LAG_H=2))` (Vũng Tàu → Phú An lag ước lượng).
- Susceptibility:
  - hotspot cause rain/both: `sRain = 0.95`; không hotspot: `sRain = 0.15 + 0.3·(1 − ep)` chỉ khi `ep < 0.3`, ngược lại 0.1.
  - hotspot cause tide/both: `sTide = 0.95`; còn lại 0.
- `risk = max(sRain·rainF, sTide·tideF)`.
- Level: `<0.25 → 0`, `<0.5 → 1` (đọng nước <10cm), `<0.75 → 2` (10–30cm), `≥0.75 → 3` (>30cm).
- Crowd override (xem §7): áp sau cùng.
- Trả về cả `reason` `{R3, seaLevel, hotspot, crowd}` để popup giải thích.

## 7. Crowd reports + vote
- Report: `{id, lat, lng, level 0..3, created_at, user_id}`; level 0 = "Không ngập / đã rút". Chỉ chọn band cố định, KHÔNG free text (học mPING; tránh nội dung độc hại).
- Vote: `{report_id, user_id, value ±1}`; 1 vote/user/report (đổi được), không tự vote report của mình.
- Hiệu lực tại thời điểm t (hàm thuần `reportState(report, votes, t)`):
  - `net = confirms − denies`; ẩn nếu `denies ≥ confirms + 2`.
  - TTL = `2h + 1h·max(0, net)`, tối đa 6h (Waze-style TTL co giãn theo xác nhận). **§18 đổi thành 6h + 1h/xác nhận, tối đa 12h, + 24h hiện mờ.** Active nếu `created_at ≤ t < created_at + TTL`.
  - `confidence = 1 + net`.
- Ảnh hưởng lên segment: segment có điểm gần nhất ≤ 200 m tới report active:
  - report.level > 0 và confidence ≥ 1 → `level = max(pred, report.level)`, đánh dấu "đã xác nhận bởi N người".
  - report.level = 0 và confidence ≥ 2 → `level = min(pred, 1)`.
- Timeline ở tương lai (> now): không hiện report (chỉ dự báo). Ở quá khứ: hiện report active tại t.
- Spatial index: lưới bucket ~0.005° cho segment để tra 200 m nhanh.

### Store adapter (`public/js/store.js`)
Interface: `init()`, `listReports({sinceMs})` → `[{...report, confirms, denies, myVote}]`, `createReport({lat,lng,level})`, `vote(reportId, value)`, `userId`.
- `SupabaseStore`: `supabase.auth.signInAnonymously()` nếu chưa có session (session lưu sẵn bởi supabase-js). Đọc view `reports_with_votes` (48h gần nhất). Lỗi rate-limit từ trigger → hiện toast tiếng Việt dễ hiểu.
- `LocalStore`: localStorage, userId random uuid; áp cùng rate limit phía client. Banner nhỏ "Chế độ demo cục bộ — chưa kết nối Supabase".
- Poll 60s + refresh ngay sau action của mình.

### 7b. Real-time + weather snapshot mỗi báo cáo (bổ sung)
Mục đích: tích luỹ cặp (lượng mưa/triều tại thời điểm, mức ngập được xác nhận) để sau này suy ra mức ngập từ forecast mưa tương tự.
- **Real-time**: `SupabaseStore` subscribe Supabase Realtime (`postgres_changes` INSERT/UPDATE trên `reports`, `votes`) → cập nhật map ngay; poll 60s giữ làm fallback. `LocalStore`: nghe `storage` event để đồng bộ giữa các tab.
- **Snapshot** chụp lúc tạo report (client-side, `public/js/snapshot.js`), lưu vào cột `reports.snapshot jsonb`. Chụp lỗi/timeout 6s → vẫn gửi report, nguồn lỗi ghi `null` + `error`. Không chặn UX gửi báo cáo quá 6s.
  ```json
  { "v":1, "capturedAt":"ISO", "lat":..., "lng":...,
    "models": {                       // 1 request Open-Meteo: models=ecmwf_ifs,gfs_global tại điểm báo cáo
      "ecmwf_ifs":  { "hourly": { "time":[...], "precipitation":[...] } },   // từ now−6h tới now+3h
      "gfs_global": { "hourly": { "time":[...], "precipitation":[...] } }
    },
    "features": { "ecmwf_ifs": {"p1":..,"R3":..,"p6sum":..}, "gfs_global": {...} },   // tính sẵn bằng cùng hàm R3 của risk.js
    "radar": { "source":"rainviewer", "frameTime":epoch, "z":7, "x":..,"y":..,"px":..,"py":.., "rgba":[r,g,b,a], "scheme":2 } | null,
    "tide":  { "source":"open-meteo-marine@10.375,106.958", "seaLevel":.., "seaLevelLagged":.. }
  }
  ```
  - Open-Meteo multi-model: các key trả về có hậu tố `_ecmwf_ifs`, `_gfs_global` — chuẩn hoá lại như trên. Dùng `past_hours=6&forecast_hours=3` (hoặc past_days=1 rồi cắt).
  - Radar: lấy frame mới nhất từ `weather-maps.json`, tính tile z7 chứa điểm, load ảnh với `crossOrigin="anonymous"`, đọc pixel qua canvas. Nếu canvas bị tainted/CORS fail → `radar: null, radarError`. Lưu RGBA thô + scheme (đổi sang dBZ/mm/h để sau).
  - Triều: tái dùng dữ liệu marine đã tải trong `weather.js` (giá trị tại giờ hiện tại và giờ trễ `TIDE_LAG_H`).
- Vote giữ `created_at` (nhãn theo thời gian); không snapshot mỗi vote (có thể tái tạo từ Historical Forecast API).
- **Hiển thị**: popup report có mục "Thời tiết lúc báo": ECMWF R3 / GFS R3 / radar có/không / triều.
- **Dùng lịch sử (vòng lặp học tối thiểu)** trong `risk.js`, hàm thuần có test: segment có ≥1 report lịch sử (bất kỳ thời điểm, trong dữ liệu đã tải) trong 200 m với `level ≥ 1`, `net ≥ 1` và `snapshot.features.ecmwf_ifs.R3` = `Rh` → nếu forecast `R3(t) ≥ Rh` thì `sRain = max(sRain, 0.95)` và `reason.analog = {count, minR3}`; popup ghi "Từng ngập khi mưa 3h ≈ Rh mm". Store tải report lịch sử 30 ngày cho mục này (view thứ 2 `reports_history` chỉ gồm report có `net ≥ 1`, hoặc filter client-side ở LocalStore).
- **Xuất dữ liệu**: nút "Xuất dữ liệu (JSON)" ở cuối panel → tải file reports + votes + snapshot (phục vụ train sau này).
- Schema: thêm `snapshot jsonb` + CHECK `octet_length(snapshot::text) < 16384`; view `reports_with_votes` có cột snapshot; thêm view `reports_history` (30 ngày, net ≥ 1); bật realtime: thêm `reports`, `votes` vào publication `supabase_realtime` (DO block idempotent).
- README: giải thích snapshot, nguồn, hạn chế (client-side → có thể giả mạo; khi train phải đối chiếu lại bằng Open-Meteo Historical Forecast API phía server).

### `supabase/schema.sql` (chạy 1 lần trong SQL editor, idempotent)
- `reports`: id uuid default gen_random_uuid(), user_id uuid not null default auth.uid(), lat/lng double precision có CHECK nằm trong bbox, level smallint CHECK 0..3, created_at timestamptz default now().
- `votes`: (report_id → reports on delete cascade, user_id default auth.uid()) PK, value smallint CHECK in (-1,1), created_at.
- View `reports_with_votes` (`security_invoker = true`): report + confirms + denies, chỉ 48h gần nhất.
- RLS bật cho cả 2 bảng. SELECT: `to anon, authenticated using (true)`. INSERT reports: `to authenticated with check (user_id = auth.uid())`. INSERT/UPDATE votes: chỉ của mình; cấm vote report của mình (check qua subquery). Không cho UPDATE/DELETE reports.
- Trigger BEFORE INSERT on reports (security definer, set search_path): reject nếu user có report trong 60s gần nhất hoặc ≥ 10 report trong 1h (`raise exception 'rate_limited'`).
- Comment đầu file: bật "Allow anonymous sign-ins" trong Authentication → Sign In / Providers; production nên bật captcha (Turnstile).

## 8. UI
- Layout full màn hình: map; panel trái (collapsible, trên mobile thành bottom sheet) "Dự báo ngập"; timeline cố định đáy; nút nổi "Báo ngập" góc phải dưới; legend nhỏ.
- **Road layer** (kiểu traffic): Leaflet `L.canvas()` renderer. Chỉ vẽ segment level ≥ 1. Màu theo nước: L1 `#4fc3f7`, L2 `#1e88e5`, L3 `#5e35b1`; weight theo zoom (3→7); viền tối mảnh cho tương phản. Segment xác nhận bởi crowd: nét liền đậm hơn; dự báo thuần: hơi trong suốt. Mỗi bước timeline chỉ `setStyle` segment đổi level (giữ map id→layer).
- Layer "Điểm ngập kinh niên" (toggle, mặc định bật): segment hotspot vẽ nét đứt mảnh màu xám xanh khi khô, để luôn thấy các điểm nóng.
- **Rain overlay** kiểu Windy: canvas ~120×120 px nội suy bilinear lưới 6×6 → `L.imageOverlay` trên bbox, opacity 0.5, palette: <0.2 trong suốt, 0.5 xanh lá nhạt, 2 xanh lá, 5 vàng, 10 cam, 20 đỏ, 40 tím. Vẽ lại mỗi bước. Toggle được.
- Radar RainViewer (toggle, mặc định tắt): khi t trong 2h qua, hiện frame gần nhất; ngoài khoảng → ẩn + ghi chú.
- **Timeline** đáy (Windy-like): nút ▶/⏸, nhãn thời gian `T4 08/10 14:00`, slider giờ từ now−24h (§18: now−48h) tới now+48h, vạch "Bây giờ", nhãn ngày. Phía trên slider: bar chart mini lượng mưa trung bình toàn vùng mỗi giờ + đường mực triều. Phím: Space play/pause, ←/→ bước 1h. Play ~2 bước/giây, tới cuối thì dừng. Mặc định mở ở "now".
- **Panel "Dự báo ngập"**: chọn cửa sổ 6h / 12h / 24h tính từ now. Liệt kê hotspot (gộp segment theo `hs`) + segment không hotspot có level ≥ 2, sắp theo level max rồi theo giờ sớm nhất. Mỗi dòng: tên, khu vực, chip mức, "khoảng 15:00", nguyên nhân (mưa/triều). Click → fitBounds + nhảy timeline tới giờ peak. Đầu panel: số báo cáo crowd đang active. Disclaimer: "Dự báo heuristic từ mưa (ECMWF qua Open-Meteo) + triều + điểm ngập kinh niên, chưa hiệu chỉnh. Chỉ tham khảo."
- **Popup segment**: tên đường, mức dự báo tại t, lý do (mưa 3h ≈ x mm, triều ≈ y m, điểm ngập kinh niên + nguồn), crowd. Nút "Đang ngập ở đây" (mở form báo cáo tại điểm click) và "Không ngập" (tạo report level 0).
- **Báo ngập**: bấm nút → chế độ chọn vị trí (click map, hoặc "Dùng vị trí của tôi" qua geolocation) → sheet chọn 1 trong 4 band: "Không ngập/đã rút", "Đọng nước (<10cm)", "Ngập 10–30cm", "Ngập sâu >30cm" → Gửi. Chỉ cho báo tại thời điểm hiện tại (nếu timeline không ở now thì tự nhảy về now).
- **Marker báo cáo**: circle marker màu theo level (level 0 màu xanh lá), badge số xác nhận. Popup: mức, "x phút trước", ✅ "Vẫn ngập" (n) / ❌ "Không còn" (m), highlight vote của mình.
- Toast cho lỗi/thành công. Không dùng alert().

## 10. Tide Phú An + DTM (2026-10-08)
Research (đã kiểm, script mẫu ở `<scratchpad>/research-tide-dtm/scripts/`, dữ liệu ở `dl/`): xem báo cáo trong conversation; tóm tắt các số dùng ở dưới.

### 10a. Terrain — FABDEM v1-2 (CC BY-NC-SA 4.0, phi thương mại; POC chấp nhận vì Open-Meteo free cũng phi thương mại)
> **ĐÃ BỎ 2026-10-08** (user decision: low predictive value — chronic hotspot z median ≈ all-road median). Toàn bộ FABDEM/DTM (build, `z`, `dtm.bin`, snapshot `terrain`, popup) đã gỡ; off-hotspot dùng `S_RAIN_BASE` phẳng, không có luật triều. Nội dung dưới giữ làm lịch sử.

- Build (`scripts/build-dtm.mjs` hoặc module trong build-roads): tải tile `N10E106_FABDEM_V1-2.tif` bằng HTTP Range từ zip `https://data.bris.ac.uk/datasets/s5hqmjcdj8yo2ibzi9b4ew3sn/N10E100-N20E110_FABDEM_V1-2.zip` (EOCD → central directory → entry stored, method 0; offset local header ~33,103,661, size 14,427,858 — đọc từ CD, không hardcode). Cache `data/cache/`. Decode: TIFF tiled 256, Deflate (`inflateSync`), predictor 2 trên uint32 words, float32, nodata −9999, PixelIsPoint, tâm pixel (i,j) = (106 + i/3600, 11 − j/3600), EGM2008.
- Đổi datum: `z_HonDau = z_EGM2008 − DTM_DATUM_OFFSET` (0.89, hằng số trong build, ghi vào metadata).
- Nguồn DTM phải là module tách riêng (`source: fabdem`) để sau thay DeltaDTM (CC BY 4.0, 4TU đang 503) mà không đụng phần còn lại.
- Output:
  - `roads.json`: mỗi segment thay `ep` bằng `z` (m Hòn Dấu, 2 chữ số) = **min** của DTM lấy mẫu dọc segment mỗi ~30 m (điểm trũng mới quyết định đọng nước). Bỏ hoàn toàn lưới Open-Meteo elevation (DSM) và cache của nó khỏi build.
  - `public/data/dtm.bin` (Int16, cm, Hòn Dấu, nodata −32768, row-major từ bắc xuống, 1″ crop đúng bbox) + `public/data/dtm.json` (bbox, width, height, step, scale, nodata, source, license, datum, offset). Frontend chỉ tải lazy khi cần snapshot.
- In thống kê: phân bố z của segment (p5/p50/p95), z tại vài điểm kiểm tra (Nguyễn Hữu Cảnh 10.789,106.718 ≈ 1.6; Bến Thành 10.772,106.698 ≈ 5.3).

### 10b. Tide — Phú An (trạm chính thức, hệ Hòn Dấu)
- Mốc báo động Phú An: BĐ I 1.40, BĐ II 1.50, BĐ III 1.60 m (QĐ 05/2020/QĐ-TTg, có trong chú thích bản tin).
- `scripts/fetch-tide.mjs` (chạy tay / cron hằng ngày; `npm run fetch:tide`):
  - Trang danh sách `http://kttvnb.vn/index.php/thong-tin-kttv/thuy-van` (HTTP — cert HTTPS hết hạn) → tìm bài/attachment `HCMC_TVHN_YYYYMMDD.pdf` mới nhất (+ tối đa 14 ngày gần nhất nếu link có trên trang/phân trang; không brute-force id).
  - Parse PDF bằng `node:zlib` (FlateDecode → `BT…ET` → gom theo y → cột theo x), tham khảo `tvhn_node.mjs`. Lấy: thực đo hôm trước Phú An (2 đỉnh + 2 chân, giờ) và dự báo 5 ngày Phú An (2 đỉnh + 2 chân). Layout đổi theo thời gian → parse lỗi thì bỏ file đó, log rõ, không crash.
  - Lấy Open-Meteo marine (10.375,106.958, `sea_level_height_msl`, hourly, cùng khoảng ngày) → `bias = median(OM_peak(t−3h) − PA_obs_peak)` trên các đỉnh thực đo ≥ 1.0 m có được (mặc định 0.60 nếu < 3 cặp).
  - Ghi `public/data/tide-phuan.json`: `{ fetchedAt, source, alerts:{I:1.4,II:1.5,III:1.6}, lagH:3, bias, biasN, observed:[{t, h, kind:"peak"|"low"}], forecast:[{t, h, kind}], bulletins:[url…] }` (thời gian ISO có offset +07:00).
  - Commit sẵn 1 bản hiện tại. Có thể seed `observed` từ `dl/obs.jsonl` của research (đã parse 367 bản tin) để bias ổn định.
- Frontend (`weather.js` + `risk.js`):
  - Đường triều theo giờ tại Phú An: `PA(t) = OM(t − 3h) − bias`. Với ngày có dự báo chính thức: cộng thêm hiệu chỉnh từng ngày để đỉnh cao nhất của ngày khớp đỉnh dự báo chính thức (áp đều cho các giờ trong ngày đó). Hàm thuần, có test.
  - `tide-phuan.json` thiếu hoặc `fetchedAt` > 3 ngày → dùng bias 0.60, banner nhỏ "Số liệu triều Phú An chưa cập nhật".
  - `tideF = smoothstep(TIDE_START=1.40, TIDE_FULL=1.95, PA(t))` (đơn vị Phú An Hòn Dấu; thay hằng 1.7/2.2 và TIDE_LAG_H=2 cũ). Ghi chú "chưa hiệu chỉnh với độ sâu ngập thực".
  - Timeline chart: đường triều vẽ theo PA, thêm 3 vạch ngang mảnh BĐ I/II/III + chấm cho đỉnh dự báo chính thức. Popup segment: "Triều Phú An ≈ x m (BĐ II)".

### 10c. Model dùng địa hình (thay `ep`)
> **ĐÃ BỎ 2026-10-08** (user decision: low predictive value — chronic hotspot z median ≈ all-road median). Toàn bộ FABDEM/DTM (build, `z`, `dtm.bin`, snapshot `terrain`, popup) đã gỡ; off-hotspot dùng `S_RAIN_BASE` phẳng, không có luật triều. Nội dung dưới giữ làm lịch sử.

- Mưa, đoạn không phải hotspot: `sRain = 0.1 + 0.35·(1 − smoothstep(Z_LOW=1.0, Z_HIGH=3.0, z))`.
- Triều, đoạn không phải hotspot (bảo thủ, tránh mô hình "bồn tắm" vì có đê bao/cống ngăn triều): `sTide = 0.45` nếu `z ≤ Z_TIDE=1.2` và `z < PA(t)`, ngược lại 0 → tối đa mức 1 "đọng nước". Hằng số trong `config.js`.
- Hotspot giữ nguyên 0.95 theo cause.
- Popup: "Cao độ nền ≈ z m (FABDEM, Hòn Dấu)".

### 10d. Snapshot báo cáo (bổ sung cho §7b)
- (Đã bỏ 2026-10-08, xem §10a) `terrain: { source:"FABDEM v1-2", datum:"Hòn Dấu (EGM2008 − 0.89)", z }` — z tại điểm báo từ `dtm.bin` (lazy load, nearest pixel), `null` nếu lỗi.
- `tide` thêm: `phuAn` (PA(t) tại giờ báo), `phuAnSource` ("om+3h−bias" | "om+3h−bias+bulletin"), `bias`, `alert` ("<I" | "I" | "II" | "III"), `latestObservedPeak` (từ tide-phuan.json).
- Giữ `seaLevel` Vũng Tàu cũ để so sánh.

### 10e. README
Cập nhật: nguồn + license FABDEM (NC-SA, cần đổi DeltaDTM/GEDTM30 hoặc mua license nếu thương mại), datum offset 0.86–0.89 (tài liệu, chưa đo), fit triều (697 cặp, lag 3 h, bias ~0.60, RMSE ~0.08 cho đỉnh cao), fetch-tide cần chạy hằng ngày, sai số DTM vùng đô thị ~0.6–0.7 m + lún nền chưa tính.

## 11. Báo ngập quá khứ ("báo muộn", 2026-10-08)
- Thêm `reports.observed_at timestamptz not null` = lúc ngập (người dùng chọn), tách khỏi `created_at` (server `now()`).
  - Cho phép `created_at − 48h ≤ observed_at ≤ created_at`. Server kiểm trong trigger: lệch quá 2 phút về tương lai → `raise 'invalid_time'`.
  - Không gửi `observed_at` → `observed_at = now()`.
  - Báo cáo "muộn" khi `created_at − observed_at > 15 phút`. Giới hạn 3 báo cáo muộn / user / 24h (`late_limited`). Rate limit cũ vẫn giữ.
- UI: timeline đang ở quá khứ (trong 48h) thì báo cho đúng giờ đó, không nhảy về now.
  - Sheet có ô chọn giờ, mặc định là giờ timeline hoặc now, bước 15 phút, min now−48h, max now. Hiện dòng "Báo muộn cho T5 08/10 09:30".
  - Timeline ở tương lai → nhảy về now như cũ.
- Hiệu lực: TTL/active tính từ `observed_at`.
  - Báo muộn **không** override màu đường ở mốc now trừ khi còn trong TTL tính từ `observed_at`.
  - Trọng số thấp hơn: confidence báo muộn = `net` (không +1) → cần ≥1 xác nhận mới override.
  - Marker báo muộn viền nét đứt, popup ghi "Báo muộn · gửi lúc …".
- Vote trên báo cáo quá khứ giữ nguyên nghĩa "xác nhận lúc đó có ngập". Popup đổi nhãn nút cho báo muộn: "✅ Đúng, lúc đó ngập" / "❌ Không đúng".
- Snapshot theo `observed_at`:
  - ECMWF + GFS: Open-Meteo dùng `start_hour`/`end_hour` hoặc `past_days=2` rồi cắt ±6h/+3h quanh `observed_at`.
  - Radar: chọn frame gần `observed_at` nếu trong 2h qua, ngược lại `radar: null, radarError: "out_of_range"`.
  - Triều: `PA(observed_at)` từ đường triều đã tải, kèm đỉnh thực đo gần nhất ≤ `observed_at` trong `tide-phuan.json`.
  - Ghi `snapshot.observedAt` và `snapshot.late: true|false`.
- Analog lịch sử (`historicalAnalogs`) và export dùng `observed_at`.
- LocalStore áp cùng luật (48h, 3 báo muộn/24h). Schema idempotent (`add column if not exists`, backfill `observed_at = created_at`). README cập nhật.

## 12. Sửa / rút báo cáo của chính mình (2026-10-08)
- Popup báo cáo của mình có 2 nút: "Sửa" và "Rút báo cáo".
- **Sửa** (chỉ khi chưa có vote nào, `confirms + denies = 0`): đổi vị trí, mức, giờ ngập.
  - Vị trí: bấm "Sửa" → marker kéo được (hoặc chạm map chọn lại), mở lại sheet với mức + giờ hiện tại, nút "Lưu".
  - Giờ ngập vẫn theo luật §11 (≤ 48h tính từ `created_at` gốc, không được tương lai). Chuyển thường ↔ muộn tính lại theo luật, đổi sang muộn thì vẫn tính vào giới hạn 3 báo muộn/24h.
  - Vị trí hoặc giờ đổi → chụp lại snapshot theo vị trí/giờ mới. Lưu `edited_at` (server `now()`), `edit_count`; tối đa 5 lần sửa.
  - Đã có vote → nút "Sửa" disabled, tooltip "Đã có người xác nhận — chỉ có thể rút báo cáo", vì vote gắn với vị trí/mức cũ.
- **Rút báo cáo**: soft delete (`withdrawn_at = now()`), ẩn khỏi map, views, analog lịch sử; export vẫn giữ (có cờ) để làm dữ liệu.
- Supabase: RLS UPDATE chỉ cho chủ báo cáo; trigger BEFORE UPDATE kiểm: không có vote (trừ khi chỉ set `withdrawn_at`), `edit_count < 5`, luật thời gian §11, giữ nguyên `id/user_id/created_at`, bbox check; server set `edited_at`, tăng `edit_count`. Lỗi: `has_votes`, `edit_limit`, `invalid_time`, `late_limited`. Không cho DELETE cứng.
- LocalStore áp cùng luật. Realtime đã nghe UPDATE nên các client khác tự cập nhật.

## 13. Cold start: báo = xác nhận + tô vùng báo cáo (2026-10-08)
- Config `FLOOD_CONFIG.crowd = { MIN_CONFIDENCE: 1, LATE_SELF_CONFIRM: true, ANALOG_MIN_NET: 0 }`, chú thích: khi có nhiều người dùng thì đặt `LATE_SELF_CONFIRM=false`, `ANALOG_MIN_NET=1`.
- `LATE_SELF_CONFIRM=true` → báo muộn có `confidence = 1 + net` như báo thường, tức override màu đường ngay khi chưa có vote.
- Vẫn ẩn và loại khỏi mọi tính toán khi `denies ≥ confirms + 2`.
- Analog lịch sử dùng report có `net ≥ ANALOG_MIN_NET` và không bị ẩn.
  - Supabase view `reports_history`: bỏ lọc `net ≥ 1`, trả đủ 30 ngày (trừ withdrawn), client tự lọc theo config. (§18: thay bằng `flood_cells`, view này bị xoá.)
  - Phía server chỉ giữ điều kiện loại report bị deny.
- Tô vùng:
  - Mỗi report active vẽ `L.circle` bán kính 200 m (đúng bán kính crowd), fill màu level, opacity ~0.15, viền mảnh. Level 0 dùng màu xanh lá.
  - Vẽ trong pane riêng dưới road layer (z ~ 390), non-interactive.
  - Đoạn đường do crowd override: casing trắng dày + line đậm hơn đoạn dự báo, để phân biệt rõ.
  - Báo muộn: vòng tròn viền nét đứt.
- Test cho reportState/analog theo config.

## 14. Analog lịch sử phải thực sự dự báo lại (2026-10-08)
Bug: analog chỉ nâng `sRain` lên 0.95. `rainF = smoothstep(3, 25, R3)` vẫn chặn, nên R3 dự báo < ~10 mm thì không bao giờ ra mức ≥ 1, dù mưa lớn hơn lúc từng ngập. Ngoài ra analog chỉ gắn vào segment trong 200 m; báo ở đường nhỏ (không có trong roads.json) thì không có gì hiện.

Sửa (`risk.js`, hàm thuần + test):
- Analog = mỗi báo cáo ngập lịch sử hợp lệ (§13), gồm `{ level, Rh, PAh, cause }`.
  - `Rh = snapshot.features.ecmwf_ifs.R3`.
  - `PAh = snapshot.tide.phuAn`.
  - `cause = "tide"` nếu `PAh ≥ TIDE_START` và `Rh < ANALOG_RAIN_MIN`; ngược lại `"rain"`.
- Kích hoạt tại giờ t:
  - rain: `R3(t) ≥ max(Rh, ANALOG_RAIN_MIN = 8 mm)` → mức = `level` báo cáo. `R3(t) ≥ 0.7·ngưỡng` → `level − 1` (≥ 0).
  - tide: `PA(t) ≥ PAh − 0.05` → mức = `level`.
  - Lấy max với dự báo heuristic.
- Hằng số (`ANALOG_RAIN_MIN`, tỉ lệ 0.7, dung sai 0.05) trong `config.js` `model`.
- Segment trong 200 m nhận analog như trước. Thêm: forecast trả danh sách analog kích hoạt theo giờ để vẽ.
- UI:
  - Ở giờ tương lai/hiện tại khi analog kích hoạt, vẽ vòng tròn 200 m **nét đứt, fill nhạt hơn**, màu theo mức dự báo, tooltip "Dự báo theo lịch sử: từng ngập {mức} lúc {giờ} khi mưa 3h ≈ Rh mm / triều ≈ PAh m".
  - Vẽ cả khi không có segment nào gần.
  - Panel dự báo liệt kê các analog kích hoạt trong cửa sổ, tên "Điểm từng ngập (người dân báo)" kèm khu vực gần nhất (tên segment gần nhất nếu ≤ 500 m).
- Popup segment: "Từng ngập {mức} khi mưa 3h ≈ Rh mm (n báo cáo)".

## 15. Đường nhỏ tải lười theo ô (2026-10-08)
- Build (`scripts/build-minor.mjs` hoặc bước trong build-roads, dùng lại cache/retry/simplify/split/DTM sampler có sẵn):
  - Overpass `highway ~ residential|unclassified|living_street|service(chỉ khi có name)|pedestrian(có name)` trong bbox.
  - Chia bbox thành ô 0.02° (~2.2 km), mỗi ô 1 request có cache `data/cache/minor-<tile>.json`. Retry/backoff như build chính; ô fail thì log rõ, build fail ở cuối (chạy lại sẽ chỉ tải ô thiếu).
  - Bỏ way đã có trong roads.json (theo OSM id).
  - Mỗi segment: simplify 3 m, cắt ≤ 150 m (`z` đã bỏ 2026-10-08, xem §10a).
  - Hotspot geometry (§4b) cũng áp cho đường nhỏ nếu tên khớp. Đường nhỏ không đổi kết quả của hotspot đã match ở đường lớn; chỉ thêm piece.
  - Output `public/data/minor/<tileId>.json` (format giống `roads.segs`, id segment không trùng đường lớn, ví dụ prefix số lớn hoặc string `m<tile>-<n>`) + `public/data/minor/index.json` (danh sách tile, bbox, số segment, size).
  - In tổng số segment, tổng size, ô lớn nhất.
- Frontend:
  - Tải ô khi zoom ≥ 15 cho các ô giao viewport (+ biên 1 ô).
  - Luôn tải ô chứa report/analog active hoặc lịch sử (để tô quanh điểm báo ở mọi zoom).
  - Cache các ô đã tải.
  - Segment đường nhỏ dùng chung pipeline: forecast matrix (tính thêm cho segment mới, không recompute toàn bộ), crowd override 200 m, analog, popup.
  - Hiển thị đường nhỏ: chỉ vẽ khi level ≥ 1 hoặc hotspot (như đường lớn), weight nhỏ hơn 1 px.
  - BucketIndex nhận thêm segment động.
  - Panel không liệt kê đường nhỏ không phải hotspot (tránh spam), trừ khi có crowd/analog.
- Hiệu năng: đo thời gian tính forecast cho 1 ô (log console.debug), mục tiêu < 50 ms/ô.

## 16. Quét báo chí hằng ngày (backend, 2026-10-08)
- `scripts/fetch-news.mjs` (Node 22, zero deps), chạy local 1 lần/ngày qua Windows Task Scheduler (`scripts/register-cron.ps1`, chạy cả `fetch-tide` + `fetch-news`; chỉ tạo script, KHÔNG tự đăng ký task).
- Nguồn: RSS/chuyên mục thời sự TP.HCM của VnExpress, Tuổi Trẻ, Thanh Niên, VOH, SGGP, Dân Trí, VietNamNet, Người Lao Động (xác minh URL RSS hoạt động).
  - Lọc tiêu đề/mô tả 24h qua theo từ khoá (ngập, triều cường, mưa lớn, dắt bộ, chết máy, …) và có nhắc TP.HCM/tên đường.
  - Tải HTML bài, rút text. Lưu cache URL đã xử lý (`data/cache/news-seen.json`).
- LLM: Anthropic Messages API, model `claude-haiku-5-5`, key từ env `ANTHROPIC_API_KEY` (không ghi ra file/log). Structured output (JSON schema) mỗi bài → danh sách mention:
  `{ street, from?, to?, cross?, ward?, oldDistrict?, observedAt (ISO, giờ ngập theo bài; null nếu không rõ), depthCm?, signals: ["dat_bo","chet_may","ket_xe","sau_30cm"], cause: "rain"|"tide"|"both"|null, quote (≤ 25 từ, nguyên văn) }`.
  Không gửi gì ngoài text bài. Prompt yêu cầu không suy đoán, thiếu thông tin thì null.
- Lọc "nặng mới tính": giữ mention có ít nhất 1 signal. Level 3 nếu `sau_30cm` hoặc `depthCm > 30`; ngược lại level 2.
- Geocode: map mention → geometry §4b (between/junction/near) rồi resolve bằng `scripts/lib/hotspot-geom.mjs` trên roads (đường lớn + minor tiles nếu đã có). Không resolve được → bỏ, ghi log. Bbox lõi.
- Dedupe: cùng street + cùng ngày + midpoint ≤ 300 m → gộp, giữ nhiều source.
- Ghi:
  - `public/data/news-floods.json` (luôn có, cho chế độ local; giữ 90 ngày): `{ id, level, cause, observedAt, publishedAt, signals, geometry(resolved polyline + point), sources:[{url,outlet,date,quote}] }`.
  - Nếu có env `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`: upsert vào bảng `news_reports` (RLS: anon/auth chỉ SELECT; ghi chỉ service role). Schema thêm vào `supabase/schema.sql` (idempotent).
- Log tổng kết: số bài quét/khớp từ khoá/gọi LLM/mention/giữ lại/resolve được, token dùng (từ usage), chi phí ước tính.
- Test (node:test) với fixture: text bài mẫu → (mock LLM response) → lọc signals → geometry → dedupe. Không gọi API thật trong test.
- README: cách đặt env (`setx ANTHROPIC_API_KEY …` do user tự làm), chạy tay, đăng ký cron, chi phí ước tính, bản quyền (chỉ lưu link + trích ≤ 25 từ).

## 17. Lớp báo chí + cụm cộng đồng + heatmap (frontend — làm SAU §15)
- Lớp "Báo chí" (toggle): tô đoạn resolved + icon báo, popup outlet/giờ/trích/link; hiện trên timeline theo `observedAt` với TTL 3h; đưa vào analog lịch sử như report level tương ứng (cause từ bài).
- Cụm cộng đồng: gom reports (+ news, mỗi bài = 1 nguồn) bán kính 150 m, đếm **user khác nhau**.
  - ≥ 3 nguồn trong 6h (§18: trong TTL của từng báo cáo) → "Điểm nóng cộng đồng" (vòng đậm + số lượt), có trong panel.
  - ≥ 3 ngày khác nhau trong 90 ngày → ứng viên kinh niên (nhãn "cộng đồng phát hiện"), hiện cùng lớp điểm kinh niên.
- Heatmap (toggle, mặc định tắt): canvas tự vẽ (không thêm lib), trọng số = level × decay theo tuổi (half-life 3h cho "đang", 30 ngày cho lịch sử, theo chế độ đang xem).

## 18. Hiển thị lâu hơn + lịch sử dài hạn + gộp theo vị trí (2026-10-08)
Hiển thị:
1. TTL báo cáo: config `crowd.REPORT_TTL_H = 6` (base), `+1h`/xác nhận, max `REPORT_TTL_MAX_H = 12`. Cluster hot window = cùng TTL của các report trong cụm (không còn 6h cố định).
2. Sau TTL, trong `FADE_H = 24` h: vẽ mờ (đường nét đứt nhạt, marker xám nhạt, nhãn "đã báo lúc HH:mm"). Không override dự báo, không tính cluster hot.
3. Timeline lùi 48h (khớp báo muộn). Open-Meteo `past_days=2` đủ dữ liệu; marine tương ứng.

Dữ liệu dự báo từ lịch sử:
4. Lịch sử dài hạn:
   - Bỏ giới hạn 30 ngày.
   - Server view `flood_cells` (Supabase): gộp report hợp lệ (không withdrawn/denied, có snapshot) + `news_reports` theo ô ~150 m (lat/lng làm tròn lưới 0.00135°), 730 ngày gần nhất.
   - Mỗi ô trả `cell_id, lat, lng, events jsonb[]`, mỗi event gồm `{t, level, Rh, PAh, cause, source, radarMmH}`.
   - Client tải `flood_cells` thay cho `reports_history`. LocalStore gộp tương tự.
   - Giữ `reports_history` để tương thích hoặc xoá nếu không còn dùng.
5. Lượng mưa thật hơn:
   - **Radar mm/h:** đổi RGBA RainViewer (scheme đang dùng) → dBZ theo bảng màu chính thức của RainViewer (tìm & dẫn nguồn), rồi Marshall–Palmer `R = (10^(dBZ/10)/200)^(1/1.6)`. Snapshot mới lấy mọi frame radar ≤ 60 phút trước `observedAt` tại điểm (nếu trong 2h có sẵn) → `radar.maxMmH`, `radar.frames`. Hàm thuần + test với vài màu mẫu.
   - **Lượng mưa hiệu dụng của event:** `Rh_eff = max(ECMWF R3, GFS R3, radarMaxMmH × 1h)`, ghi rõ nguồn.
   - **Bổ sung sau sự kiện** (cron local hằng ngày, `scripts/enrich-reports.mjs`, chỉ khi có `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`): với report 2–10 ngày tuổi chưa enrich, lấy Open-Meteo Historical Forecast/Archive tại điểm và giờ → `enrichment.R3_obs`. Lưu bảng `report_enrichment(report_id pk, r3_obs, source, fetched_at)`, view `flood_cells` dùng `max(Rh_eff, r3_obs)`. Thêm vào `register-cron.ps1`. Không có key → bỏ qua, log rõ.
6. Ngưỡng theo ô (thay analog từng report):
   - Mỗi ô có events ngập (level ≥ 1) và khô (level 0).
   - Ngưỡng mưa `Tcell` = phân vị 25% của `Rh_eff` các event ngập do mưa, sàn `ANALOG_RAIN_MIN`.
   - Mức dự báo khi `R3(t) ≥ Tcell` = trung vị level của các event ngập có `Rh_eff ≤ R3(t)` (không có thì level nhỏ nhất). `R3(t) ≥ 0.7·Tcell` → level − 1.
   - Nếu số event khô có `Rh_eff ≥ R3(t)` > số event ngập có `Rh_eff ≤ R3(t)` → hạ 1 mức (mẫu âm).
   - Triều: tương tự với `PAh` (sàn `TIDE_START`).
   - Popup/panel: "Ô này ngập n/m lần khi mưa 3h ≥ X mm (nguồn: radar/ECMWF/thực đo)".
   - Hàm thuần + test: 1 event; nhiều event; có mẫu âm; triều.

Đã làm (chốt khi implement):
- `reports_history` bị xoá; `reports_with_votes` mở rộng 96h (48h báo muộn + tối đa 12h TTL + 24h mờ) để timeline lùi 48h vẫn thấy báo cáo; client tải 96h.
- Event thêm `id, lat, lng, net, RhSrc` (+ `outlet` cho tin báo). Report: `cause = null`, client áp luật §14; tin báo: `cause` của bài, `Rh/PAh` lấy từ thời tiết đã tải nếu bài trong cửa sổ 48h. Ô = `floor(lat/0.00135):floor(lng/0.00135)`, tâm ô làm `lat/lng`.
- Trung vị = trung vị cận dưới (mức nguyên). Triều: kích hoạt từ `T − ANALOG_TIDE_TOL`, không có mức "gần" 0.7. `n/m`: n = lần ngập có `Rh_eff ≥ Tcell`, m = n + lần khô có `Rh_eff ≥ Tcell`.
- Radar: bảng "Universal Blue" (scheme 2) từ https://www.rainviewer.com/api/color-schemes.html, tile không làm mượt `0_0` để màu khớp đúng bảng; `public/js/radar-rate.js`.
- Enrich: Open-Meteo Archive (ERA5) trước, Historical Forecast nếu ERA5 chưa có; `scripts/lib/enrich.mjs`, `npm run enrich`.

## 19. Chống spam: Turnstile + "chỉ học khi có bằng chứng" (2026-10-09)
### 19a. Cloudflare Turnstile cho anonymous sign-in
- `config.js`: `turnstileSiteKey: ''` (public key). Rỗng → hành vi cũ (không captcha).
- Có key:
  - Load `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit` khi cần sign-in. Không có session thì render widget (`appearance: 'interaction-only'`, ngôn ngữ vi) vào 1 container nhỏ, lấy token → `supabase.auth.signInAnonymously({ options: { captchaToken } })`.
  - Lỗi/timeout → toast + nút "Thử lại", app vẫn xem được, chỉ chặn báo/vote.
  - Session có sẵn → không gọi captcha.
- Thứ tự bật (README): (1) tạo widget Turnstile, hostname = domain production + `localhost`; (2) điền site key vào config, deploy; (3) Supabase → Auth → Attack Protection → bật Captcha, provider Turnstile, dán secret key. Làm ngược thứ tự → mọi sign-in mới fail.
- CSP/headers: không cần đổi (`_headers` không có CSP).

### 19b. Tách hiển thị và học
- Hiển thị: giữ nguyên (1 báo cáo là hiện, theo config crowd).
- Học (lịch sử `flood_cells` → ngưỡng ô) chỉ dùng event **trusted**:
  - news → trusted.
  - report có **bằng chứng phía server** (không tin snapshot client):
    - `report_enrichment.r3_obs ≥ EVIDENCE_RAIN_MM` (3 mm), hoặc
    - `report_enrichment.pa_obs ≥ 1.40` (BĐ I). Enrich mới tính `pa_obs` = mực Phú An tại `observed_at` từ `tide-phuan.json` (thực đo + đường hiệu chỉnh); file được đọc trong repo khi chạy cron.
  - report được **xác nhận chéo**: ≥ 1 report khác (user khác, không withdrawn/moderated/denied) hoặc 1 news trong 150 m và ±3 h.
  - Chưa enrich (report < 2 ngày hoặc cron chưa chạy) và chưa xác nhận chéo → **provisional**: được học **chỉ nếu** snapshot client có bằng chứng (`Rh_eff ≥ 3` hoặc `PAh ≥ 1.40`). Enrich xong thì kết quả server thay thế (spoof snapshot chỉ sống tới lần enrich).
  - Report khô (level 0) cũng cần cùng điều kiện mới thành mẫu âm.
  - Các trường hợp còn lại → `untrusted`: không học, vẫn hiển thị khi còn TTL.
- Server: view `flood_cells` trả mỗi event thêm `trust: 'trusted'|'provisional'|'untrusted'` + `evidence` (`'obs_rain'|'obs_tide'|'corroborated'|'press'|'client_rain'|'client_tide'|null`). Client lọc `trust !== 'untrusted'`. LocalStore áp cùng luật (pure function chung trong `public/js/trust.js`, SQL mirror cùng ngưỡng).
- Popup/panel ô: ghi số lần ngập đã kiểm chứng, ví dụ "ngập 3/4 lần (2 kiểm chứng thực đo)". Event untrusted không tính.
- Config: `crowd.EVIDENCE_RAIN_MM = 3`, `crowd.EVIDENCE_TIDE_M = 1.40`, `crowd.CORROBORATE_M = 150`, `crowd.CORROBORATE_H = 3`.

## 9. Verify (bắt buộc trước khi báo xong)
- `node --test` pass (risk: smoothstep biên, bilinear, R3, level thresholds; reportState: TTL, ẩn khi bị deny, override; rate limit LocalStore).
- Chạy build thật (mạng) → `public/data/roads.json` có thật, in thống kê hotspot match. Hotspot nào 0 segment → sửa streets/center/radius cho match.
- `node scripts/serve.mjs` chạy, `curl` index + roads.json 200.
- Không cần tự mở browser; orchestrator sẽ verify UI.
