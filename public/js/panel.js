import { LEVELS, fmtHourDay, escapeHtml } from './format.js';
import { sourceLabel } from './clusters.js';

const CAUSE_LABEL = { rain: 'mưa', tide: 'triều' };
const MAX_ROWS = 40;

export class Panel {
  constructor(root, { onPick, onWindowChange }) {
    this.root = root;
    this.list = root.querySelector('#fc-list');
    this.crowd = root.querySelector('#fc-crowd');
    this.hours = 6;
    this.rows = [];
    if (window.matchMedia('(max-width: 720px)').matches) root.classList.add('collapsed');
    root.querySelector('#panel-toggle').addEventListener('click', () => root.classList.toggle('collapsed'));
    root.querySelectorAll('[data-hours]').forEach((btn) => btn.addEventListener('click', () => {
      this.hours = +btn.dataset.hours;
      root.querySelectorAll('[data-hours]').forEach((b) => b.classList.toggle('active', b === btn));
      onWindowChange(this.hours);
    }));
    this.list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-idx]');
      if (row) onPick(this.rows[+row.dataset.idx]);
    });
  }

  setCrowdCount(n) {
    this.crowd.textContent = n ? `${n} báo cáo đang hiệu lực từ người dân` : 'Chưa có báo cáo nào đang hiệu lực';
  }

  // §17: hot crowd clusters at the current time, above the forecast list; click → onPick(cluster).
  setHotClusters(clusters, onPick) {
    if (!this.hot) {
      this.hot = document.createElement('ul');
      this.hot.id = 'fc-hot';
      this.list.before(this.hot);
      this.hot.addEventListener('click', (e) => {
        const row = e.target.closest('[data-idx]');
        if (row) this.onHotPick?.(this.hotRows[+row.dataset.idx]);
      });
    }
    this.onHotPick = onPick;
    this.hotRows = clusters;
    this.hot.innerHTML = clusters.map((c, idx) => `
      <li data-idx="${idx}" class="hot-row">
        <span class="chip hot">Nóng</span>
        <div class="fc-main"><strong>Điểm nóng cộng đồng</strong><small>${sourceLabel(c)}</small></div>
      </li>`).join('');
  }

  render(rows, times) {
    this.rows = rows.slice(0, MAX_ROWS);
    if (!this.rows.length) {
      this.list.innerHTML = `<li class="fc-empty">Không có điểm nào dự báo ngập trong ${this.hours} giờ tới.</li>`;
      return;
    }
    this.list.innerHTML = this.rows.map((r, idx) => `
      <li data-idx="${idx}">
        <span class="chip l${r.level}">${LEVELS[r.level].short}</span>
        <div class="fc-main">
          <strong>${escapeHtml(r.title)}</strong>
          <small>${escapeHtml(r.area || 'Ngoài danh sách điểm ngập kinh niên')}</small>
        </div>
        <div class="fc-meta">
          <span>khoảng ${fmtHourDay(times[r.peakTi])}</span>
          <small>${[...r.causes].map((c) => CAUSE_LABEL[c]).join(' + ')}</small>
        </div>
      </li>`).join('');
  }
}
