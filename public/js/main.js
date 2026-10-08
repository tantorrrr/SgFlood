import { BucketIndex } from './geo.js';
import { Forecast } from './forecast.js';
import { loadWeather, emptyWeather } from './weather.js';
import { crowdEffects, applyCrowd, reportState, observedMs } from './reports.js';
import { createStore, LocalStore, RECENT_MS } from './store.js';
import { RoadLayer } from './road-layer.js';
import { MinorRoads, MINOR_MIN_ZOOM } from './minor-roads.js';
import { RainOverlay } from './rain-overlay.js';
import { Radar } from './radar.js';
import { Timeline } from './timeline.js';
import { Panel } from './panel.js';
import { CrowdOverlay } from './crowd-overlay.js';
import { NewsLayer, newsEvent, withWeather } from './news-layer.js';
import { ReportUI } from './report-ui.js';
import { toast } from './toast.js';
import { captureSnapshot } from './snapshot.js';
import { groupCells, prepareCell } from './cells.js';
import { alertLevel } from './tide.js';
import { LEVELS, escapeHtml, cellTrigger } from './format.js';

const L = window.L;
const CONFIG = window.FLOOD_CONFIG;
const HOUR = 3600_000;
const POLL_MS = 60_000;
const ERRORS = {
  rate_limited: 'Bạn vừa gửi báo cáo. Vui lòng đợi 1 phút (tối đa 10 báo cáo mỗi giờ).',
  own_report: 'Không thể xác nhận báo cáo của chính bạn.',
  late_limited: 'Mỗi người chỉ được gửi 3 báo cáo muộn trong 24 giờ.',
  invalid_time: 'Chỉ báo được cho thời điểm trong 48 giờ qua.',
  has_votes: 'Đã có người xác nhận — chỉ có thể rút báo cáo.',
  edit_limit: 'Đã sửa tối đa 5 lần — chỉ có thể rút báo cáo.',
  withdrawn: 'Báo cáo đã được rút.',
  storage: 'Trình duyệt không cho lưu dữ liệu cục bộ.',
};

function banner(text) {
  const el = document.getElementById('banner');
  el.hidden = false;
  el.insertAdjacentHTML('beforeend', `<div>${escapeHtml(text)}</div>`);
}

function hotspotHtml(h) {
  const status = h.status === 'uncertain' ? ' (chưa chắc chắn)' : '';
  const sources = h.sources.map((s) => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(new URL(s.url).host)}</a> ${escapeHtml(s.date)}: “${escapeHtml(s.quote)}”</li>`);
  return `Điểm ngập kinh niên: ${escapeHtml(h.title)}${status} — năm ${h.years.join(', ')}<ul>${sources.join('')}</ul>`;
}

function createMap() {
  const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([10.78, 106.7], 12);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Mưa/triều: <a href="https://open-meteo.com">Open-Meteo</a> (ECMWF) · Triều Phú An: Đài KTTV Nam Bộ',
  }).addTo(map);
  return map;
}

async function initStore() {
  const store = createStore(CONFIG, localStorage);
  try {
    await store.init();
    if (store.mode === 'local') banner('Chế độ demo cục bộ — chưa kết nối Supabase. Báo cáo chỉ lưu trên trình duyệt này.');
    return store;
  } catch {
    toast('Không kết nối được máy chủ báo cáo — chuyển sang chế độ cục bộ.', 'error');
    const local = new LocalStore(localStorage);
    await local.init();
    banner('Chế độ demo cục bộ — không kết nối được Supabase.');
    return local;
  }
}

async function main() {
  const map = createMap();
  const roads = await fetch('data/roads.json').then((r) => r.json());
  const weather = await loadWeather(roads.bbox).catch(() => {
    banner('Không tải được dữ liệu mưa/triều. Bản đồ vẫn hiển thị điểm ngập kinh niên và báo cáo người dân.');
    return emptyWeather(roads.bbox);
  });
  if (weather.tideOk === false) banner('Không tải được dữ liệu triều — dự báo chỉ dựa trên mưa.');
  else if (weather.tide.stale) banner('Số liệu triều Phú An chưa cập nhật — dùng hiệu chỉnh mặc định (Vũng Tàu trễ 3 giờ − 0.60 m).');

  const { times } = weather;
  const nowHour = Math.floor(Date.now() / HOUR) * HOUR;
  const nowIdx = Math.max(0, times.findIndex((t) => t >= nowHour));
  const fromIdx = Math.max(0, nowIdx - 48);
  const toIdx = Math.min(times.length - 1, nowIdx + 48);

  const { segs } = roads;
  const index = new BucketIndex();
  segs.forEach((s, i) => index.add(i, s.c));
  const forecast = new Forecast(roads, weather, CONFIG.model, index);

  const store = await initStore();
  let reports = [];
  let current = nowIdx;
  let states = [];

  const evalTime = (ti) => Math.min(Date.now(), times[ti] + HOUR - 1);
  const rain = new RainOverlay(map, roads.bbox);
  const radar = new Radar(map);
  const radarNote = document.getElementById('radar-note');
  const roadLayer = new RoadLayer(map, segs, (i, latlng) => segmentPopup(i, latlng));
  const crowdOverlay = new CrowdOverlay(map, { minSources: CONFIG.crowd.CLUSTER_MIN_SOURCES, minReports: CONFIG.crowd.CLUSTER_MIN_REPORTS }, CONFIG.crowd); // §17 clusters + heatmap
  const newsLayer = new NewsLayer(map); // §17 press layer
  let newsEventList = [];

  // Minor-road tiles join the same pipeline: forecast only the new segments, then one batched redraw.
  let redrawQueued = false;
  const minor = new MinorRoads(segs, index, (id, from) => {
    const t0 = performance.now();
    forecast.addSegments(from);
    console.debug(`minor tile ${id}: ${segs.length - from} segs forecast in ${(performance.now() - t0).toFixed(1)} ms`);
    if (redrawQueued) return;
    redrawQueued = true;
    requestAnimationFrame(() => {
      redrawQueued = false;
      renderPanel(panel.hours);
      render(current);
    });
  });
  await minor.init();
  const loadMinorView = () => {
    if (map.getZoom() < MINOR_MIN_ZOOM) return;
    const b = map.getBounds();
    minor.loadView([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]);
  };

  let analogKey = '';
  async function refreshReports() {
    try {
      // Independent sources: a missing history view must not hide live reports (and vice versa).
      const [recentRes, cellsRes] = await Promise.allSettled([store.listReports({ sinceMs: Date.now() - RECENT_MS }), store.listCells()]);
      if (recentRes.status === 'rejected') toast('Không tải được báo cáo mới.', 'error');
      if (cellsRes.status === 'rejected') toast('Không tải được lịch sử ngập (đã chạy lại supabase/schema.sql chưa?).', 'error');
      const recent = recentRes.value ?? reports;
      const cells = cellsRes.value ?? [];
      reports = recent;
      // §18 history: server/local cells + press file (deduped by id), press weather filled from the loaded window.
      const merged = groupCells([...newsEventList, ...cells.flatMap((c) => c.events)])
        .map((c) => ({ ...c, events: c.events.map((e) => withWeather(e, weather)) }));
      const events = merged.flatMap((c) => c.events);
      const history = events.filter((e) => e.source === 'report')
        .map((e) => ({ id: e.id, lat: e.lat, lng: e.lng, level: e.level, observed_at: e.t, confirms: Math.max(0, e.net), denies: 0 }));
      crowdOverlay.setData({ recent, history });
      // Tiles around every report/history point load at any zoom so the area around a report is coloured.
      minor.loadPoints([...recent, ...events].map((r) => [r.lat, r.lng]));
      const analogs = merged.map((c) => prepareCell(c, CONFIG.model, CONFIG.crowd.ANALOG_MIN_NET)).filter(Boolean);
      const key = JSON.stringify(analogs);
      if (key !== analogKey) {
        analogKey = key;
        forecast.setAnalogs(analogs);
        renderPanel(panel.hours);
      }
    } catch {
      toast('Không tải được báo cáo mới.', 'error');
    }
    panel.setCrowdCount(reports.filter((r) => reportState(r, Date.now(), CONFIG.crowd).active).length);
    render(current);
  }

  function render(ti) {
    current = ti;
    const showCrowd = ti <= nowIdx;
    const t = evalTime(ti);
    const effects = showCrowd ? crowdEffects(reports, segs, index, t, CONFIG.crowd) : new Map();
    states = segs.map((_, i) => {
      const crowd = applyCrowd(forecast.level(ti, i), effects.get(i), CONFIG.crowd.MIN_CONFIDENCE);
      return { level: crowd.level, confirmed: crowd.confirmedBy > 0, crowd };
    });
    roadLayer.update(states);
    if (map.hasLayer(rain.overlay)) rain.draw(weather.grid, weather.precip[ti]);
    radarNote.textContent = radar.show(times[ti]) ?? '';
    reportUI.render(showCrowd ? reports : [], t, store.userId, CONFIG.crowd, ti >= nowIdx ? forecast.activeAnalogs(ti) : []);
    panel.setHotClusters(crowdOverlay.render(t, ti >= nowIdx), (c) => map.flyTo(c.latlng, 16));
    newsLayer.render(t);
  }

  function alertText(h) {
    const a = alertLevel(h, weather.tide.alerts);
    return a === '<I' ? 'dưới BĐ I' : `BĐ ${a}`;
  }

  function analogText(hit) {
    return `${cellTrigger(hit)}${hit.count > 1 ? ` (${hit.count} ô lân cận)` : ''}`;
  }

  function segmentPopup(i, latlng) {
    if (reportUI.picking || reportUI.editing) return;
    const seg = segs[i];
    const d = forecast.detail(current, i);
    const st = states[i];
    const h = d.reason.hotspot;
    const lines = [
      `Mưa 3 giờ ≈ ${d.reason.R3.toFixed(1)} mm`,
      d.reason.pa == null ? 'Triều: không có dữ liệu' : `Triều Phú An ≈ ${d.reason.pa.toFixed(2)} m (${alertText(d.reason.pa)})`,
    ];
    if (d.reason.analog) lines.push(analogText(d.reason.analog));
    if (h) lines.push(hotspotHtml(h));
    if (st.crowd.confirmedBy) lines.push(`Đã xác nhận bởi ${st.crowd.confirmedBy} người`);
    if (st.crowd.cleared) lines.push('Người dân báo đã rút nước');

    const el = document.createElement('div');
    el.className = 'seg-popup';
    el.innerHTML = `
      <strong>${escapeHtml(seg.n || 'Đường không tên')}</strong>
      <div><span class="chip l${st.level}">${st.level ? LEVELS[st.level].label : 'Không ngập'}</span></div>
      <ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>
      <div class="vote-row">
        <button data-act="flood">Đang ngập ở đây</button>
        <button data-act="dry">Không ngập</button>
      </div>`;
    el.querySelector('[data-act=flood]').addEventListener('click', () => { map.closePopup(); reportUI.openSheet(latlng); });
    el.querySelector('[data-act=dry]').addEventListener('click', () => { map.closePopup(); submitReport(latlng, 0, pastTime()); });
    L.popup().setLatLng(latlng).setContent(el).openOn(map);
  }

  // Timeline in the past → report for that hour; otherwise for now.
  const pastTime = () => (current < nowIdx ? times[current] : null);

  async function submitReport(latlng, level, observedAt, gps = null) {
    if (current > nowIdx) timeline.set(nowIdx);
    try {
      const snapshot = await captureSnapshot(latlng, { weather, observedAt, gps });
      await store.createReport({ lat: latlng.lat, lng: latlng.lng, level, snapshot, observedAt });
      toast('Đã gửi báo cáo. Cảm ơn bạn!', 'success');
      await refreshReports();
      return true;
    } catch (err) {
      toast(ERRORS[err.code] ?? 'Gửi báo cáo thất bại, thử lại sau.', 'error');
      return false;
    }
  }

  // Position or time changed → re-capture the snapshot for the new place/time; level-only edits keep it.
  async function editReport(report, { latlng, level, observedAt }) {
    try {
      const moved = latlng.lat !== report.lat || latlng.lng !== report.lng || observedAt !== observedMs(report);
      const snapshot = moved ? await captureSnapshot(latlng, { weather, observedAt, createdAt: Date.parse(report.created_at) }) : undefined;
      await store.editReport(report.id, { lat: latlng.lat, lng: latlng.lng, level, observedAt, snapshot });
      toast('Đã lưu báo cáo.', 'success');
      await refreshReports();
      return true;
    } catch (err) {
      toast(ERRORS[err.code] ?? 'Không lưu được báo cáo, thử lại sau.', 'error');
      return false;
    }
  }

  const reportUI = new ReportUI(map, {
    bbox: roads.bbox,
    beforeReport: () => current > nowIdx && timeline.set(nowIdx),
    defaultTime: () => pastTime(),
    onSubmit: submitReport,
    onEdit: editReport,
    onWithdraw: async (report) => {
      try {
        await store.withdrawReport(report.id);
        toast('Đã rút báo cáo.', 'success');
        await refreshReports();
      } catch (err) {
        toast(ERRORS[err.code] ?? 'Không rút được báo cáo.', 'error');
      }
    },
    onVote: async (id, value) => {
      try {
        await store.vote(id, value);
        await refreshReports();
      } catch (err) {
        toast(ERRORS[err.code] ?? 'Không gửi được xác nhận.', 'error');
      }
    },
  });

  const renderPanel = (hours) => panel.render(forecast.summary(nowIdx, Math.min(toIdx, nowIdx + hours)), times);
  const panel = new Panel(document.getElementById('panel'), {
    onWindowChange: renderPanel,
    onPick: (row) => {
      if (row.latlng) map.setView(row.latlng, 16);
      else map.fitBounds(L.latLngBounds(row.segIdx.flatMap((i) => segs[i].c)), { padding: [40, 40], maxZoom: 16 });
      timeline.set(row.peakTi);
    },
  });

  const meanRain = weather.precip.map((p) => p.reduce((a, b) => a + b, 0) / p.length);
  const peaks = weather.tide.forecast
    .filter((e) => e.kind === 'peak')
    .map((e) => ({ ti: (Date.parse(e.t) - times[0]) / HOUR, h: e.h }));
  const tideChart = { pa: weather.pa, alerts: weather.tide.alerts, peaks };
  const timeline = new Timeline(document.getElementById('timeline'), { times, nowIdx, fromIdx, toIdx, meanRain, tide: tideChart }, render);

  document.getElementById('tg-hotspots').addEventListener('change', (e) => roadLayer.setShowHotspots(e.target.checked));
  document.getElementById('tg-hotspots').addEventListener('change', (e) => crowdOverlay.setVisible('chronic', e.target.checked));
  document.getElementById('tg-clusters').addEventListener('change', (e) => crowdOverlay.setVisible('clusters', e.target.checked));
  document.getElementById('tg-news').addEventListener('change', (e) => newsLayer.setVisible(e.target.checked));
  document.getElementById('tg-heat').addEventListener('change', (e) => crowdOverlay.setVisible('heat', e.target.checked));
  document.getElementById('tg-rain').addEventListener('change', (e) => {
    rain.setVisible(e.target.checked);
    render(current);
  });
  document.getElementById('tg-radar').addEventListener('change', async (e) => {
    try {
      radarNote.textContent = (await radar.setEnabled(e.target.checked, times[current])) ?? '';
    } catch {
      e.target.checked = false;
      toast('Không tải được radar RainViewer.', 'error');
    }
  });

  document.getElementById('export-btn').addEventListener('click', async () => {
    try {
      const data = await store.exportAll();
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...data }, null, 2)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `hcmflood-reports-${Date.now()}.json` });
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      toast('Không xuất được dữ liệu.', 'error');
    }
  });

  rain.setVisible(document.getElementById('tg-rain').checked);
  renderPanel(panel.hours);
  timeline.set(nowIdx);
  await refreshReports();
  fetch('data/news-floods.json').then((r) => r.json()).then((d) => {
    const news = d.reports ?? [];
    crowdOverlay.setData({ news });
    newsLayer.setData(news);
    newsEventList = news.map(newsEvent).filter(Boolean);
    return refreshReports();
  }).catch(() => {});
  map.on('moveend', loadMinorView);
  loadMinorView();
  store.subscribe(refreshReports);
  setInterval(refreshReports, POLL_MS);
}

main().catch((err) => {
  console.error(err);
  banner('Không khởi động được ứng dụng. Vui lòng tải lại trang.');
});
