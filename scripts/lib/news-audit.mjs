// Audit trail of the press pipeline. Per article:
//   data/raw/YYYY-MM/<sha1(url)>.json  (committed): url, outlet, dates, text hash/length, the extraction (mentions with
//                                       ≤ 25-word quotes) and what the pipeline did with each mention.
//   data/raw-text/YYYY-MM/<sha1>.txt   (gitignored): full article text, local only — the repo is public and the text
//                                       is the outlets' copyright.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isHeavy, resolveMention, toRecord } from './news.mjs';

const sha = (s, alg = 'sha1') => createHash(alg).update(s).digest('hex');

// Pipeline outcome for each mention (pure; mirrors fetch-news: heavy filter → resolve → record id).
export function mentionOutcomes(article, mentions, net, bbox) {
  return mentions.map((m) => {
    if (!isHeavy(m)) return { mention: m, status: 'not_heavy' };
    try {
      return { mention: m, status: 'resolved', recordId: toRecord(m, resolveMention(m, net, bbox), article).id };
    } catch (err) {
      return { mention: m, status: 'unresolved', reason: err.message };
    }
  });
}

export function auditEntry(article, outcomes, { fetchedAt, extractor }) {
  return {
    url: article.url,
    outlet: article.outlet,
    publishedAt: article.publishedAt,
    fetchedAt,
    extractor,
    text: { sha256: sha(article.text ?? '', 'sha256'), length: (article.text ?? '').length },
    outcomes,
  };
}

export async function writeAudit(rootUrl, article, entry) {
  const month = (article.publishedAt ?? entry.fetchedAt).slice(0, 7);
  const id = sha(article.url);
  const rawDir = new URL(`data/raw/${month}/`, rootUrl);
  const textDir = new URL(`data/raw-text/${month}/`, rootUrl);
  await mkdir(rawDir, { recursive: true });
  await writeFile(new URL(`${id}.json`, rawDir), `${JSON.stringify(entry, null, 1)}\n`);
  if (article.text) {
    await mkdir(textDir, { recursive: true });
    await writeFile(new URL(`${id}.txt`, textDir), article.text);
  }
}
