// Claude Messages API call for the press scan (§16): article text → flood mentions (structured JSON output).
// Raw fetch (zero npm deps). The key is only passed in the request header, never logged.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SIGNALS } from './news.mjs';

const API = 'https://api.anthropic.com/v1/messages';
export const MODEL = 'claude-haiku-5-5';
export const PRICE_PER_MTOK = { input: 0.10, output: 0.50 }; // USD, prompts ≤ 100K tokens

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const MENTION = {
  type: 'object',
  properties: {
    street: { type: 'string' },
    from: nullable({ type: 'string' }),
    to: nullable({ type: 'string' }),
    cross: nullable({ type: 'string' }),
    ward: nullable({ type: 'string' }),
    oldDistrict: nullable({ type: 'string' }),
    observedAt: nullable({ type: 'string' }),
    depthCm: nullable({ type: 'integer' }),
    signals: { type: 'array', items: { type: 'string', enum: SIGNALS } },
    cause: nullable({ type: 'string', enum: ['rain', 'tide', 'both'] }),
    quote: { type: 'string' },
  },
  required: ['street', 'from', 'to', 'cross', 'ward', 'oldDistrict', 'observedAt', 'depthCm', 'signals', 'cause', 'quote'],
  additionalProperties: false,
};
export const SCHEMA = {
  type: 'object',
  properties: { mentions: { type: 'array', items: MENTION } },
  required: ['mentions'],
  additionalProperties: false,
};

const SYSTEM = `Bạn trích xuất các điểm ngập đường phố ở TP.HCM từ một bài báo tiếng Việt.
Mỗi đoạn đường/giao lộ bị ngập được nhắc trong bài = 1 mention. Chỉ dùng thông tin có trong bài, không suy đoán; thiếu thì để null.
- street: tên đường bị ngập, viết như trong bài, bỏ chữ "đường".
- from/to: hai đầu đoạn ngập nếu bài ghi "từ … đến …"; cross: đường cắt ngang nếu bài chỉ nói giao lộ / "đoạn gần …".
- ward/oldDistrict: phường / quận cũ nếu bài ghi.
- observedAt: thời điểm ngập theo bài, ISO 8601 có +07:00; dùng ngày đăng để hiểu "sáng nay", "tối qua"; không rõ giờ thì null.
- depthCm: độ sâu nước nếu bài ghi số (cm).
- signals: dat_bo (người dắt bộ xe), chet_may (xe chết máy), ket_xe (kẹt xe do ngập), sau_30cm (bài nói nước sâu trên 30 cm / ngập quá bánh xe / ngang đầu gối trở lên).
- cause: rain (mưa), tide (triều cường), both, null nếu bài không nói.
- quote: câu trích nguyên văn từ bài, tối đa 25 từ, chứng minh mention.
Bỏ qua ngập ngoài TP.HCM, ngập trong nhà/hầm, dự báo hoặc danh sách điểm ngập chung chung không gắn với đợt ngập trong bài. Không có điểm nào thì mentions = [].`;

export async function extractMentions({ text, publishedAt }, { apiKey, fetchImpl = fetch }) {
  const res = await fetchImpl(API, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: `Ngày đăng: ${publishedAt}\n\n${text}` }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Claude API HTTP ${res.status}: ${json.error?.message ?? 'unknown error'}`);
  if (json.stop_reason !== 'end_turn') throw new Error(`Claude API stop_reason ${json.stop_reason}`);
  const out = json.content.find((b) => b.type === 'text');
  return { mentions: JSON.parse(out.text).mentions, usage: json.usage };
}

export const costUsd = ({ input, output }) => (input * PRICE_PER_MTOK.input + output * PRICE_PER_MTOK.output) / 1e6;

// Offline/manual path (trial runs without the API): `<dir>/<sha1(url)>.json` holds the exact object the
// model would return ({ mentions: [...] }). Missing file → null (article skipped).
export const responseFile = (dir, url) => join(dir, `${createHash('sha1').update(url).digest('hex')}.json`);
export async function readMentions({ url }, dir) {
  const file = responseFile(dir, url);
  if (!existsSync(file)) return null;
  return { mentions: JSON.parse(await readFile(file, 'utf8')).mentions, usage: { input_tokens: 0, output_tokens: 0 } };
}
