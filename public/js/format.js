const VN_OFFSET_MS = 7 * 3600_000;
const WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const pad = (n) => String(n).padStart(2, '0');
const local = (ms) => new Date(ms + VN_OFFSET_MS);

export const LEVELS = [
  { label: 'Không ngập / đã rút', short: 'Khô', color: '#43a047' },
  { label: 'Đọng nước (<10cm)', short: '<10cm', color: '#4fc3f7' },
  { label: 'Ngập 10–30cm', short: '10–30cm', color: '#1e88e5' },
  { label: 'Ngập sâu >30cm', short: '>30cm', color: '#5e35b1' },
];

export function fmtDateTime(ms) {
  const d = local(ms);
  return `${WEEKDAYS[d.getUTCDay()]} ${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function fmtTime(ms) {
  const d = local(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function fmtHour(ms) {
  return `${pad(local(ms).getUTCHours())}:00`;
}

// "HH:00", plus the weekday when it falls on a different local day than `now`.
export function fmtHourDay(ms, now = Date.now()) {
  const sameDay = local(ms).toISOString().slice(0, 10) === local(now).toISOString().slice(0, 10);
  return sameDay ? fmtHour(ms) : `${fmtHour(ms)} ${WEEKDAYS[local(ms).getUTCDay()]}`;
}

export function fmtDay(ms) {
  const d = local(ms);
  return `${WEEKDAYS[d.getUTCDay()]} ${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`;
}

export function isMidnight(ms) {
  return local(ms).getUTCHours() === 0;
}

export function fmtAgo(ms, now = Date.now()) {
  const min = Math.max(0, Math.round((now - ms) / 60_000));
  if (min < 1) return 'vừa xong';
  if (min < 60) return `${min} phút trước`;
  return `${Math.floor(min / 60)} giờ ${min % 60} phút trước`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const RH_SOURCES = { ecmwf: 'ECMWF', gfs: 'GFS', radar: 'radar', obs: 'thực đo' };

// §18 firing history cell (cells.js cellLevel hit): "Ô này ngập 3/4 lần khi mưa 3h ≥ 12.0 mm (nguồn: radar, ECMWF)".
export function cellTrigger(h) {
  if (h.cause === 'tide') return `Ô này ngập ${h.n}/${h.m} lần khi triều Phú An ≥ ${h.threshold.toFixed(2)} m`;
  const src = h.srcs?.length ? ` (nguồn: ${h.srcs.map((s) => RH_SOURCES[s] ?? s).join(', ')})` : '';
  // Floor ANALOG_RAIN_MIN can lift the threshold above every recorded flood (n = 0): say so instead of "0/0".
  if (!h.n) return `Ô này từng ngập ${h.total} lần với mưa 3h thấp hơn; dự báo từ ngưỡng tối thiểu ${h.threshold.toFixed(1)} mm${src}`;
  return `Ô này ngập ${h.n}/${h.m} lần khi mưa 3h ≥ ${h.threshold.toFixed(1)} mm${src}`;
}
