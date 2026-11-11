import '../test-support/isolated-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { CHARACTERS } from '../src/occupiers/characters.js';
import { createOccupiersServer } from '../src/occupiers/server.js';
import { RoomRegistry, readRooms, practiceRegistryFile } from '../src/occupiers/registry.js';
import { occupiersReply, isOccupiersRequest } from '../src/occupiers.js';
import vm from 'node:vm';

const bot = { id: 77, username: 'FixtureBot' };
const origin = 'https://occupiers-fixture.invalid';
async function waitFor(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting for network state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(t, config = {}, realTime = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'occupiers-'));
  const registryFile = path.join(root, 'rooms.json'), registry = new RoomRegistry(registryFile);
  const roomA = await registry.forGroup(-100), roomB = await registry.forGroup(-200);
  const keys = generateKeyPairSync('ed25519');
  let now = Date.now();
  const app = createOccupiersServer({ botId: 77, registryFile, origin, publicKey: keys.publicKey, config, clock: () => realTime ? Date.now() : now });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const sockets = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  function launch(id, room = roomA) {
    const fields = new URLSearchParams({ auth_date: String(Math.floor(now / 1000)), start_param: room,
      user: JSON.stringify({ id, first_name: 'Player ' + id }) });
    const content = [...fields].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('\n');
    fields.set('signature', sign(null, Buffer.from(`77:WebAppData\n${content}`), keys.privateKey).toString('base64url'));
    return fields.toString();
  }
  async function login(id, room) {
    const response = await fetch(base + '/occupiers/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: launch(id, room) }) });
    assert.equal(response.status, 200); return response.json();
  }
  async function client(id, room = roomA) {
    const session = await login(id, room), socket = new WebSocket(base.replace('http:', 'ws:') + '/occupiers/socket', { origin });
    const value = { socket, frames: [], gameStarts: new Map(), state: null, id: null, acks: new Map(), request: 0 };
    sockets.push(socket);
    socket.on('error', () => {});
    socket.on('message', raw => {
      const data = JSON.parse(raw);
      if (data.type === 'welcome') value.id = data.id;
      if (data.type === 'state') {
        value.state = data; value.frames.push(Buffer.byteLength(raw));
        if (data.game && !value.gameStarts.has(data.game.id)) value.gameStarts.set(data.game.id, data.game);
      }
      if (data.type === 'ack') value.acks.set(data.request, data);
    });
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'hello', token: session.token }));
    await waitFor(() => value.id && value.state);
    value.command = async (action, fields = {}) => {
      const request = ++value.request;
      socket.send(JSON.stringify({ action, ...fields, request }));
      await waitFor(() => value.acks.has(request)); return value.acks.get(request);
    };
    return value;
  }
  return { app, base, registry, roomA, roomB, client, launch, login, root, now: () => now,
    advance: ms => { now += ms; for (const room of app.rooms.values()) room.tick(now); } };
}

test('stable group room survives registry reopen, topics share it and other groups are isolated', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'occupiers-registry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'rooms.json'), registry = new RoomRegistry(file);
  const tokens = await Promise.all(Array.from({ length: 12 }, () => registry.forGroup(-100)));
  assert.equal(new Set(tokens).size, 1);
  assert.equal(await new RoomRegistry(file).forGroup(-100), tokens[0]);
  assert.notEqual(await registry.forGroup(-200), tokens[0]);
  const message = { text: '/occupiers', chat: { id: -100, type: 'supergroup' }, from: { id: 88 } };
  const reply = await occupiersReply(message, bot, { gameUrl: 'https://example.com/occupiers/', registry });
  const topic = await occupiersReply({ ...message, is_topic_message: true, message_thread_id: 5 }, bot, { gameUrl: 'https://example.com/occupiers/', registry });
  assert.equal(reply.reply_markup.inline_keyboard[0][0].url, topic.reply_markup.inline_keyboard[0][0].url);
  assert.equal(isOccupiersRequest({ ...message, text: '/occupiers@OtherBot' }, bot), false);
  assert.equal(isOccupiersRequest({ ...message, text: '/occupiers delete everything' }, bot), false);
  assert.equal(isOccupiersRequest({ ...message, forward_origin: {} }, bot), false);
  await fs.writeFile(file, '{broken'); await assert.rejects(readRooms(file));
});

test('Telegram sessions reject tampering/unknown rooms; static routes expose only game assets', async t => {
  const f = await fixture(t);
  for (const initData of ['', f.launch(1).replace('Player+1', 'Player+9'), f.launch(1, 'occupiers_' + '0'.repeat(32))]) {
    const response = await fetch(f.base + '/occupiers/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData }) });
    assert.equal(response.status, 401);
  }
  for (const url of ['/occupiers/', '/occupiers/app.js', '/occupiers/controls.js', '/occupiers/territories.js', '/occupiers/absorption.js', '/occupiers/absorption-core.js', '/occupiers/style.css', '/occupiers/art.js', '/occupiers/assets/rubik-medium.woff', '/occupiers/assets/rubik-black.woff', '/occupiers/health']) {
    assert.equal((await fetch(f.base + url)).status, 200, url);
  }
  for (const url of ['/occupiers/design/preview.html', '/occupiers/rooms.json', '/private/bot.env', '/src/bot.js', '/occupiers/../package.json']) {
    assert.equal((await fetch(f.base + url)).status, 404, url);
  }
  const client = await f.client(1), other = await f.client(2, f.roomB);
  assert.equal(client.state.members.length, 1); assert.equal(other.state.members.length, 1);
  assert.notEqual(client.state.members[0].name, other.state.members[0].name);
});

test('twelve real WebSocket clients share authoritative state; duplicate user has one character, late entry cannot reset clock', async t => {
  const f = await fixture(t, { durationMs: 10_000 });
  const clients = await Promise.all(Array.from({ length: 4 }, (_, i) => f.client(i + 1)));
  for (const client of clients) assert.equal((await client.command('ready', { ready: true })).ok, true);
  const host = clients.find(c => c.id === c.state.hostId) || clients[0];
  assert.equal((await host.command('start')).ok, true);
  await waitFor(() => clients.every(c => c.state.phase === 'running'));
  const endsAt = host.state.game.endsAt;
  const late = await Promise.all(Array.from({ length: 8 }, (_, i) => f.client(i + 5)));
  const joined = await Promise.all(late.map(c => c.command('join')));
  assert.ok(joined.every(r => r.ok));
  await waitFor(() => host.state.game.players.length === 12);
  assert.equal(new Set(host.state.game.players.filter(p => p.alive).map(p => p.color)).size, 12);
  assert.equal(host.state.game.endsAt, endsAt);
  const before = host.state.game.players.find(p => p.id === host.id).point;
  host.socket.send(JSON.stringify({ action: 'input', angle: 0.2, speed: 999999, score: 999999, protectedUntil: 99999999999999 }));
  f.advance(100); await waitFor(() => host.state.time === f.now());
  const after = host.state.game.players.find(p => p.id === host.id);
  assert.ok(Math.hypot(after.point[0] - before[0], after.point[1] - before[1]) > 0);
  assert.ok(Math.hypot(after.point[0] - before[0], after.point[1] - before[1]) <= 16);
  assert.notEqual(after.score, 999999); assert.notEqual(after.protectedUntil, 99999999999999);
  const duplicate = await f.client(1);
  assert.equal(duplicate.id, clients[0].id);
  assert.equal(duplicate.state.game.players.length, 12);
  assert.equal(Math.max(...clients.flatMap(c => c.frames)) < 100_000, true);
  f.advance(10_000); await waitFor(() => duplicate.state.phase === 'results');
  assert.equal(duplicate.state.results.rows.length, 12);
  assert.equal((await duplicate.command('lobby')).ok, true);
  await waitFor(() => duplicate.state.phase === 'lobby'); assert.equal(duplicate.state.game, null);
});

test('shared proxy admits distinct signed users while limiting one verified identity', async t => {
  const f = await fixture(t);
  const request = initData => fetch(f.base + '/occupiers/api/session', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' }, body: JSON.stringify({ initData }) });
  // All requests really arrive from loopback, as they would from one proxy.
  for (let id = 1; id <= 48; id++) assert.equal((await request(f.launch(id))).status, 200);
  for (let n = 0; n < 50; n++) assert.equal((await request('invalid')).status, 401);
  for (let n = 0; n < 39; n++) assert.equal((await request(f.launch(1))).status, 200);
  assert.equal((await request(f.launch(1))).status, 429);
  assert.equal((await request(f.launch(49))).status, 200);
  f.advance(60_001);
  assert.equal((await request(f.launch(1))).status, 200);
});

test('twelve held-boost heartbeats keep the fixed state cadence instead of broadcasting each control', async t => {
  const f = await fixture(t), clients = [];
  for (let i = 1; i <= 12; i++) clients.push(await f.client(i));
  await clients[0].command('mode', { mode: 'absorption' });
  for (const c of clients) await c.command('ready', { ready: true });
  await clients[0].command('start'); await waitFor(() => clients[11].state.phase === 'running');
  const before = clients[11].frames.length;
  for (const c of clients) for (let n = 0; n < 10; n++) c.socket.send(JSON.stringify({ action: 'boost', active: true }));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(clients[11].frames.length - before <= 4, '120 input heartbeats must not add120 global snapshots');
  assert.ok(f.app.rooms.get(f.roomA).match.active().every(p => p.boostUntil > f.now()), 'all holds were processed');
});

test('private command creates only an owner-bound practice room, retaining the group registry format', async t => {
  const f = await fixture(t, { durationMs: 20_000 });
  const groupBefore = await fs.readFile(path.join(f.root, 'rooms.json'), 'utf8');
  const message = { text: '/occupiers', chat: { id: 7, type: 'private' }, from: { id: 7 } };
  const reply = await occupiersReply(message, bot, { gameUrl: origin + '/occupiers/', registry: f.registry });
  const token = new URL(reply.reply_markup.inline_keyboard[0][0].url).searchParams.get('startapp');
  assert.equal(reply.reply_markup.inline_keyboard[0][0].text, 'Тренуватись');
  assert.equal(await f.registry.forPractice(7), token);
  assert.equal(await new RoomRegistry(path.join(f.root, 'rooms.json')).forPractice(7), token);
  assert.notEqual(await f.registry.forPractice(8), token);
  assert.equal(await fs.readFile(path.join(f.root, 'rooms.json'), 'utf8'), groupBefore);
  assert.equal((await readRooms(practiceRegistryFile(path.join(f.root, 'rooms.json')), true)).rooms[token].userId, 7);
  for (const id of [8, 9]) {
    const denied = await fetch(f.base + '/occupiers/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: f.launch(id, token), practice: true }) });
    assert.equal(denied.status, 401);
  }
  const owner = await f.client(7, token), color = owner.state.members[0].color;
  assert.equal(owner.state.practice, true); assert.equal(owner.state.minPlayers, 1); assert.equal(owner.state.maxPlayers, 1);
  assert.equal((await owner.command('start')).ok, false);
  assert.equal((await owner.command('ready', { ready: true })).ok, true);
  assert.equal((await owner.command('start')).ok, true);
  await waitFor(() => owner.state.phase === 'running');
  f.advance(4000); await waitFor(() => owner.state.time === f.now());
  assert.equal(owner.state.phase, 'running'); assert.equal(owner.state.game.players.length, 1);
  const duplicate = await f.client(7, token);
  assert.equal(duplicate.id, owner.id); assert.equal(duplicate.state.game.players.length, 1);
  const game = f.app.rooms.get(token).match;
  game.eliminate(game.active()[0], 'boundary', f.now());
  f.advance(100); await waitFor(() => duplicate.state.phase === 'results');
  assert.equal(duplicate.state.results.rows.length, 1);
  assert.equal((await duplicate.command('lobby')).ok, true);
  await waitFor(() => duplicate.state.phase === 'lobby');
  assert.equal(duplicate.state.game, null); assert.equal(duplicate.state.members[0].ready, false);
  assert.equal(duplicate.state.members[0].color, color);
  assert.equal((await duplicate.command('mode', { mode: 'absorption' })).ok, true);
  await duplicate.command('ready', { ready: true });
  assert.equal((await duplicate.command('start')).ok, true);
  await waitFor(() => duplicate.state.game?.mode === 'absorption');
  const absorption = f.app.rooms.get(token).match;
  absorption.eliminate(absorption.participant(duplicate.id), 'absorbed', f.now());
  assert.equal((await duplicate.command('join')).ok, true);
  assert.equal(absorption.active().length, 1); assert.equal(absorption.active()[0].score, 10);
  assert.equal(absorption.endsAt - absorption.startedAt, 20000);
  const normal = await f.client(10);
  assert.equal(normal.state.practice, false); assert.equal(normal.state.minPlayers, 1);
  await normal.command('ready', { ready: true });
  assert.equal((await normal.command('start', { practice: true })).ok, true);
  assert.equal(normal.state.practice, false);
});

test('unsigned development identity is unavailable in production and dev server cannot bind public host', () => {
  assert.throws(() => createOccupiersServer({ dev: true, host: '0.0.0.0' }), /loopback/);
  assert.throws(() => createOccupiersServer({ botId: 77 }), /configuration/);
});

test('twelve connected controllers complete three real-time short matches and rematches with heartbeat traffic', async t => {
  const f = await fixture(t, { durationMs: 2500 }, true);
  const clients = await Promise.all(Array.from({ length: 12 }, (_, i) => f.client(i + 1)));
  const choices=clients.map((c,i)=>({id:c.id,character:CHARACTERS[i%CHARACTERS.length].id}));
  for(const [i,c]of clients.entries())assert.equal((await c.command('character',{character:choices[i].character})).ok,true);
  for (let round = 0; round < 3; round++) {
    for (const c of clients) assert.equal((await c.command('ready', { ready: true })).ok, true);
    const host = clients.find(c => c.id === c.state.hostId);
    assert.equal((await host.command('start')).ok, true);
    await waitFor(()=>clients.every(c=>c.state.phase==='running'));
    for(const c of clients)for(const expected of choices)assert.equal(c.state.game.players.find(p=>p.id===expected.id).character,expected.character);
    const steering = setInterval(() => {
      for (const c of clients) {
        const p = c.state.game?.players.find(p => p.id === c.id);
        if (p?.alive) c.socket.send(JSON.stringify({ action: 'input', angle: Math.atan2(Math.sin(p.angle + .5), Math.cos(p.angle + .5)) }));
      }
    }, 60);
    try {
      await waitFor(() => clients.every(c => c.state.phase === 'results'), 6000);
      assert.ok(clients.every(c => c.socket.readyState === WebSocket.OPEN && c.state.results.rows.length === 12));
      assert.ok(clients.every(c => c.frames.length > 15));
    } finally { clearInterval(steering); }
    assert.equal((await host.command('lobby')).ok, true);
    await waitFor(() => clients.every(c => c.state.phase === 'lobby'));
    assert.ok(clients.every(c => c.state.game === null));
    for(const c of clients)for(const expected of choices)assert.equal(c.state.members.find(m=>m.id===expected.id).character,expected.character);
  }
});

test('Main Mini App dispatcher preserves Flappy and forwards only valid Occupiers links unchanged', async () => {
  const source = await fs.readFile(new URL('../web/flappy-bird/src/game-router.js', import.meta.url), 'utf8');
  const token = 'occupiers_' + 'a'.repeat(32);
  for (const launch of ['flappy', 'flappy_' + 'b'.repeat(32), 'invalid', token]) {
    const raw = new URLSearchParams({ start_param: launch, user: '{"id":1}', signature: 'fixture' }).toString();
    const hash = '#' + new URLSearchParams({ tgWebAppData: raw }).toString(), calls = [];
    const location = { hash, search: '?tgWebAppVersion=9', replace: v => calls.push(v) };
    vm.runInNewContext(source, { window: { location }, document: { documentElement: { style: {} } }, URLSearchParams });
    assert.deepEqual(calls, launch === token ? ['/occupiers/?tgWebAppVersion=9' + hash] : []);
  }
});


test('absorption shares twelve authenticated clients, respawn, finite results and clean mode switches in isolated groups', async t => {
  const f = await fixture(t);
  const clients = await Promise.all(Array.from({ length: 12 }, (_, i) => f.client(100 + i)));
  const host = clients.find(c => c.id === c.state.hostId), guest = clients.find(c => c !== host);
  const other = await f.client(900, f.roomB);
  assert.equal((await guest.command('mode', { mode: 'absorption' })).reason, 'host_only');
  assert.equal((await host.command('split')).ok, false);
  for (const c of clients) await c.command('ready', { ready: true });
  assert.equal((await host.command('mode', { mode: 'absorption' })).ok, true);
  await waitFor(() => clients.every(c => c.state.mode === 'absorption' && c.state.members.every(m => !m.ready)));
  assert.equal(other.state.mode, 'territories');
  for (const c of clients) await c.command('ready', { ready: true });
  assert.equal((await host.command('start')).ok, true);
  await waitFor(() => clients.every(c => c.state.phase === 'running'));
  const round = host.state.game.id, endsAt = host.state.game.endsAt;
  const late = await f.client(200);
  assert.equal((await late.command('join')).reason, 'full');
  const room = f.app.rooms.get(f.roomA), player = room.player(guest.id);
  room.match.eliminate(player, 'absorbed', f.now());
  assert.equal((await late.command('join')).ok, true);
  assert.equal((await guest.command('join')).reason, 'full');
  room.match.eliminate(room.player(late.id), 'absorbed', f.now());
  assert.equal((await guest.command('join')).ok, true);
  assert.equal(player.score, 10); assert.equal(player.life, 2); assert.equal(room.match.endsAt, endsAt);
  guest.socket.send(JSON.stringify({ action: 'input', target: { x: 1, y: 0 }, mass: 999999, score: 999999, point: [0, 0] }));
  await waitFor(() => player.target.x === 1); f.advance(100);
  assert.ok(player.score < 999999); assert.equal(room.match.id, round);
  player.cells[0].setMass(80); assert.equal((await guest.command('split')).ok, true);
  await waitFor(() => host.state.game.players.find(p => p.id === guest.id).cells.length === 2);
  assert.equal((await host.command('mode', { mode: 'territories' })).reason, 'match_running');
  f.advance(300000); await waitFor(() => clients.every(c => c.state.phase === 'results'));
  assert.equal(host.state.results.mode, 'absorption'); assert.ok(host.state.results.rows.every(r => typeof r.mass === 'number' && r.percent === undefined));
  assert.equal((await host.command('lobby')).ok, true);
  assert.equal((await host.command('mode', { mode: 'territories' })).ok, true);
  await waitFor(() => clients.every(c => c.state.mode === 'territories' && !c.state.game && !c.state.results));
  await late.command('spectate'); for (const c of clients) await c.command('ready', { ready: true });
  assert.equal((await host.command('start')).ok, true);
  await waitFor(() => clients.every(c => c.state.game?.mode === 'territories'));
  const next = host.state.game;
  // Land is revisioned and may be omitted in subsequent delta packets. Keep the
  // first packet for this exact match instead of racing the next10Hz update.
  assert.equal(next.id, room.match.id);
  assert.ok(host.gameStarts.get(next.id).players.every(p => p.land?.length && p.trail && !Object.hasOwn(p, 'cells')));
  assert.ok(next.players.every(p => p.trail && !Object.hasOwn(p, 'cells')));
  assert.ok([...room.match.players.values()].every(p => p.land.length && Array.isArray(p.trail) && !Object.hasOwn(p, 'cells')));
  assert.equal(Object.hasOwn(next, 'food'), false);
  assert.equal(other.state.phase, 'lobby'); assert.equal(other.state.members.length, 1);
});

test('signed group rooms start with one ready host and accept late join in either mode', async t => {
  const f = await fixture(t, { durationMs: 20000 });
  const host = await f.client(21);
  for (const mode of ['territories', 'absorption']) {
    assert.equal((await host.command('mode', { mode })).ok, true);
    await host.command('ready', { ready: true }); assert.equal(host.state.canStart, true);
    assert.equal((await host.command('start')).ok, true);
    await waitFor(() => host.state.game?.mode === mode);
    const room = f.app.rooms.get(f.roomA);
    assert.equal(room.practice, false); assert.equal(room.match.active().length, 1);
    room.tick(f.now() + 100); assert.equal(room.phase, 'running');
    const late = await f.client(mode === 'territories' ? 22 : 23);
    assert.equal((await late.command('join')).ok, true); assert.equal(room.match.active().length, 2);
    if (mode === 'territories') {
      room.match.eliminate(room.match.participant(late.id), 'fixture', f.now()); room.tick(f.now() + 200);
      assert.equal(room.phase, 'results'); assert.equal(room.match.participant(late.id).alive, false);
    } else { room.match.finish(f.now()); room.tick(f.now()); }
    await host.command('lobby');
    late.socket.close(); await waitFor(() => !room.members.get(String(late.id))?.socket);
  }
});
