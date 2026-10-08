import { LEVELS, fmtAgo, fmtDateTime, fmtTime, escapeHtml, cellTrigger } from './format.js';
import { reportState, observedMs, editBlock, BACKDATE_MS, LATE_MS, MAX_EDITS, INFLUENCE_M } from './reports.js';
import { toast } from './toast.js';

const L = window.L;
const STEP_MS = 15 * 60_000;
const FADED = '#b0bec5';
const EDIT_BLOCKED = {
  has_votes: 'Đã có người xác nhận — chỉ có thể rút báo cáo',
  edit_limit: `Đã sửa tối đa ${MAX_EDITS} lần — chỉ có thể rút báo cáo`,
};

function weatherAtReport(snap) {
  if (!snap) return '';
  const r3 = (m) => (typeof snap.features?.[m]?.R3 === 'number' ? `${snap.features[m].R3.toFixed(1)} mm` : '—');
  const radar = !snap.radar ? 'không có dữ liệu'
    : typeof snap.radar.maxMmH === 'number' ? (snap.radar.maxMmH > 0 ? `tối đa ${snap.radar.maxMmH.toFixed(1)} mm/h trong 1 giờ trước` : 'không mưa')
      : snap.radar.rgba[3] > 0 ? 'có mưa' : 'không mưa';
  const tide = typeof snap.tide?.phuAn === 'number'
    ? `Phú An ${snap.tide.phuAn.toFixed(2)} m${snap.tide.alert && snap.tide.alert !== '<I' ? ` (BĐ ${snap.tide.alert})` : ''}`
    : typeof snap.tide?.seaLevel === 'number' ? `Vũng Tàu ${snap.tide.seaLevel.toFixed(2)} m` : '—';
  const z = typeof snap.terrain?.z === 'number' ? ` · Cao độ nền ${snap.terrain.z.toFixed(2)} m` : '';
  return `<div class="snap"><b>Thời tiết lúc ngập</b>
    <div>Mưa 3h ECMWF: ${r3('ecmwf_ifs')} · GFS: ${r3('gfs_global')}</div>
    <div>Radar: ${radar} · Triều: ${tide}${z}</div></div>`;
}

export class ReportUI {
  constructor(map, { onSubmit, onEdit, onWithdraw, onVote, beforeReport, defaultTime }) {
    this.map = map;
    this.onSubmit = onSubmit;
    this.onEdit = onEdit;
    this.onWithdraw = onWithdraw;
    this.onVote = onVote;
    this.beforeReport = beforeReport;
    this.defaultTime = defaultTime;
    this.at = document.getElementById('sheet-at');
    this.lateNote = document.getElementById('late-note');
    this.at.addEventListener('change', () => this.showLateNote());
    // Own pane + SVG renderer: the road layer's canvas would otherwise swallow clicks on markers.
    map.createPane('reports').style.zIndex = 450;
    this.renderer = L.svg({ pane: 'reports' });
    // Influence areas sit below the road layer (overlayPane, z 400) and never take clicks.
    map.createPane('report-areas').style.zIndex = 390;
    this.areaRenderer = L.svg({ pane: 'report-areas' });
    this.areas = L.layerGroup().addTo(map);
    this.markers = L.layerGroup().addTo(map);
    this.hint = document.getElementById('pick-hint');
    this.sheet = document.getElementById('report-sheet');
    this.submitBtn = document.getElementById('sheet-submit');
    this.editNote = document.getElementById('edit-note');
    this.pending = null;
    this.picking = false;
    this.editing = null; // { report, marker } while editing an own report

    document.getElementById('report-btn').addEventListener('click', () => this.startPicking());
    document.getElementById('pick-cancel').addEventListener('click', () => this.reset());
    document.getElementById('pick-geo').addEventListener('click', () => this.useMyLocation());
    document.getElementById('sheet-cancel').addEventListener('click', () => this.reset());
    this.sheet.addEventListener('submit', (e) => {
      e.preventDefault();
      const level = new FormData(this.sheet).get('level');
      if (level == null) return;
      const at = this.at.value ? +this.at.value : null;
      if (this.editing) this.saveEdit(+level, at);
      else this.submit(this.pending, +level, at);
    });
    map.on('click', (e) => {
      if (this.editing) this.editing.marker.setLatLng(e.latlng);
      else if (this.picking) this.openSheet(e.latlng);
    });
  }

  startPicking() {
    this.beforeReport();
    this.reset();
    this.picking = true;
    this.hint.hidden = false;
    this.map.getContainer().classList.add('picking');
  }

  useMyLocation() {
    if (!navigator.geolocation) return toast('Trình duyệt không hỗ trợ định vị', 'error');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const latlng = L.latLng(pos.coords.latitude, pos.coords.longitude);
        this.map.setView(latlng, Math.max(this.map.getZoom(), 15));
        this.openSheet(latlng);
      },
      () => toast('Không lấy được vị trí — hãy chạm lên bản đồ', 'error'),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  openSheet(latlng, level = null) {
    this.beforeReport();
    this.reset();
    this.pending = latlng;
    this.sheet.reset();
    if (level != null) this.sheet.querySelector(`input[value="${level}"]`).checked = true;
    this.fillTimes(this.defaultTime());
    this.sheet.hidden = false;
  }

  // Edit an own report: draggable marker (or tap the map) for position, sheet prefilled with level + time.
  startEdit(r) {
    this.map.closePopup();
    this.reset();
    const marker = L.marker([r.lat, r.lng], { draggable: true, autoPan: true }).addTo(this.map);
    this.editing = { report: r, marker };
    this.sheet.reset();
    this.sheet.querySelector(`input[value="${r.level}"]`).checked = true;
    const created = Date.parse(r.created_at);
    const observed = observedMs(r);
    this.fillTimes(observed === created ? null : observed, created);
    this.submitBtn.textContent = 'Lưu';
    this.editNote.hidden = false;
    this.sheet.hidden = false;
  }

  async saveEdit(level, observedAt) {
    const { report, marker } = this.editing;
    const ok = await this.onEdit(report, { latlng: marker.getLatLng(), level, observedAt: observedAt ?? Date.parse(report.created_at) });
    if (ok) this.reset();
  }

  // First option = the reference time (now, or the original send time when editing), then 15-minute steps back 48h.
  fillTimes(selected, ref = null) {
    this.timeRef = ref ?? Date.now();
    const now = this.timeRef;
    const opts = [`<option value="">${ref == null ? 'Bây giờ' : `Lúc gửi (${fmtDateTime(ref)})`}</option>`];
    for (let t = Math.floor(now / STEP_MS) * STEP_MS; t >= now - BACKDATE_MS; t -= STEP_MS) {
      opts.push(`<option value="${t}"${t === selected ? ' selected' : ''}>${fmtDateTime(t)}</option>`);
    }
    this.at.innerHTML = opts.join('');
    this.showLateNote();
  }

  showLateNote() {
    const t = +this.at.value;
    this.lateNote.hidden = !(t && this.timeRef - t > LATE_MS);
    if (!this.lateNote.hidden) this.lateNote.textContent = `Báo muộn cho ${fmtDateTime(t)}`;
  }

  async submit(latlng, level, observedAt) {
    const ok = await this.onSubmit(latlng, level, observedAt);
    if (ok) this.reset();
  }

  reset() {
    this.picking = false;
    this.pending = null;
    this.hint.hidden = true;
    this.sheet.hidden = true;
    this.map.getContainer().classList.remove('picking');
    this.editing?.marker.remove();
    this.editing = null;
    this.submitBtn.textContent = 'Gửi';
    this.editNote.hidden = true;
  }

  // analogs: firing history cells at the shown (current/future) hour (Forecast.activeAnalogs).
  render(reports, t, userId, crowd, analogs = []) {
    this.markers.clearLayers();
    this.areas.clearLayers();
    for (const hit of analogs) this.drawAnalog(hit);
    for (const r of reports) {
      const st = reportState(r, t, crowd);
      if (st.faded) this.drawFaded(r, st, userId);
      if (!st.active) continue;
      L.circle([r.lat, r.lng], {
        pane: 'report-areas', renderer: this.areaRenderer, interactive: false, radius: INFLUENCE_M,
        color: LEVELS[r.level].color, weight: 1, opacity: 0.6, dashArray: st.late ? '6 4' : null,
        fillColor: LEVELS[r.level].color, fillOpacity: 0.15,
      }).addTo(this.areas);
      const m = L.circleMarker([r.lat, r.lng], {
        pane: 'reports', renderer: this.renderer,
        radius: 8, color: st.late ? '#263238' : '#fff', weight: 2, dashArray: st.late ? '3 3' : null,
        fillColor: LEVELS[r.level].color, fillOpacity: 0.95,
      });
      if (r.confirms) m.bindTooltip(`+${r.confirms}`, { permanent: true, direction: 'top', className: 'badge', offset: [0, -6] });
      m.bindPopup(() => this.popup(r, st.late, userId));
      m.addTo(this.markers);
    }
  }

  // §18: after the TTL, FADE_H more as a pale dashed ring + grey marker "đã báo lúc HH:mm"; no override, no cluster.
  drawFaded(r, st, userId) {
    L.circle([r.lat, r.lng], {
      pane: 'report-areas', renderer: this.areaRenderer, interactive: false, radius: INFLUENCE_M,
      color: FADED, weight: 1, opacity: 0.7, dashArray: '4 6', fill: false,
    }).addTo(this.areas);
    L.circleMarker([r.lat, r.lng], {
      pane: 'reports', renderer: this.renderer, radius: 6, color: '#fff', weight: 1, fillColor: FADED, fillOpacity: 0.8,
    })
      .bindTooltip(`${LEVELS[r.level].short} · đã báo lúc ${fmtTime(observedMs(r))}`, { direction: 'top', offset: [0, -4] })
      .bindPopup(() => this.popup(r, st.late, userId))
      .addTo(this.markers);
  }

  // Dashed, fainter area; the circle stays non-interactive, so the tooltip sits on a small centre dot.
  drawAnalog(hit) {
    const { analog: a, level } = hit;
    const color = LEVELS[level].color;
    L.circle([a.lat, a.lng], {
      pane: 'report-areas', renderer: this.areaRenderer, interactive: false, radius: INFLUENCE_M,
      color, weight: 1, opacity: 0.6, dashArray: '2 6', fillColor: color, fillOpacity: 0.07,
    }).addTo(this.areas);
    L.circleMarker([a.lat, a.lng], { pane: 'reports', renderer: this.renderer, radius: 4, color, weight: 1, dashArray: '2 2', fillColor: '#fff', fillOpacity: 0.9 })
      .bindTooltip(escapeHtml(`Dự báo theo lịch sử: ${cellTrigger(hit)} · lần gần nhất ${fmtDateTime(a.at)}`))
      .addTo(this.markers);
  }

  popup(r, late, userId) {
    const el = document.createElement('div');
    el.className = 'report-popup';
    const own = r.user_id === userId;
    const [yes, no] = late
      ? [r.level > 0 ? '✅ Đúng, lúc đó ngập' : '✅ Đúng, lúc đó khô', '❌ Không đúng']
      : r.level > 0 ? ['✅ Vẫn ngập', '❌ Không còn'] : ['✅ Đúng, đã khô', '❌ Vẫn ngập'];
    const when = late
      ? `${fmtDateTime(observedMs(r))} · Báo muộn · gửi lúc ${fmtDateTime(Date.parse(r.created_at))}`
      : fmtAgo(observedMs(r));
    el.innerHTML = `
      <strong>${LEVELS[r.level].label}</strong>
      <div class="muted">${when}${own ? ' · báo cáo của bạn' : ''}</div>
      ${weatherAtReport(r.snapshot)}
      <div class="vote-row">
        <button data-v="1" class="${r.myVote === 1 ? 'mine' : ''}" ${own ? 'disabled' : ''}>${yes} (${r.confirms})</button>
        <button data-v="-1" class="${r.myVote === -1 ? 'mine' : ''}" ${own ? 'disabled' : ''}>${no} (${r.denies})</button>
      </div>
      ${own ? `<div class="vote-row">
        <button data-act="edit">Sửa</button>
        <button data-act="withdraw" class="ghost">Rút báo cáo</button>
      </div>` : ''}`;
    if (own) {
      const editBtn = el.querySelector('[data-act=edit]');
      const block = editBlock(r);
      if (block) Object.assign(editBtn, { disabled: true, title: EDIT_BLOCKED[block] ?? '' });
      editBtn.addEventListener('click', () => this.startEdit(r));
      el.querySelector('[data-act=withdraw]').addEventListener('click', async () => {
        if (!confirm('Rút báo cáo này? Báo cáo sẽ bị ẩn khỏi bản đồ.')) return;
        await this.onWithdraw(r);
        this.map.closePopup();
      });
    }
    el.querySelectorAll('button[data-v]').forEach((b) => b.addEventListener('click', async () => {
      await this.onVote(r.id, +b.dataset.v);
      this.map.closePopup();
    }));
    return el;
  }
}
