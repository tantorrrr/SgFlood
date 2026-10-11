import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pdfTextRuns, parseBulletin, rowEvents, dateFromLabel, parseClock, isTvhnTitle } from '../scripts/lib/tvhn.mjs';

test('rowEvents maps 8 columns to 2 peaks + 2 lows and skips "ct" cells', () => {
  const ev = rowEvents(['1.60', '16.30', '1.61', '4.00', 'ct', 'ct', '-0.81', '11.00'], '2026-10-10');
  assert.deepEqual(ev, [
    { t: '2026-10-10T16:30:00+07:00', h: 1.6, kind: 'peak' },
    { t: '2026-10-10T04:00:00+07:00', h: 1.61, kind: 'peak' },
    { t: '2026-10-10T11:00:00+07:00', h: -0.81, kind: 'low' },
  ]);
  assert.throws(() => rowEvents(['1.60', '16.30'], '2026-10-10'), /expected 8 columns/);
  assert.throws(() => rowEvents(['9.60', '16.30', '1', '1', '1', '1', '1', '1'], '2026-10-10'), /implausible/);
});

test('parseClock / dateFromLabel', () => {
  assert.equal(parseClock('0.00'), '00:00');
  assert.equal(parseClock('5:30'), '05:30');
  assert.equal(parseClock('ct'), null);
  assert.equal(dateFromLabel('09/10', '2026-10-08'), '2026-10-09');
  assert.equal(dateFromLabel('02/01', '2026-12-30'), '2027-01-02');
  assert.equal(dateFromLabel('31/12', '2027-01-01'), '2026-12-31');
});

test('parseBulletin on synthetic runs picks the Phú An observed row and its forecast block', () => {
  const row = (y, vals) => vals.map((t, k) => ({ x: 180 + k * 40, y, t }));
  const runs = [
    { x: 50, y: 400, t: 'Phú An' }, { x: 111, y: 400, t: 'Sài Gòn' }, ...row(400, ['1.02', '13.00', '1.36', '2.00', '-1.43', '20.00', '0.06', '9.00']),
    { x: 50, y: 388, t: 'Nhà Bè' }, ...row(388, ['1.00', '12.00', '1.40', '1.00', '-1.69', '19.30', '0.01', '7.30']),
    // forecast: Phú An block (label mid-block) then Nhà Bè block, dates restart
    ...['08/10', '09/10'].flatMap((d, k) => [{ x: 128, y: 320 - 12 * k, t: d }, ...row(320 - 12 * k, ['1.27', '14.00', '1.44', '3.00', '-1.31', '21.00', '-0.22', '10.00'])]),
    { x: 64, y: 314, t: 'Phú An' },
    ...['08/10', '09/10'].flatMap((d, k) => [{ x: 128, y: 296 - 12 * k, t: d }, ...row(296 - 12 * k, ['1.25', '13.00', '1.48', '1.30', '-1.55', '20.00', '-0.35', '8.30'])]),
    { x: 64, y: 290, t: 'Nhà Bè' },
  ];
  const { observed, forecast } = parseBulletin(runs, '2026-10-08');
  assert.deepEqual(observed.map((e) => [e.t.slice(0, 16), e.h]), [['2026-10-07T13:00', 1.02], ['2026-10-07T02:00', 1.36], ['2026-10-07T20:00', -1.43], ['2026-10-07T09:00', 0.06]]);
  assert.equal(forecast.length, 8);
  assert.ok(forecast.every((e) => e.h !== 1.25));
  assert.equal(forecast[4].t, '2026-10-09T14:00:00+07:00');
  assert.throws(() => parseBulletin(runs.filter((r) => r.t !== 'Phú An'), '2026-10-08'), /not found/);
});

test('real bulletin HCMC_TVHN_20261008.pdf: Phú An observed 07/10 and 5-day forecast', () => {
  const { observed, forecast } = parseBulletin(pdfTextRuns(readFileSync(new URL('./fixtures/HCMC_TVHN_20261008.pdf', import.meta.url))), '2026-10-08');
  assert.deepEqual(observed.filter((e) => e.kind === 'peak').map((e) => [e.t, e.h]), [['2026-10-07T13:00:00+07:00', 1.02], ['2026-10-07T02:00:00+07:00', 1.36]]);
  const peaks = forecast.filter((e) => e.kind === 'peak');
  assert.equal(peaks.length, 10);
  assert.deepEqual(peaks.slice(0, 2).map((e) => [e.t, e.h]), [['2026-10-08T14:00:00+07:00', 1.27], ['2026-10-08T03:00:00+07:00', 1.44]]);
  assert.deepEqual(peaks.at(-2), { t: '2026-10-12T17:30:00+07:00', h: 1.67, kind: 'peak' });
  assert.equal(forecast.filter((e) => e.kind === 'low').length, 9); // one "ct"
});

test('isTvhnTitle accepts the daily HCMC bulletin titles only', () => {
  assert.ok(isTvhnTitle('BẢN TIN DỰ BÁO THỦY VĂN HẠN NGẮN KHU VỰC TP. HỒ CHÍ MINH RA NGÀY 08-10-2026'));
  assert.ok(isTvhnTitle('BẢN TIN DỰ BÁO THỦY VĂN TPHCM - ra ngày 04-10-2026'));
  assert.ok(isTvhnTitle('TIN DỰ BÁO THỦY VĂN TP HCM NGÀY 27-09-2026'));
  assert.ok(!isTvhnTitle('TIN TRIỀU CƯỜNG TRÊN SÔNG SÀI GÒN - RA NGÀY 08-10-2026'));
  assert.ok(!isTvhnTitle('BẢN TIN DỰ BÁO HẢI VĂN VÙNG BIỂN TP.HỒ CHÍ MINH 10 NGÀY TỚI - NGÀY 08-10-2026'));
});

test('real bulletin HCMC_TVHN_20261006.pdf: blank first-peak column keeps values in their slots', () => {
  const { observed, forecast } = parseBulletin(pdfTextRuns(readFileSync(new URL('./fixtures/HCMC_TVHN_20261006.pdf', import.meta.url))), '2026-10-06');
  assert.deepEqual(observed, [
    { t: '2026-10-05T00:00:00+07:00', h: 1.1, kind: 'peak' },
    { t: '2026-10-05T18:00:00+07:00', h: -1.42, kind: 'low' },
  ]);
  assert.equal(forecast.length, 20);
  assert.deepEqual(forecast.at(-4), { t: '2026-10-10T16:30:00+07:00', h: 1.54, kind: 'peak' });
});

import { parseFeedItems, isCandidateTitle, tvhnAttachments, firstOffsetAtOrBefore } from '../scripts/lib/tvhn.mjs';

test('parseFeedItems reads title/link/date', () => {
  const xml = '<item><title>A</title><link>https://x/1</link><pubDate>Sun, 21 Dec 2025 02:33:07 +0000</pubDate></item><item><title>B</title><link>http://x/2</link><pubDate>bad</pubDate></item>';
  const items = parseFeedItems(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].link, 'http://x/1');
  assert.equal(items[0].date, Date.parse('2025-12-21T02:33:07Z'));
  assert.ok(Number.isNaN(items[1].date));
});

test('isCandidateTitle keeps thuy van items, drops other products', () => {
  assert.ok(isCandidateTitle('TIN DỰ BÁO THỦY VĂN TP.HCM NGÀY 04-08-2022'));
  assert.ok(isCandidateTitle('BẢN TIN DỰ BÁO THỦY VĂN HẠN NGẮN KHU VỰC TP. HỒ CHÍ MINH'));
  assert.ok(!isCandidateTitle('TIN TRIỀU CƯỜNG TRÊN SÔNG SÀI GÒN'));
  assert.ok(!isCandidateTitle('TIN CẢNH BÁO LŨ TRÊN HỆ THỐNG SÔNG LA NGÀ'));
});

test('tvhnAttachments extracts date + path', () => {
  assert.deepEqual(tvhnAttachments('<a href="/attachments/article/29319/HCMC_TVHN_20261011.pdf">x</a> HOCM_XTND_20250921_1400.pdf'), [['20261011', 'attachments/article/29319/HCMC_TVHN_20261011.pdf']]);
});

test('firstOffsetAtOrBefore finds the page where the target date starts', async () => {
  // newest-first feed, 10 items/page, one item per hour descending from t=1000h
  const total = 3000;
  const firstDate = async (o) => (o >= total ? null : (1000 * 1 - o) * 3600e3);
  const target = (1000 - 1234) * 3600e3; // item index 1234
  assert.equal(await firstOffsetAtOrBefore(firstDate, target, 10), 1240); // first page whose head is <= target (caller steps back one page)
  assert.equal(await firstOffsetAtOrBefore(firstDate, 5000 * 3600e3, 10), 0);
  assert.equal(await firstOffsetAtOrBefore(firstDate, -1e15, 10), 3000); // past the end
});
