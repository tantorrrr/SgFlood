// Parser for Đài KTTV Nam Bộ "HCMC_TVHN_YYYYMMDD.pdf" (Excel → PDF, FlateDecode streams, WinAnsi literals).
// Extracts Phú An observed peaks/lows of the previous day and the 5-day Phú An forecast.
import { inflateSync } from 'node:zlib';

const STATION = 'Phú An';
const LABEL_MAX_X = 100; // station names column
const DATE_X = [110, 150]; // forecast date column
const VALUE_MIN_X = 150;
const ROW_TOL = 3;
const GROUP_GAP = 20;

function unescapePdf(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) => {
    if (/^[0-7]/.test(c)) return String.fromCharCode(parseInt(c, 8));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c] ?? c;
  });
}

// Text runs {x, y, t} from every inflatable content stream (only BT…ET blocks positioned with Tm).
export function pdfTextRuns(buf) {
  const runs = [];
  let i = 0;
  while ((i = buf.indexOf('stream', i)) !== -1) {
    let s = i + 6;
    if (buf[s] === 0x0d) s++;
    if (buf[s] === 0x0a) s++;
    const e = buf.indexOf('endstream', s);
    if (e < 0) break;
    i = e + 9;
    let text;
    try { text = inflateSync(buf.subarray(s, e)).toString('latin1'); } catch { continue; }
    for (const m of text.matchAll(/BT([\s\S]*?)ET/g)) {
      const tm = m[1].match(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/);
      if (!tm) continue;
      const t = [...m[1].matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((x) => unescapePdf(x[1])).join('').trim();
      if (t) runs.push({ x: +tm[5], y: +tm[6], t });
    }
  }
  return runs;
}

const pad = (n) => String(n).padStart(2, '0');
const addDays = (iso, d) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86400_000).toISOString().slice(0, 10);

export function parseHeight(tok) {
  return /^-?\d+\.\d\d$/.test(tok) ? Number(tok) : null; // "ct", "*", "-" → no value
}

export function parseClock(tok) {
  const m = /^(\d{1,2})[.:](\d\d)$/.exec(tok);
  if (!m || +m[1] > 24 || +m[2] > 59) return null;
  return +m[1] === 24 ? '00:00' : `${pad(+m[1])}:${m[2]}`;
}

// 8 tokens: H1 t1 H2 t2 (peaks) L1 t1 L2 t2 (lows) → events on `date` (YYYY-MM-DD, +07:00).
export function rowEvents(tokens, date) {
  if (tokens.length !== 8) throw new Error(`expected 8 columns, got ${tokens.length}: ${tokens.join(' ')}`);
  const out = [];
  for (let k = 0; k < 4; k++) {
    const h = parseHeight(tokens[2 * k]);
    const clock = parseClock(tokens[2 * k + 1]);
    if (h == null || clock == null) continue;
    if (h < -3 || h > 3) throw new Error(`implausible height ${h}`);
    out.push({ t: `${date}T${clock}:00+07:00`, h, kind: k < 2 ? 'peak' : 'low' });
  }
  return out;
}

// Year for a "dd/mm" label near the bulletin date (handles the Dec → Jan rollover).
export function dateFromLabel(label, bulletinDate) {
  const [d, m] = label.split('/').map(Number);
  let y = Number(bulletinDate.slice(0, 4));
  const bm = Number(bulletinDate.slice(5, 7));
  if (bm === 12 && m === 1) y++;
  if (bm === 1 && m === 12) y--;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function valuesAt(runs, y) {
  return runs.filter((r) => r.x > VALUE_MIN_X && Math.abs(r.y - y) < ROW_TOL).sort((a, b) => a.x - b.x).map((r) => r.t);
}

// runs → { observed, forecast } for Phú An. Throws when the layout is not recognised.
export function parseBulletin(runs, bulletinDate) {
  const dateRuns = runs
    .filter((r) => r.x >= DATE_X[0] && r.x <= DATE_X[1] && /^\d\d\/\d\d$/.test(r.t))
    .sort((a, b) => b.y - a.y);
  const groups = [];
  for (const r of dateRuns) {
    const g = groups.at(-1);
    // A new block starts on a y gap or when the date sequence restarts (next station).
    if (g && g.at(-1).y - r.y <= GROUP_GAP && !g.some((x) => x.t === r.t)) g.push(r);
    else groups.push([r]);
  }
  const labels = runs.filter((r) => r.x < LABEL_MAX_X && r.t.normalize('NFC').startsWith(STATION));
  const inGroup = (y) => groups.find((g) => y <= g[0].y + 8 && y >= g.at(-1).y - 8);

  const obsLabel = labels.find((l) => !inGroup(l.y) && valuesAt(runs, l.y).length >= 6);
  if (!obsLabel) throw new Error('observed Phú An row not found');
  const observed = rowEvents(valuesAt(runs, obsLabel.y), addDays(bulletinDate, -1));

  const fcLabel = labels.find((l) => inGroup(l.y));
  if (!fcLabel) throw new Error('forecast Phú An block not found');
  const forecast = [];
  for (const r of inGroup(fcLabel.y)) {
    try {
      forecast.push(...rowEvents(valuesAt(runs, r.y), dateFromLabel(r.t, bulletinDate)));
    } catch { /* one incomplete forecast day: skip the row, keep the rest */ }
  }
  if (!observed.some((e) => e.kind === 'peak')) throw new Error('no observed peak');
  if (!forecast.some((e) => e.kind === 'peak')) throw new Error('no forecast peak');
  return { observed, forecast };
}

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();

// Feed items that are the daily "dự báo thủy văn … TP HCM" bulletin (titles vary between days).
export function isTvhnTitle(title) {
  const t = fold(title);
  return /thuy van/.test(t) && /(tp\.?\s*hcm|tphcm|ho chi minh)/.test(t)
    && !/(hai van|trieu cuong|canh bao|nhan dinh|lien ho|thang|10 ngay)/.test(t);
}
