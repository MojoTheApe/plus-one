import http from 'node:http';
import fs from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { playerFromInitData } from '../flappy-records.js';
import { readRooms, validRoomToken, practiceRegistryFile } from './registry.js';
import { OccupiersRoom } from './room.js';

const assets = { '/occupiers/': ['index.html', 'text/html; charset=utf-8'],
  '/occupiers/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/occupiers/controls.js': ['controls.js', 'text/javascript; charset=utf-8'],
  '/occupiers/territories.js': ['territories.js', 'text/javascript; charset=utf-8'],
  '/occupiers/absorption.js': ['absorption.js', 'text/javascript; charset=utf-8'],
  '/occupiers/absorption-core.js': ['../../src/occupiers/absorption-core.js', 'text/javascript; charset=utf-8'],
  '/occupiers/art.js': ['art.js', 'text/javascript; charset=utf-8'],
  '/occupiers/assets/rubik-medium.woff': ['assets/rubik-medium.woff', 'font/woff'],
  '/occupiers/assets/rubik-black.woff': ['assets/rubik-black.woff', 'font/woff'],
  '/occupiers/style.css': ['style.css', 'text/css; charset=utf-8'] };
const DEV_ROOM = 'occupiers_' + 'd'.repeat(32);

export function createOccupiersServer({ botId, registryFile, origin, config = {}, dev = false,
  host = '127.0.0.1', publicKey, clock = Date.now, random = Math.random } = {}) {
  if (dev && (host !== '127.0.0.1' || process.env.NODE_ENV === 'production')) throw new Error('Dev mode is loopback-only');
  if (!dev && (!/^\d+$/.test(String(botId)) || !registryFile || !origin?.startsWith('https://'))) throw new Error('Missing Occupiers production configuration');
  const rooms = new Map(), tickets = new Map(), limits = new Map();
  const root = new URL('../../web/occupiers/', import.meta.url);
  const json = (res, code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(payload));
  };
  function limited(key, maximum) {
    const now = clock();
    let entry = limits.get(key);
    if (!entry || now - entry.at > 60_000) { entry = { at: now, count: 0 }; limits.set(key, entry); }
    return ++entry.count > maximum;
  }
  function roomFor(token, practice = false) {
    let room = rooms.get(token);
    if (!room) {
      if (rooms.size >= 512) throw new Error('server_busy');
      room = new OccupiersRoom(token, { config, clock, random, practice });
      rooms.set(token, room);
    }
    return room;
  }
  async function session(req, res) {
    if (req.method !== 'POST') { json(res, 405, { error: 'method' }); return; }
    // Traefik is the peer for all groups. Never use that shared address (or
    // untrusted forwarded headers) as a user's quota. Bound unauthenticated work
    // globally, then rate-limit the identity only after Telegram verification.
    if (limited('service', 2400)) { json(res, 429, { error: 'rate_limit' }); return; }
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') { json(res, 415, { error: 'json_required' }); return; }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 20_000) { json(res, 413, { error: 'too_large' }); return; }
      chunks.push(chunk);
    }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { json(res, 400, { error: 'invalid_json' }); return; }
    let user, token, practice = false;
    try {
      if (dev && !input.initData) {
        if (typeof input.devId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.devId)) throw new Error('Invalid dev ID');
        const name = typeof input.name === 'string' ? input.name.replace(/[\u0000-\u001f<>]/g, '').trim() : '';
        user = { id: 'dev:' + input.devId, holder: Array.from(name || 'Гравець').slice(0, 48).join('') };
        token = DEV_ROOM;
      } else {
        user = playerFromInitData(input.initData, { botId, publicKey, now: clock() });
        token = user.launch;
        if (!validRoomToken(token)) throw new Error('Unknown room');
        if (!(await readRooms(registryFile)).rooms[token]) {
          const personal = (await readRooms(practiceRegistryFile(registryFile), true)).rooms[token];
          if (!personal || personal.userId !== user.id) throw new Error('Unknown room');
          practice = true;
        }
      }
    } catch { json(res, 401, { error: 'invalid_launch' }); return; }
    if (limited('user:' + user.id, 40)) { json(res, 429, { error: 'rate_limit' }); return; }
    if (tickets.size >= 4096) { json(res, 503, { error: 'server_busy' }); return; }
    const key = randomBytes(32).toString('hex');
    tickets.set(key, { user, token, practice, expires: clock() + 3_600_000 });
    json(res, 200, { token: key, dev, room: token });
  }
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/occupiers/api/session') { await session(req, res); return; }
      if (!['GET', 'HEAD'].includes(req.method)) { json(res, 405, { error: 'method' }); return; }
      if (pathname === '/occupiers/health') { json(res, 200, { ok: true, game: 'occupiers', dev }); return; }
      const asset = assets[pathname];
      if (!asset) { json(res, 404, { error: 'not_found' }); return; }
      const content = await fs.readFile(new URL(asset[0], root));
      res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': content.length,
        'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org" });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { if (!res.headersSent) json(res, 500, { error: 'server_error' }); else res.end(); }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 20_000, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const allowedOrigin = origin || `http://127.0.0.1:${server.address()?.port}`;
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { socket.destroy(); return; }
    if (pathname !== '/occupiers/socket'
      || req.headers.origin !== allowedOrigin || wss.clients.size >= 2048) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  const send = (socket, payload) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 2_000_000) { socket.close(1013, 'slow_connection'); return; }
    socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  };
  function broadcast(room) {
    const payload = JSON.stringify(room.snapshot(false, clock()));
    for (const member of room.connected()) send(member.socket, payload);
    room.broadcastPhase = room.phase;
  }
  wss.on('connection', socket => {
    let room, member, count = 0, windowAt = clock();
    socket.lastAlive = clock();
    const authTimer = setTimeout(() => { if (!member) socket.close(4003, 'authentication_required'); }, 5000);
    authTimer.unref();
    socket.on('pong', () => { socket.lastAlive = clock(); });
    socket.on('error', () => {});
    socket.on('message', (raw, isBinary) => {
      if (isBinary) { socket.close(4003, 'json_required'); return; }
      const now = clock();
      if (now - windowAt >= 1000) { count = 0; windowAt = now; }
      if (++count > 100) { socket.close(4008, 'rate_limit'); return; }
      let message;
      try { message = JSON.parse(raw.toString()); } catch { socket.close(4003, 'invalid_json'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.close(4003, 'invalid_message'); return; }
      if (!member) {
        const ticket = typeof message.token === 'string' && tickets.get(message.token);
        if (message.type !== 'hello' || !ticket || ticket.expires <= now) { socket.close(4003, 'invalid_session'); return; }
        try { room = roomFor(ticket.token, ticket.practice); member = room.attach(ticket.user, socket, now); }
        catch { socket.close(4013, 'server_busy'); return; }
        clearTimeout(authTimer);
        send(socket, { type: 'welcome', id: member.id, dev, connection: randomUUID() });
        send(socket, room.snapshot(true, now));
        broadcast(room);
        return;
      }
      socket.lastAlive = now;
      if (member.socket !== socket) return;
      const result = room.command(member, message, now);
      // Continuous controls use the fixed state cadence, not one global
      // broadcast per player's heartbeat (12 holds would otherwise add120Hz).
      if (message.action !== 'input' && message.action !== 'boost') {
        send(socket, { type: 'ack', request: typeof message.request === 'number' ? message.request : null, ...result });
        broadcast(room);
      }
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      if (member) { room.detach(member, socket, Math.min(clock(), socket.disconnectAt ?? clock())); broadcast(room); }
    });
  });
  let ticks = 0;
  const simulation = setInterval(() => {
    const now = clock();
    ticks++;
    for (const [token, room] of rooms) {
      if (room.connected().length || room.phase === 'running') {
        const wasRunning = room.phase === 'running';
        room.tick(now);
        if ((wasRunning && ticks % 3 === 0) || room.broadcastPhase !== room.phase) broadcast(room);
      } else if (now - room.lastUsed > 60 * 60_000) rooms.delete(token);
    }
  }, 1000 / 30);
  const heartbeat = setInterval(() => {
    const now = clock();
    for (const socket of wss.clients) {
      if (now - socket.lastAlive > 6000) { socket.disconnectAt = socket.lastAlive; socket.terminate(); }
      else socket.ping();
    }
    for (const [key, ticket] of tickets) if (ticket.expires <= now) tickets.delete(key);
    for (const [key, value] of limits) if (now - value.at > 60_000) limits.delete(key);
  }, 2000);
  simulation.unref(); heartbeat.unref();
  return { server, rooms, devRoom: DEV_ROOM,
    async close() {
      clearInterval(simulation); clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      await new Promise(resolve => wss.close(resolve));
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}
