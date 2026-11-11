import http from 'node:http';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function createDuelServer(html, { botUsername = "" } = {}) {
  if (botUsername && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/u.test(botUsername)) throw new Error("Invalid public bot username");
  const config = `globalThis.PLUS_ONE_BOT_URL=${JSON.stringify(botUsername ? "https://t.me/" + botUsername : "")};`;
  const bytes = Buffer.from(String(html).replace("/* BOT_RUNTIME_CONFIG */", config));
  const etag = '"' + createHash('sha256').update(bytes).digest('hex') + '"';
  return http.createServer((req, res) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { res.writeHead(400); res.end(); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    if (!['/duel/', '/duel/index.html'].includes(pathname)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
    res.setHeader('Content-Length', bytes.length);
    res.writeHead(200);
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createDuelServer(await fs.readFile(new URL('../web/duel/index.html', import.meta.url)), { botUsername: process.env.DUEL_BOT_USERNAME || "" });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(Number(process.env.DUEL_PORT || 8091), '0.0.0.0', () => console.log('Duel listening'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
