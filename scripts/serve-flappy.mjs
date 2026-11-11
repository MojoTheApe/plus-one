import http from 'node:http';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSharedRecord, recordHandler } from '../src/flappy-records.js';

// The isolated game service has only its own record file, never bot credentials.
export function createGameServer(html, recordsApi) {
  const bytes = Buffer.from(html);
  const etag = '"' + createHash('sha256').update(bytes).digest('hex') + '"';
  return http.createServer((req, res) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { res.writeHead(400); res.end(); return; }
    if (pathname === '/flappy-bird/api/record' && recordsApi) {
      recordsApi(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    if (!['/', '/index.html', '/flappy-bird/', '/flappy-bird/index.html'].includes(pathname)) { res.writeHead(404); res.end(); return; }
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
  const html = await fs.readFile(new URL('../web/flappy-bird/dist/index.html', import.meta.url));
  const botId = process.env.FLAPPY_BOT_ID;
  const recordFile = process.env.FLAPPY_RECORD_FILE || '/data/shared-record-v4.json';
  const records = botId ? await openSharedRecord(recordFile,
    ['shared-record-v3.json', 'shared-record.json', 'group-records.json'].map(name => path.join(path.dirname(recordFile), name))) : null;
  const server = createGameServer(html, records ? recordHandler(records, { botId }) : undefined);
  const port = Number(process.env.FLAPPY_PORT || 8080);
  server.listen(port, process.env.FLAPPY_HOST || '0.0.0.0', () => console.log('Flappy Bird listening on port ' + port));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
