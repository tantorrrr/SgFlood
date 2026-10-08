import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function resolve(urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^[/\\]+/, '');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) return null;
  const info = await stat(file).catch(() => null);
  if (info?.isDirectory()) return resolve(join(rel, 'index.html'));
  return info?.isFile() ? file : null;
}

createServer(async (req, res) => {
  try {
    const file = await resolve(new URL(req.url, 'http://localhost').pathname);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
  }
}).listen(PORT, () => console.log(`HCMC flood map → http://localhost:${PORT}`));
