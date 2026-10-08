import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analogTitle } from '../public/js/forecast.js';
import { newsActive, newsEvent, NEWS_TTL_MS } from '../public/js/news-layer.js';
import { groupCells, prepareCell } from '../public/js/cells.js';

const rec = (o) => ({ id: 'news-x', level: 3, cause: 'rain', street: 'D5', observedAt: '2026-10-07T18:30:00+07:00', publishedAt: '2026-10-07T19:05:00+07:00', signals: ['chet_may'], geometry: { lines: [[[10.8, 106.7], [10.8, 106.71]]], point: [10.8, 106.705] }, sources: [], ...o });
const MODEL = { TIDE_START: 1.4, ANALOG_RAIN_MIN: 5 };

test('newsActive: visible for 3 h from observedAt, publishedAt when the article has no time', () => {
  const r = rec();
  const t = Date.parse(r.observedAt);
  assert.equal(newsActive(r, t - 1), false);
  assert.equal(newsActive(r, t), true);
  assert.equal(newsActive(r, t + NEWS_TTL_MS - 1), true);
  assert.equal(newsActive(r, t + NEWS_TTL_MS), false);
  assert.equal(newsActive(rec({ observedAt: null }), Date.parse('2026-10-07T19:30:00+07:00')), true);
});

test('history cell label names its source: crowd report vs press outlet', () => {
  const [c] = groupCells([newsEvent(rec({ sources: [{ outlet: 'VnExpress' }, { outlet: 'Tuổi Trẻ' }, { outlet: 'VnExpress' }] }))]);
  assert.equal(analogTitle(prepareCell(c, MODEL)), 'Điểm từng ngập (báo chí: VnExpress, Tuổi Trẻ)');
  assert.equal(analogTitle({ source: 'report' }), 'Điểm từng ngập (người dân báo)');
});
