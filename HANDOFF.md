# HANDOFF — Bản đồ ngập TP.HCM (POC)

Cập nhật: 2026-10-08. Chi tiết thiết kế xem `tasks/spec.md` (§1–§18). Hướng dẫn chạy chi tiết xem `README.md`. Bài học rút ra xem `tasks/lessons.md`.

## Sản phẩm hiện có
Web app tĩnh: Leaflet + OSM, không build step, không dependency npm. Backend: Supabase.

- **Bản đồ:** tô đường theo mức ngập kiểu traffic (<10cm / 10–30cm / >30cm). Có ~20.6k đoạn đường lớn, cộng 78k đoạn đường nhỏ chia theo ô, chỉ tải khi zoom ≥ 15 hoặc khi quanh đó có báo cáo.
- **Timeline kiểu Windy** (−48h → +48h): có nút play và kéo được trên biểu đồ. Biểu đồ gồm mưa trung bình, triều Phú An, mốc báo động I/II/III, đỉnh triều dự báo của KTTV.
- **Dự báo (heuristic, chưa hiệu chỉnh):**
  - Mưa: ECMWF qua Open-Meteo.
  - Triều: trạm Phú An, hiệu chỉnh từ 558 đỉnh thực đo (lag 3h, bias 0.60m).
  - 107 điểm ngập kinh niên lấy từ bài gốc (CSGT, Sở Xây dựng).
  - Ngưỡng theo ô 150m học từ lịch sử báo cáo và báo chí.
- **Người dân báo cáo:**
  - Không cần đăng nhập (Supabase anonymous auth).
  - Báo được cho giờ hiện tại hoặc trong 48h qua.
  - Sửa được khi chưa ai vote; rút báo cáo bất kỳ lúc nào.
  - Vote ✅/❌.
  - Snapshot kèm mỗi báo cáo: ECMWF, GFS, radar (mm/h), triều.
- **Hiển thị báo cáo:** hiệu lực 6h, mỗi xác nhận +1h, tối đa 12h. Hết hiệu lực thì hiện mờ thêm 24h.
- **Cụm điểm nóng** (1 nguồn là đủ, chỉnh được trong config) và **heatmap** (mặc định tắt).
- **Lớp báo chí:** quét RSS 8 báo → Claude Haiku bóc thông tin → chỉ giữ ngập nặng (dắt bộ / chết máy / kẹt xe / >30cm) → khớp vào đoạn đường.
- **Test:** `npm test` → 105/105 pass.

## Chạy
```bash
npm start                 # http://localhost:5173
npm test
npm run fetch:tide        # hằng ngày
npm run fetch:news        # hằng ngày, cần ANTHROPIC_API_KEY
npm run enrich            # hằng ngày, cần SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
npm run build:data        # dựng lại đường lớn + đường nhỏ (Overpass, lâu)
```
- Cron: GitHub Actions `.github/workflows/daily-data.yml` (cần thêm Secrets), hoặc chạy local bằng `scripts/register-cron.ps1` (chưa đăng ký).
- `data/cache/` (~30MB) không nằm trong repo, build lại sẽ tự tải.

## Cấu hình và bí mật
- `public/config.js`: Supabase URL + **publishable key** (được phép lộ, đã có RLS bảo vệ). Repo đang PUBLIC nên key này công khai.
- **Không** commit service role key hoặc Anthropic key. Đặt bằng `setx` trên máy chạy cron.
- Schema: `supabase/schema.sql` (idempotent). Đã chạy trên project hiện tại. Mỗi lần sửa schema phải chạy lại trong SQL Editor.
- Bật Anonymous sign-ins trong Supabase. Khi public thì nên bật thêm captcha (Turnstile).

## Trạng thái dữ liệu thật (2026-10-08)
- Supabase có 1 báo cáo hợp lệ (07/10 19:00, gần Nguyễn Thái Sơn, 10–30cm) và 1 báo cáo test đã rút (`withdrawn_at`), có thể xoá cứng trong dashboard.
- `public/data/news-floods.json`: 3 bản ghi từ lần chạy thử, do agent đóng vai Haiku, chưa gọi API thật.
- `data/cache/news-seen.json` (local, không có trong repo): 24 URL của lần chạy thử.

## Việc còn mở (theo ưu tiên)
1. **Báo chí khớp ít:** chỉ 5/15 tin nặng khớp được đoạn đường.
   - Cần bảng tên cũ → mới, ví dụ D2 → Nguyễn Gia Trí.
   - Tin chỉ có tên đường kèm mốc/phường: tra mốc trên OSM rồi tô 300m, gắn nhãn "ước lượng".
   - 21 bài mới chưa được bóc vì chưa có API key.
2. **Chạy thật lần đầu với Anthropic API**, kiểm `claude-haiku-5-5` với JSON schema hiện tại (chưa từng gọi thật).
3. **Enrich chưa chạy với Supabase thật** (cần service key).
4. **Parser bản tin triều chưa đọc được bố cục 6 cột** (bản tin 06–07/10). Nếu KTTV giữ bố cục mới thì phải sửa `scripts/lib/tvhn.mjs`.
5. **Điểm ngập kinh niên dạng giao lộ vẫn dùng bán kính 250m** (tô rộng 1.4–2.8km do có làn song song). Báo chí đã giảm xuống 120m/60m.
6. **Model:** mọi ngưỡng đều heuristic.
   - ECMWF 9km làm mượt mưa giông.
   - Không dùng địa hình (FABDEM bỏ 2026-10-08): đoạn không phải điểm kinh niên có độ nhạy mưa phẳng 0.1, không có luật triều.
   - Cống ngăn triều Tân Thuận/Phú Định có thể vận hành từ 10/2026 (chưa xác minh) và sẽ làm đổi các điểm ngập triều.
7. **UX:** chú thích trên mobile che marker. Console còn vài lỗi 404/422 vô hại chưa truy ra nguồn.
8. **Production:** Cloudflare Pages (output `public`, xem README → Deploy) + Supabase. Trước khi public: bật Turnstile, đổi tile OSM sang MapTiler/Stadia.

## License và giới hạn dữ liệu
- **Open-Meteo free, RainViewer, OSM tiles:** phi thương mại hoặc lưu lượng nhẹ.
- **Báo chí:** chỉ lưu link + trích dẫn ≤ 25 chữ.

## Sự cố đã xảy ra (để biết)
- Một agent research từng gửi email của user trong User-Agent của 4 request tới overpass-api.de. Đã bỏ và giờ dùng UA chung.
- Một báo cáo test bị ghi nhầm vào Supabase thật, đã rút. Quy tắc: trước khi test thao tác ghi, kiểm `config.js` đang trỏ tới backend nào.
