'use strict';

(function () {
  const LINE_COLORS = {
    '1': '#e53935', '2': '#1e88e5', '3': '#43a047', '4': '#fb8c00',
    '5': '#8e24aa', '6': '#6d4c41', '7': '#00acc1', '8': '#d81b60',
  };
  const FALLBACK_COLOR = '#757575';

  const map = L.map('map').setView([10.7769, 106.7009], 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  // line -> color from the `color` property of line features (filled after loading)
  const dataColors = {};
  // { lines, zones } once the GeoJSON is loaded
  let lookupData = null;

  function lineColor(line, color) {
    return color || dataColors[String(line)] || LINE_COLORS[String(line)] || FALLBACK_COLOR;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function popup(p, title) {
    const url = p.source && p.source.url;
    let html = '<strong>' + esc(title) + '</strong><br>Tuyến: ' + esc(p.line) +
      '<br>Trạng thái: ' + esc(p.status);
    if (url && /^https?:\/\//.test(url)) {
      html += '<br><a href="' + esc(url) + '" target="_blank" rel="noopener">Nguồn</a>';
    }
    return html;
  }

  const isEstimated = (p) => p.status === 'estimated';
  // planned and estimated features are drawn dashed, approved ones solid
  const isDashed = (p) => p.status === 'planned' || p.status === 'estimated';

  function lineStyle(f) {
    const p = f.properties;
    return {
      color: lineColor(p.line, p.color),
      weight: 4,
      opacity: isEstimated(p) ? 0.55 : isDashed(p) ? 0.75 : 1,
      dashArray: isDashed(p) ? '8 8' : null,
    };
  }

  function zoneStyle(f) {
    const p = f.properties;
    const color = lineColor(p.line);
    const est = isEstimated(p);
    if (p.kind === 'corridor') {
      // influence corridor along the line: light fill, thin dashed outline
      return { stroke: true, color, weight: 1, opacity: 0.7, dashArray: '4 4', fill: true, fillColor: color, fillOpacity: 0.15 };
    }
    if (p.kind === 'pilot') {
      // pilot / priority area: distinct purple dashed outline, almost no fill
      return { stroke: true, color: '#8e24aa', weight: 3, opacity: 0.9, dashArray: '10 6', fill: true, fillColor: '#8e24aa', fillOpacity: 0.04 };
    }
    const base = { color, weight: 2, dashArray: isDashed(p) ? '6 6' : null, opacity: est ? 0.6 : 1 };
    if (p.kind === 'core') {
      return Object.assign(base, { fill: true, fillColor: color, fillOpacity: est ? 0.15 : 0.35 });
    }
    if (p.kind === 'next') {
      // next to TOD: light fill, thin border
      return Object.assign(base, { weight: 1, opacity: 0.5, fill: true, fillColor: color, fillOpacity: est ? 0.08 : 0.12 });
    }
    // 'radius': dashed ring, no fill
    return Object.assign(base, { fill: false, fillOpacity: 0, dashArray: '4 6' });
  }

  function addLegend() {
    const legend = L.control({ position: 'bottomright' });
    legend.onAdd = function () {
      const div = L.DomUtil.create('div', 'legend');
      div.innerHTML =
        '<strong>Chú giải</strong><br>' +
        '<i style="background:rgba(229,57,53,.35)"></i>Lõi TOD (TOD core)<br>' +
        '<i style="background:rgba(229,57,53,.12);border-color:rgba(229,57,53,.5)"></i>Vùng giáp ranh TOD (next to TOD)<br>' +
        '<i style="background:none;border-style:dashed"></i>Bán kính TOD (TOD radius)<br>' +
        '<i style="background:rgba(229,57,53,.15);border:1px dashed rgba(229,57,53,.7)"></i>Hành lang ảnh hưởng tuyến (corridor)<br>' +
        '<i style="background:none;border:2px dashed #8e24aa"></i>Khu TOD thí điểm / ưu tiên<br>' +
        '<hr style="margin:4px 0">' +
        '<i style="background:#555;height:0;border-width:2px 0 0"></i>Đã phê duyệt (approved)<br>' +
        '<i style="background:none;border-width:2px 0 0;border-style:dashed;opacity:.6"></i>Quy hoạch (planned)<br>' +
        '<i style="background:none;border-width:2px 0 0;border-style:dashed;opacity:.4"></i>Ước tính (estimated)';
      return div;
    };
    legend.addTo(map);
  }

  function getJson(url) {
    return fetch(url).then((r) => {
      if (!r.ok) throw new Error(url + ': ' + r.status);
      return r.json();
    });
  }

  Promise.all([getJson('data/metro-lines.geojson'), getJson('data/tod-zones.geojson')])
    .then(([lines, zones]) => {
      for (const f of lines.features) {
        const p = f.properties;
        if (p.type === 'line' && p.color) dataColors[String(p.line)] = p.color;
      }

      lookupData = { lines, zones };

      const sameLine = (f, line) => String(f.properties.line) === String(line);
      const zoneLayer = (filter) => L.geoJSON(zones, {
        filter,
        style: zoneStyle,
        onEachFeature: (f, layer) => layer.bindPopup(popup(f.properties,
          f.properties.kind === 'corridor' ? 'Hành lang ảnh hưởng tuyến'
            : f.properties.kind === 'pilot' ? 'Khu TOD thí điểm / ưu tiên: ' + f.properties.name
              : f.properties.station || 'TOD')),
      });
      const trackLayer = (filter) => L.geoJSON(lines, {
        filter: (f) => f.properties.type !== 'station' && filter(f),
        style: lineStyle,
        onEachFeature: (f, layer) => layer.bindPopup(popup(f.properties, f.properties.name)),
      });

      // pilot zones are not tied to one line: always visible
      zoneLayer((f) => f.properties.kind === 'pilot').addTo(map);

      // one group per line so the line filter can show or hide it
      for (let n = 1; n <= 8; n++) {
        const isLine = (f) => sameLine(f, n);
        const corridor = zoneLayer((f) => f.properties.kind === 'corridor' && isLine(f));
        const group = L.layerGroup([
          corridor,
          zoneLayer((f) => f.properties.kind !== 'corridor' && f.properties.kind !== 'pilot' && isLine(f)),
          trackLayer(isLine),
          stationLayer(isLine),
        ]);
        lineGroups[n] = { group, corridor };
      }
      applyLineFilter();
      showFromHash();
    })
    .catch((err) => {
      console.error(err);
      showResult('Không tải được dữ liệu GeoJSON. Hãy chạy qua máy chủ tĩnh (xem README).', true);
    });

  // --- line filter ---

  const lineGroups = {};

  function applyLineFilter() {
    for (const n of Object.keys(lineGroups)) {
      const box = document.getElementById('line-toggle-' + n);
      const on = !box || box.checked;
      const { group, corridor } = lineGroups[n];
      if (on && !map.hasLayer(group)) {
        group.addTo(map);
        corridor.eachLayer((l) => l.bringToBack());
      } else if (!on && map.hasLayer(group)) {
        map.removeLayer(group);
      }
    }
  }

  for (let n = 1; n <= 8; n++) {
    const box = document.getElementById('line-toggle-' + n);
    if (box) box.addEventListener('change', applyLineFilter);
  }

  function stationLayer(filter) {
    return L.geoJSON(lookupData.lines, {
      filter: (f) => f.properties.type === 'station' && filter(f),
      pointToLayer: (f, latlng) => {
        const p = f.properties;
        const est = isEstimated(p);
        return L.circleMarker(latlng, {
          radius: 6,
          color: lineColor(p.line, p.color),
          weight: 2,
          dashArray: isDashed(p) ? '3 3' : null,
          fillColor: '#fff',
          fillOpacity: est ? 0.5 : 1,
        });
      },
      onEachFeature: (f, layer) => layer.bindPopup(popup(f.properties, f.properties.name)),
    });
  }

  // --- search by address or coordinates ---

  const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=vn' +
    '&viewbox=106.35,11.2,107.05,10.35&bounded=1';
  let marker = null;

  function showResult(text, isError) {
    const panel = document.getElementById('search-result');
    if (!panel) return;
    panel.textContent = text;
    panel.className = isError ? 'error' : '';
  }

  function geocode(text) {
    return fetch(NOMINATIM_URL + '&q=' + encodeURIComponent(text), { headers: { Accept: 'application/json' } })
      .then((r) => {
        if (!r.ok) throw new Error('nominatim: ' + r.status);
        return r.json();
      })
      .then((rows) => {
        const hit = Array.isArray(rows) && rows[0];
        const lat = hit && Number(hit.lat);
        const lon = hit && Number(hit.lon);
        return hit && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon, name: hit.display_name } : null;
      });
  }

  function showPoint(lat, lon, label, fromHash) {
    if (!lookupData) {
      showResult('Dữ liệu bản đồ chưa tải xong, hãy thử lại sau giây lát.', true);
      return;
    }
    const r = HcmTod.describeLookup(lon, lat, lookupData);
    showResult((label ? label + '\n' : '') + r.text, !!r.error);
    if (marker) marker.remove();
    marker = L.marker([lat, lon]).addTo(map);
    map.panTo([lat, lon]);
    if (!fromHash && !r.error) {
      const hash = HcmTod.formatShareHash(lat, lon);
      if (window.history && history.replaceState) history.replaceState(null, '', hash);
      else location.hash = hash;
    }
  }

  // open the point from a shared link such as #p=10.77690,106.70090
  function showFromHash() {
    const p = HcmTod.parseShareHash(location.hash);
    if (p) showPoint(p.lat, p.lon, null, true);
  }
  window.addEventListener('hashchange', () => {
    if (lookupData) showFromHash();
  });

  const copyButton = document.getElementById('share-copy');
  if (copyButton) {
    copyButton.addEventListener('click', () => {
      const status = document.getElementById('share-status');
      const say = (text, isError) => {
        if (!status) return;
        status.textContent = text;
        status.className = isError ? 'error' : '';
      };
      const fallback = () => {
        const input = document.getElementById('share-url');
        if (!input) return say('Không sao chép được liên kết.', true);
        input.value = location.href;
        input.hidden = false;
        input.focus();
        input.select();
        say('Không truy cập được bộ nhớ tạm, hãy nhấn Ctrl+C để sao chép liên kết đã chọn.', true);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(location.href)
          .then(() => say('Đã sao chép liên kết.', false), fallback);
      } else {
        fallback();
      }
    });
  }

  function runSearch(text) {
    const query = String(text || '').trim();
    if (!query) {
      showResult('Hãy nhập địa chỉ hoặc toạ độ (vĩ độ, kinh độ).', true);
      return Promise.resolve();
    }
    const c = HcmTod.parseCoords(query);
    if (c) {
      showPoint(c.lat, c.lon, null);
      return Promise.resolve();
    }
    showResult('Đang tìm địa chỉ...', false);
    return geocode(query).then((g) => {
      if (!g) showResult('Không tìm thấy địa chỉ này trong khu vực TP.HCM.', true);
      else showPoint(g.lat, g.lon, g.name);
    }).catch((err) => {
      console.error(err);
      showResult('Không kết nối được dịch vụ tìm địa chỉ (Nominatim). Hãy kiểm tra mạng và thử lại.', true);
    });
  }

  const form = document.getElementById('search-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      runSearch(document.getElementById('search-input').value);
    });
  }
  map.on('click', (e) => showPoint(e.latlng.lat, e.latlng.lng, null));

  addLegend();
})();
