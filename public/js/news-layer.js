// §17 press layer: resolved news-floods.json records drawn newspaper-style (dark outline + level colour + icon),
// shown on the timeline for NEWS_TTL_MS from observedAt, and turned into history events (§18 cells) like a report.
import { rain3h, phuAnAt } from './risk.js';
import { LEVELS, escapeHtml, fmtDateTime } from './format.js';

const HOUR = 3600_000;
export const NEWS_TTL_MS = 3 * HOUR;
export const SIGNAL_LABELS = { dat_bo: 'Dắt bộ', chet_may: 'Chết máy', ket_xe: 'Kẹt xe', sau_30cm: 'Sâu >30cm', nua_banh: 'Nửa bánh xe' };
const ICON_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2 3h10v9.5a1.5 1.5 0 0 0 1.5 1.5H3.5A1.5 1.5 0 0 1 2 12.5zm11 3h1.5v6.5a1 1 0 0 1-2 0V6zM4 5v3h6V5zm0 4.5v1h6v-1zm0 2v1h6v-1z"/></svg>';

// Article time when the paper gives one, else the publish time (same rule as the backend dedupe/retention).
export const newsMs = (r) => Date.parse(r.observedAt ?? r.publishedAt);
export const newsActive = (r, t) => newsMs(r) <= t && t < newsMs(r) + NEWS_TTL_MS;

// news-floods.json record → history event (cells.js shape). No weather of its own: see withWeather.
export function newsEvent(r) {
  const [lat, lng] = r.geometry?.point ?? [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !(r.level >= 1)) return null;
  const outlets = [...new Set((r.sources ?? []).map((s) => s.outlet).filter(Boolean))];
  return {
    id: r.id, source: 'news', lat, lng, t: r.observedAt ?? r.publishedAt, level: r.level, net: null,
    Rh: null, RhSrc: null, PAh: null, cause: r.cause ?? null, radarMmH: null, outlet: outlets.join(', ') || null,
  };
}

// Press events (from the file or flood_cells) get rain 3 h / Phú An from the loaded weather when it covers their hour.
const TIDE_LOOKBACK_H = 3;

export function withWeather(ev, weather) {
  if (ev.source !== 'news' || ev.Rh != null) return ev;
  const ti = weather.times.indexOf(Math.floor(Date.parse(ev.t) / HOUR) * HOUR);
  if (ti < 0) return ev;
  // Streets stay flooded for hours after the tide peaks, and reporters often note the time on the way down:
  // the event's tide level is the highest Phú An level of the TIDE_LOOKBACK_H hours before it, not the instant value.
  const pas = [];
  for (let k = Math.max(0, ti - TIDE_LOOKBACK_H); k <= ti; k++) pas.push(phuAnAt(weather, k));
  const known = pas.filter((v) => v != null);
  return { ...ev, Rh: rain3h(weather, [ev.lat, ev.lng], ti), RhSrc: 'ecmwf', PAh: known.length ? Math.max(...known) : null };
}

function popupHtml(r) {
  const chips = r.signals.map((s) => `<span class="chip news-sig">${escapeHtml(SIGNAL_LABELS[s] ?? s)}</span>`).join(' ');
  const time = r.observedAt ? `Ghi nhận ${fmtDateTime(Date.parse(r.observedAt))}` : `Bài đăng ${fmtDateTime(Date.parse(r.publishedAt))} (bài không ghi giờ ngập)`;
  const sources = r.sources.map((s) => `<li><strong>${escapeHtml(s.outlet)}</strong> ${escapeHtml(s.date)}: “${escapeHtml(s.quote)}” <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">Đọc bài</a></li>`);
  return `<div class="news-popup"><strong>Báo chí: ${escapeHtml(r.street)}</strong>
    <div><span class="chip l${r.level}">${LEVELS[r.level].label}</span> ${chips}</div>
    <div class="muted">${escapeHtml(time)}</div><ul>${sources.join('')}</ul></div>`;
}

export class NewsLayer {
  constructor(map) {
    const L = globalThis.L;
    this.map = map;
    map.createPane('news').style.zIndex = 430;
    this.renderer = L.svg({ pane: 'news' });
    this.group = L.layerGroup().addTo(map);
    this.items = [];
    this.icon = L.divIcon({ className: 'news-icon', html: ICON_SVG, iconSize: [22, 22] });
  }

  setData(news) {
    const L = globalThis.L;
    this.group.clearLayers();
    this.items = news.filter((r) => r.geometry?.lines?.length && LEVELS[r.level]).map((r) => {
      const popup = () => popupHtml(r);
      const opts = { renderer: this.renderer, pane: 'news', interactive: true };
      const layers = [
        ...r.geometry.lines.map((c) => L.polyline(c, { ...opts, color: '#212121', weight: 9, opacity: 0.9 })),
        ...r.geometry.lines.map((c) => L.polyline(c, { ...opts, color: LEVELS[r.level].color, weight: 4, opacity: 1 })),
        L.marker(r.geometry.point, { icon: this.icon, title: `Báo chí: ${r.street}` }),
      ];
      layers.forEach((l) => l.bindPopup(popup));
      return { r, layer: L.layerGroup(layers), shown: false };
    });
  }

  render(t) {
    for (const it of this.items) {
      const on = newsActive(it.r, t);
      if (on === it.shown) continue;
      it.shown = on;
      if (on) this.group.addLayer(it.layer);
      else this.group.removeLayer(it.layer);
    }
  }

  setVisible(on) {
    if (on) this.group.addTo(this.map);
    else this.group.remove();
  }
}
