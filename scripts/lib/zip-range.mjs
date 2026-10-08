// Extract one stored/deflated member from a remote zip with HTTP Range requests (zip64-aware).
import { inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const CDH = 0x02014b50;
const LFH = 0x04034b50;
const MAX32 = 0xffffffff;

function lastIndexOfSig(buf, sig) {
  for (let i = buf.length - 4; i >= 0; i--) if (buf.readUInt32LE(i) === sig) return i;
  return -1;
}

// `tail` = last bytes of the archive. Returns the central directory location.
export function findCentralDirectory(tail) {
  const i = lastIndexOfSig(tail, EOCD);
  if (i < 0) throw new Error('zip: end of central directory not found');
  let size = tail.readUInt32LE(i + 12);
  let offset = tail.readUInt32LE(i + 16);
  const j = lastIndexOfSig(tail.subarray(0, i), EOCD64);
  if (j >= 0) {
    size = Number(tail.readBigUInt64LE(j + 40));
    offset = Number(tail.readBigUInt64LE(j + 48));
  } else if (offset === MAX32) {
    throw new Error('zip64 archive without zip64 EOCD in tail');
  }
  return { offset, size };
}

export function parseCentralDirectory(cd) {
  const entries = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === CDH) {
    const method = cd.readUInt16LE(p + 10);
    let csize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const [nlen, elen, clen] = [cd.readUInt16LE(p + 28), cd.readUInt16LE(p + 30), cd.readUInt16LE(p + 32)];
    let localOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nlen);
    const extra = cd.subarray(p + 46 + nlen, p + 46 + nlen + elen);
    for (let q = 0; q + 4 <= extra.length;) {
      const [id, len] = [extra.readUInt16LE(q), extra.readUInt16LE(q + 2)];
      if (id === 1) {
        let k = q + 4;
        const next = () => { const v = Number(extra.readBigUInt64LE(k)); k += 8; return v; };
        if (usize === MAX32) usize = next();
        if (csize === MAX32) csize = next();
        if (localOffset === MAX32) localOffset = next();
      }
      q += 4 + len;
    }
    entries.push({ name, method, csize, usize, localOffset });
    p += 46 + nlen + elen + clen;
  }
  return entries;
}

// `header` = first 30 bytes of the local file header. Returns the absolute data offset.
export function localDataOffset(header, entry) {
  if (header.readUInt32LE(0) !== LFH) throw new Error(`zip: bad local header for ${entry.name}`);
  return entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
}

export async function extractRemoteEntry(url, match, { headers = {}, log = () => {} } = {}) {
  const range = async (a, b) => {
    const res = await fetch(url, { headers: { ...headers, Range: `bytes=${a}-${b}` } });
    if (res.status !== 206) throw new Error(`Range ${a}-${b}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const head = await fetch(url, { method: 'HEAD', headers });
  if (!head.ok) throw new Error(`HEAD ${url}: HTTP ${head.status}`);
  const total = Number(head.headers.get('content-length'));
  const tail = await range(Math.max(0, total - 65536), total - 1);
  const cdLoc = findCentralDirectory(tail);
  const entries = parseCentralDirectory(await range(cdLoc.offset, cdLoc.offset + cdLoc.size - 1));
  const entry = entries.find((e) => match(e.name));
  if (!entry) throw new Error(`zip: no entry matching in ${entries.length} entries`);
  log(`  zip ${(total / 1e9).toFixed(2)} GB, ${entries.length} entries → ${entry.name} (method ${entry.method}, ${(entry.csize / 1e6).toFixed(1)} MB @ ${entry.localOffset})`);
  const start = localDataOffset(await range(entry.localOffset, entry.localOffset + 29), entry);
  const data = await range(start, start + entry.csize - 1);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`zip: unsupported method ${entry.method}`);
}
