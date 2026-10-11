// One-off: rebuild the audit trail (data/raw, data/raw-text) from backfill working dirs that hold
// cand/<sha1>.json ({url,outlet,publishedAt,text}) and resp/<sha1>.json (extraction). Usage:
//   node scripts/import-audit.mjs <dir> [<dir> …]
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BBOX, ROOT } from './lib/osm.mjs';
import { buildNetwork } from './lib/news.mjs';
import { auditEntry, mentionOutcomes, writeAudit } from './lib/news-audit.mjs';

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const roads = await readJson(new URL('public/data/roads.json', ROOT));
const index = await readJson(new URL('public/data/minor/index.json', ROOT));
const segs = [...roads.segs];
for (const t of index.tiles) segs.push(...(await readJson(new URL(`public/data/minor/${t.id}.json`, ROOT))).segs);
const net = { ...buildNetwork(segs), hotspots: await readJson(new URL('data/hotspots.json', ROOT)) };

let written = 0;
for (const dir of process.argv.slice(2)) {
  for (const candDir of ['cand', 'cand2'].map((d) => join(dir, d)).filter(existsSync)) {
    for (const f of (await readdir(candDir)).filter((n) => n.endsWith('.json'))) {
      const respPath = join(dir, 'resp', f);
      if (!existsSync(respPath)) continue;
      const article = await readJson(join(candDir, f));
      const { mentions = [] } = await readJson(respPath);
      const outcomes = mentionOutcomes(article, mentions, net, BBOX);
      await writeAudit(ROOT, article, auditEntry(article, outcomes, { fetchedAt: null, extractor: 'manual-responses (backfill import)' }));
      written++;
    }
  }
}
console.log(`audit entries written: ${written}`);
