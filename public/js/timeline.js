import { fmtDateTime, fmtDay, isMidnight } from './format.js';

const PLAY_MS = 500;

export class Timeline {
  constructor(root, { times, nowIdx, fromIdx, toIdx, meanRain, tide }, onChange) {
    this.root = root;
    this.times = times;
    this.nowIdx = nowIdx;
    this.from = fromIdx;
    this.to = toIdx;
    this.onChange = onChange;
    this.timer = null;

    this.slider = root.querySelector('#tl-slider');
    this.label = root.querySelector('#tl-label');
    this.playBtn = root.querySelector('#tl-play');
    Object.assign(this.slider, { min: fromIdx, max: toIdx, step: 1 });

    this.slider.addEventListener('input', () => this.set(+this.slider.value));
    this.bindScrub(root.querySelector('.tl-track'), meanRain, tide);
    this.playBtn.addEventListener('click', () => this.toggle());
    root.querySelector('#tl-now').addEventListener('click', () => this.set(this.nowIdx));
    document.addEventListener('keydown', (e) => this.onKey(e));

    this.drawChart(root.querySelector('#tl-chart'), meanRain, tide);
    this.drawTicks(root.querySelector('#tl-ticks'));
    new ResizeObserver(() => this.drawChart(root.querySelector('#tl-chart'), meanRain, tide)).observe(this.slider);
  }

  get value() {
    return +this.slider.value;
  }

  set(ti) {
    const v = Math.max(this.from, Math.min(this.to, ti));
    this.slider.value = v;
    const rel = v === this.nowIdx ? ' · Bây giờ' : v > this.nowIdx ? ' · Dự báo' : ' · Đã qua';
    this.label.textContent = fmtDateTime(this.times[v]) + rel;
    this.onChange(v);
  }

  toggle() {
    if (this.timer) return this.stop();
    if (this.value >= this.to) this.set(this.from);
    this.playBtn.textContent = '⏸';
    this.timer = setInterval(() => {
      if (this.value >= this.to) return this.stop();
      this.set(this.value + 1);
    }, PLAY_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.playBtn.textContent = '▶';
  }

  onKey(e) {
    if (e.target.closest?.('input, textarea, select, button')) return;
    if (e.code === 'Space') { e.preventDefault(); this.toggle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); this.set(this.value - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); this.set(this.value + 1); }
  }

  // Windy-style: drag anywhere on the chart/ticks to scrub; hover shows the hour's rain and tide.
  bindScrub(track, meanRain, tide) {
    const tip = this.root.querySelector('#tl-tip');
    const indexAt = (e) => {
      const r = track.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      return Math.round(this.from + f * (this.to - this.from));
    };
    const showTip = (e) => {
      const ti = indexAt(e);
      const pa = tide.pa[ti];
      tip.textContent = `${fmtDateTime(this.times[ti])} · mưa ${meanRain[ti].toFixed(1)} mm` + (pa == null ? '' : ` · triều ${pa.toFixed(2)} m`);
      tip.style.left = `${this.xOf(ti)}%`;
      tip.hidden = false;
    };
    track.addEventListener('pointerdown', (e) => {
      if (e.target === this.slider) return;
      track.setPointerCapture(e.pointerId);
      this.stop();
      this.set(indexAt(e));
    });
    track.addEventListener('pointermove', (e) => {
      if (e.target === this.slider) return;
      showTip(e);
      if (track.hasPointerCapture(e.pointerId)) {
        const ti = indexAt(e);
        if (ti !== this.value) this.set(ti);
      }
    });
    track.addEventListener('pointerleave', () => { tip.hidden = true; });
  }

  xOf(ti) {
    return ((ti - this.from) / (this.to - this.from)) * 100;
  }

  drawTicks(el) {
    const parts = [`<span class="tl-nowmark" style="left:${this.xOf(this.nowIdx)}%"></span>`];
    for (let ti = this.from; ti <= this.to; ti++) {
      if (isMidnight(this.times[ti])) parts.push(`<span class="tl-day" style="left:${this.xOf(ti)}%">${fmtDay(this.times[ti])}</span>`);
    }
    el.innerHTML = parts.join('');
  }

  drawChart(canvas, meanRain, tide) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const n = this.to - this.from + 1;
    const bw = w / n;
    const maxRain = Math.max(5, ...meanRain.slice(this.from, this.to + 1));
    ctx.fillStyle = '#64b5f6';
    for (let k = 0; k < n; k++) {
      const v = meanRain[this.from + k];
      const bh = (v / maxRain) * (h - 2);
      if (v > 0) ctx.fillRect(k * bw + 0.5, h - bh, Math.max(1, bw - 1), bh);
    }
    this.drawTide(ctx, w, h, bw, tide);
  }

  // Phú An curve (Hòn Dấu) with alert lines BĐ I/II/III and official forecast peaks as dots.
  drawTide(ctx, w, h, bw, { pa, alerts, peaks }) {
    const vals = pa.slice(this.from, this.to + 1);
    const valid = vals.filter((v) => v != null);
    if (!valid.length) return;
    const shown = peaks.filter((p) => p.ti >= this.from && p.ti <= this.to);
    const lo = Math.min(...valid);
    const hi = Math.max(...valid, alerts.III + 0.05, ...shown.map((p) => p.h));
    const yOf = (v) => h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4);
    const xOf = (ti) => (ti - this.from + 0.5) * bw;

    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (const [lvl, color] of [['I', '#fdd835'], ['II', '#fb8c00'], ['III', '#e53935']]) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, yOf(alerts[lvl]));
      ctx.lineTo(w, yOf(alerts[lvl]));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    ctx.strokeStyle = '#ffb74d';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    vals.forEach((v, k) => {
      if (v == null) { started = false; return; }
      if (started) ctx.lineTo(xOf(this.from + k), yOf(v));
      else { ctx.moveTo(xOf(this.from + k), yOf(v)); started = true; }
    });
    ctx.stroke();

    ctx.fillStyle = '#e65100';
    for (const p of shown) {
      ctx.beginPath();
      ctx.arc(xOf(p.ti), yOf(p.h), 2.5, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
}
