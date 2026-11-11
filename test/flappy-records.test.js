import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { playerFromInitData, openSharedRecord, recordHandler } from '../src/flappy-records.js';
import { FlappyNotices } from '../src/flappy-notices.js';

const keys = generateKeyPairSync('ed25519');
const auth = { botId: '77', publicKey: keys.publicKey, now: 1_800_000_000_000 };
function launch(extra = {}) {
  const fields = new URLSearchParams({ auth_date: String(auth.now / 1000),
    user: JSON.stringify({ id: 88, first_name: 'Гравець', username: 'alpha_player' }) });
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) fields.delete(key); else fields.set(key, value);
  }
  const content = [...fields].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('\n');
  fields.set('signature', sign(null, Buffer.from(`${auth.botId}:WebAppData\n${content}`), keys.privateKey).toString('base64url'));
  fields.set('hash', 'telegram-hmac-not-needed-by-this-token-free-service');
  return fields.toString();
}
async function store(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flappy-records-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'shared-record.json');
  return { filename, records: await openSharedRecord(filename) };
}
async function request(handler, body, method = 'POST', contentType = 'application/json') {
  const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method; req.headers = { 'content-type': contentType };
  const result = {};
  await handler(req, { writeHead: (code, headers) => Object.assign(result, { code, headers }),
    end: body => { result.body = JSON.parse(body); } });
  return result;
}

test('verified Telegram users share access with sender/private/group or absent chat context', () => {
  for (const chat_type of [undefined, 'sender', 'private', 'group', 'supergroup']) {
    assert.equal(playerFromInitData(launch({ chat_type }), auth).holder, '@alpha_player');
  }
  assert.equal(playerFromInitData(launch({ user: '{"id":99,"first_name":"Марія","last_name":"Коваль"}' }), auth).holder, 'Марія Коваль');
  assert.equal(playerFromInitData(launch({ user: '{"id":99}' }), auth).holder, 'Гравець');
  const name = playerFromInitData(launch({ user: JSON.stringify({ id: 99, first_name: 'X\u202e\n' + 'Я'.repeat(100) }) }), auth).holder;
  assert.equal(Array.from(name).length, 64);
  assert.doesNotMatch(name, /[\u202e\n]/);
});

test('wrong bot/key, forged identities, duplicate fields and expired launches fail closed', () => {
  assert.throws(() => playerFromInitData(launch(), { ...auth, botId: '78' }));
  assert.throws(() => playerFromInitData(launch(), { botId: '77', now: auth.now }));
  const changed = new URLSearchParams(launch()); changed.set('user', '{"id":99,"username":"pretender"}');
  assert.throws(() => playerFromInitData(changed.toString(), auth));
  changed.set('signature', 'A'.repeat(86));
  assert.throws(() => playerFromInitData(changed.toString(), auth));
  assert.throws(() => playerFromInitData(launch() + '&user={}', auth));
  for (const fields of [{ auth_date: String(auth.now / 1000 - 86401) }, { auth_date: String(auth.now / 1000 + 61) },
    { user: '{bad' }, { user: '{"id":0}' }, { user: undefined }]) {
    assert.throws(() => playerFromInitData(launch(fields), auth));
  }
});

test('concurrent records persist score and holder together; lower scores and ties keep the winner', async t => {
  const { records, filename } = await store(t);
  assert.deepEqual(await records.get(), { score: 0, holder: null, leaders: [] });
  await Promise.all([records.update(7, '@alpha'), records.update(42, '@beta'), records.update(9, '@gamma')]);
  assert.deepEqual(await records.get(), { score: 42, holder: '@beta', leaders: [] });
  assert.deepEqual(await records.update(42, '@equal_score'), { score: 42, holder: '@beta', leaders: [] });
  assert.deepEqual(await records.update(8, '@lower_score'), { score: 42, holder: '@beta', leaders: [] });
  const reopened = await openSharedRecord(filename);
  assert.deepEqual(await reopened.get(), { score: 42, holder: '@beta', leaders: [] });
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
});

test('legacy group maxima are preserved without invented ownership; rollback input stays unchanged', async t => {
  const { filename } = await store(t);
  const legacyFile = path.join(path.dirname(filename), 'group-records.json');
  const legacy = JSON.stringify({ version: 1, records: { '11': 7, '22': 42 } });
  await fs.writeFile(legacyFile, legacy);
  const records = await openSharedRecord(filename, legacyFile);
  assert.deepEqual(await records.get(), { score: 42, holder: null, leaders: [] });
  assert.deepEqual(await records.update(42, '@ties_legacy'), { score: 42, holder: null, leaders: [] });
  assert.deepEqual(await records.update(43, '@new_holder'), { score: 43, holder: '@new_holder', leaders: [] });
  assert.equal(await fs.readFile(legacyFile, 'utf8'), legacy);
  assert.deepEqual(await (await openSharedRecord(filename, legacyFile)).get(), { score: 43, holder: '@new_holder', leaders: [] });
});

test('failed persistence never confirms a new value/holder and damaged files are retained', async t => {
  const { records, filename } = await store(t);
  await records.update(8, '@previous');
  await fs.mkdir(filename + '.tmp');
  await assert.rejects(records.update(12, '@unconfirmed'));
  assert.deepEqual(await records.get(), { score: 8, holder: '@previous', leaders: [] });
  await fs.rmdir(filename + '.tmp');
  assert.deepEqual(await records.update(10, '@confirmed'), { score: 10, holder: '@confirmed', leaders: [] });
  await fs.writeFile(filename, '{damaged');
  await assert.rejects(openSharedRecord(filename));
  assert.equal(await fs.readFile(filename, 'utf8'), '{damaged');
});

test('all authenticated players/chats read one BEST; submitted holder names cannot spoof ownership', async t => {
  const { records } = await store(t);
  const handler = recordHandler(records, auth), alice = launch();
  const bob = launch({ chat_type: 'private', user: '{"id":99,"username":"beta_player"}' });
  const group = launch({ chat_type: 'supergroup', chat_instance: '999' });
  assert.deepEqual((await request(handler, { initData: alice, score: 15, holder: '@fake' })).body, { best: 15, holder: '@alpha_player', leaders: [{ holder: '@alpha_player', score: 15 }] });
  for (const initData of [bob, group]) assert.deepEqual((await request(handler, { initData })).body, { best: 15, holder: '@alpha_player', leaders: [{ holder: '@alpha_player', score: 15 }] });
  assert.deepEqual((await request(handler, { initData: bob, score: 15 })).body, { best: 15, holder: '@alpha_player', leaders: [{ holder: '@alpha_player', score: 15 }, { holder: '@beta_player', score: 15 }] });
  assert.deepEqual((await request(handler, { initData: bob, score: 16, holder: '@fake' })).body, { best: 16, holder: '@beta_player', leaders: [{ holder: '@beta_player', score: 16 }, { holder: '@alpha_player', score: 15 }] });
  assert.deepEqual((await request(handler, { initData: group })).body, { best: 16, holder: '@beta_player', leaders: [{ holder: '@beta_player', score: 16 }, { holder: '@alpha_player', score: 15 }] });
});

test('signed launch and user ID queue only strictly higher persisted records, never caller-supplied targets', async t => {
  const { records, filename } = await store(t);
  const handler = recordHandler(records, auth);
  const token = 'flappy_' + 'a'.repeat(32);
  const initData = launch({ start_param: token });
  await request(handler, { initData, score: 20, holder: '@fake', userId: 999, chat_id: -999, start_param: 'forged' });
  await request(handler, { initData, score: 20 });
  await request(handler, { initData, score: 19 });
  await request(handler, { initData });
  const reopened = await openSharedRecord(filename);
  await request(recordHandler(reopened, auth), { initData, score: 20 });
  let saved = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.deepEqual(saved.notices, [{ score: 20, holder: '@alpha_player', userId: 88, launch: token }]);
  const changed = new URLSearchParams(initData); changed.set('start_param', 'flappy_' + 'b'.repeat(32));
  assert.equal((await request(handler, { initData: changed.toString(), score: 99 })).code, 401);
  await request(recordHandler(reopened, auth), { initData: launch(), score: 21, start_param: token, chat_id: -999 });
  saved = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.equal(saved.record.score, 21); assert.equal(saved.notices.length, 1);
});

test('upgrade retains schema-2 holder/maximum and leaves the rollback file untouched', async t => {
  const { filename } = await store(t);
  const legacyFile = filename + '.v2';
  const original = JSON.stringify({ version: 2, record: { score: 42, holder: '@existing' } });
  await fs.writeFile(legacyFile, original);
  const records = await openSharedRecord(filename, [legacyFile]);
  assert.deepEqual(await records.get(), { score: 42, holder: '@existing', leaders: [] });
  await records.update(43, '@next', { id: 88, launch: 'flappy_' + 'a'.repeat(32) });
  assert.equal(await fs.readFile(legacyFile, 'utf8'), original);
  assert.deepEqual(await (await openSharedRecord(filename, [legacyFile])).get(), { score: 43, holder: '@next', leaders: [{ userId: 88, holder: '@next', score: 43 }] });
});

test('signed Telegram round trip delivers the verified winner to its bot-issued group/topic binding', async t => {
  const { records, filename } = await store(t);
  const sent = [];
  const notices = new FlappyNotices({ recordFile: filename, runtimeDir: path.join(path.dirname(filename), 'private'),
    send: async payload => { sent.push(payload); } });
  const token = await notices.launch({ chat: { id: -123, type: 'supergroup' }, is_topic_message: true, message_thread_id: 55 });
  const initData = launch({ start_param: token, user: '{"id":99,"first_name":"Марія 🐦"}' });
  const handler = recordHandler(records, auth);
  assert.equal((await request(handler, { initData, score: 42, userId: 77, holder: '@fake', chat_id: -456 })).code, 200);
  await notices.drain();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, -123); assert.equal(sent[0].message_thread_id, 55);
  assert.equal(sent[0].entities[0].user.id, 99);
  assert.match(sent[0].text, /Марія 🐦 — 42 очки/);
});

test('record outbox stays bounded and a failed atomic write publishes neither score nor event', async t => {
  const { records, filename } = await store(t);
  const player = { id: 88, launch: 'flappy_' + 'a'.repeat(32) };
  await Promise.all(Array.from({ length: 258 }, (_, index) => records.update(index + 1, '@winner', player)));
  let saved = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.equal(saved.notices.length, 256); assert.equal(saved.notices[0].score, 3); assert.equal(saved.notices.at(-1).score, 258);
  await fs.mkdir(filename + '.tmp');
  await assert.rejects(records.update(259, '@not_saved', player));
  saved = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.equal(saved.record.score, 258); assert.equal(saved.notices.at(-1).score, 258);
});

test('record API enforces verified identity, size/score bounds and honest failure responses', async t => {
  const { records } = await store(t);
  const handler = recordHandler(records, auth), initData = launch();
  for (const score of [-1, 1.2, '999', 1_000_001, null]) assert.equal((await request(handler, { initData, score })).code, 400);
  for (const data of ['', 'forged', launch({ user: '{"id":0}' })]) assert.equal((await request(handler, { initData: data, score: 50 })).code, 401);
  assert.deepEqual(await records.get(), { score: 0, holder: null, leaders: [] });
  assert.equal((await request(handler, '{')).code, 400);
  assert.equal((await request(handler, ' '.repeat(25000))).code, 413);
  assert.equal((await request(handler, {}, 'GET')).code, 405);
  assert.equal((await request(handler, {}, 'POST', 'text/plain')).code, 415);
  const failed = recordHandler({ update: async () => { throw new Error('disk'); } }, auth);
  assert.equal((await request(failed, { initData, score: 20 })).code, 503);
});

test('top ten tracks distinct verified players below BEST and retains first attainment on ties', async t => {
  const { records, filename } = await store(t);
  const handler = recordHandler(records, auth);
  const data = (id, username) => launch({ user: JSON.stringify({ id, username }) });
  await request(handler, { initData: data(1, 'winner'), score: 100 });
  await request(handler, { initData: data(2, 'second'), score: 20 });
  await request(handler, { initData: data(3, 'third'), score: 10 });
  await request(handler, { initData: data(3, 'third'), score: 20 });
  let response = (await request(handler, { initData: data(4, 'reader') })).body;
  assert.deepEqual(response, { best: 100, holder: '@winner', leaders: [
    { holder: '@winner', score: 100 }, { holder: '@second', score: 20 }, { holder: '@third', score: 20 },
  ] });
  await request(handler, { initData: data(2, 'renamed'), score: 2, holder: '@forged' });
  await request(handler, { initData: data(1, 'winner_renamed'), score: 0 });
  const reopened = await openSharedRecord(filename);
  response = (await request(recordHandler(reopened, auth), { initData: data(4, 'reader') })).body;
  assert.equal(response.holder, '@winner_renamed');
  assert.deepEqual(response.leaders, [
    { holder: '@winner_renamed', score: 100 }, { holder: '@renamed', score: 20 }, { holder: '@third', score: 20 },
  ]);
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).notices.length, 0);
});

test('concurrent players persist a bounded top ten, without duplicate IDs or lost improvements', async t => {
  const { records, filename } = await store(t);
  await Promise.all(Array.from({ length: 25 }, (_, index) => records.update(index, '@player_' + index, { id: index + 1 })));
  let current = await records.get();
  assert.deepEqual(current.leaders.map(player => player.score), [24,23,22,21,20,19,18,17,16,15]);
  await records.update(26, '@back_in_top', { id: 1 });
  await records.update(0, '@still_best', { id: 1 });
  await records.update(1_000_000, '@maximum', { id: 99 });
  current = await (await openSharedRecord(filename)).get();
  assert.equal(current.leaders.length, 10);
  assert.equal(new Set(current.leaders.map(player => player.userId)).size, 10);
  assert.deepEqual(current.leaders.slice(0, 2), [
    { userId: 99, holder: '@maximum', score: 1_000_000 }, { userId: 1, holder: '@still_best', score: 26 },
  ]);
});

test('schema-4 migration recovers only known authenticated players and preserves rollback/cursor semantics', async t => {
  const { filename } = await store(t);
  const legacy = filename + '.v3', launch = 'flappy_' + 'a'.repeat(32);
  const original = JSON.stringify({ version: 3, record: { score: 42, holder: '@old_winner' }, notices: [
    { score: 10, holder: '@first', userId: 1, launch },
    { score: 20, holder: '@second', userId: 2, launch },
    { score: 42, holder: '@old_winner', userId: 1, launch },
  ] });
  await fs.writeFile(legacy, original);
  const records = await openSharedRecord(filename, [legacy]);
  const migrated = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.equal(migrated.version, 4); assert.equal(migrated.record.userId, 1);
  assert.equal(migrated.notices.length, 3);
  assert.deepEqual((await records.get()).leaders, [
    { userId: 1, holder: '@old_winner', score: 42 }, { userId: 2, holder: '@second', score: 20 },
  ]);
  await records.update(43, '@new_winner', { id: 3, launch });
  assert.equal(await fs.readFile(legacy, 'utf8'), original);
  const reopened = await openSharedRecord(filename, [legacy]);
  assert.equal((await reopened.get()).score, 43);
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).notices.length, 4);
  const sent = [];
  const runtimeDir = path.join(path.dirname(filename), 'private');
  await fs.mkdir(runtimeDir);
  await fs.writeFile(path.join(runtimeDir, 'flappy-notice-cursor.json'), JSON.stringify({ version: 1, score: 43 }));
  await new FlappyNotices({ recordFile: filename, runtimeDir, send: async value => sent.push(value) }).drain();
  assert.equal(sent.length, 0);
});

test('a failed below-record update cannot publish an unpersisted rank; invalid saved lists stop startup', async t => {
  const { records, filename } = await store(t);
  await records.update(100, '@winner', { id: 1 });
  await fs.mkdir(filename + '.tmp');
  await assert.rejects(records.update(50, '@not_saved', { id: 2 }));
  assert.equal((await records.get()).leaders.length, 1);
  await fs.rmdir(filename + '.tmp');
  const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
  for (const leaders of [[...saved.leaders, ...saved.leaders], [{ userId: 0, holder: '@bad', score: 1 }],
    [{ userId: 2, holder: '@bad', score: 101 }]]) {
    const invalid = JSON.stringify({ ...saved, leaders });
    await fs.writeFile(filename, invalid);
    await assert.rejects(openSharedRecord(filename));
    assert.equal(await fs.readFile(filename, 'utf8'), invalid);
  }
});

const clientSource = await fs.readFile(new URL('../web/flappy-bird/src/group-record.js', import.meta.url), 'utf8');
function client(options, fetcher) {
  const events = {}, status = {}, retry = { addEventListener: (name, fn) => { events.retry = fn; } };
  const app = options.noSdk ? undefined : { initData: options.authorized === false ? '' : 'signed-user-launch',
    initDataUnsafe: { chat_type: options.context }, isVersionAtLeast: () => true,
    onEvent: (name, fn) => { events[name] = fn; } };
  const window = { Telegram: { WebApp: app }, location: { hash: options.hash || '' },
    addEventListener: (name, fn) => { events[name] = fn; }, dispatchEvent() {} };
  const document = { hidden: false, getElementById: id => id === 'group-record' ? status : retry,
    addEventListener: (name, fn) => { events[name] = fn; } };
  vm.runInNewContext(clientSource, { window, document, fetch: fetcher, AbortController, setTimeout, clearTimeout,
    setInterval: fn => { events.poll = fn; }, Event, URLSearchParams, Intl: options.noSegmenter ? {} : Intl });
  return { record: window.FlappyRecord, status, retry, events, document };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('regression: missing/sender/private chat context uses shared BEST and holder, never local BEST', async () => {
  for (const context of [undefined, 'sender', 'private', 'supergroup']) {
    const c = client({ context }, async () => ({ ok: true, json: async () => ({ best: 42, holder: '@champion', leaders: [{ holder: '@champion', score: 42 }] }) }));
    await settle();
    assert.equal(c.record.active, true);
    assert.equal(c.record.best, 42);
    assert.equal(c.record.holder, '@champion');
    assert.equal(c.status.textContent, '');
    assert.equal(c.status.hidden, true);
    assert.deepEqual(JSON.parse(JSON.stringify(c.record.leaders)), [{ holder: '@champion', score: 42 }]);
  }
});

test('shared client keeps confirmed score/holder on failed saves and retries the highest pending score', async () => {
  let available = true;
  const submitted = [];
  const c = client({}, async (_, options) => {
    const body = JSON.parse(options.body); submitted.push(body);
    if (!available) throw new Error('offline');
    return { ok: true, json: async () => ({ best: Math.max(42, body.score ?? 0), holder: body.score > 42 ? '@new_champion' : '@champion', leaders: [] }) };
  });
  await settle();
  available = false; c.record.submit(60); await settle();
  assert.equal(c.record.best, 42);
  assert.equal(c.record.holder, '@champion');
  assert.match(c.status.textContent, /Результат не збережено/);
  available = true; await c.events.retry();
  assert.equal(submitted.at(-1).score, 60);
  assert.equal(c.record.best, 60);
  assert.equal(c.record.holder, '@new_champion');
  assert.equal(c.retry.hidden, true);
});

test('visible clients refresh new record holders; hidden/minimized clients do not poll', async () => {
  let best = 42, holder = '@first', calls = 0;
  const c = client({}, async () => { calls++; return { ok: true, json: async () => ({ best, holder, leaders: [] }) }; });
  await settle();
  best = 43; holder = '@second'; c.events.poll(); await settle();
  assert.equal(c.record.best, 43); assert.equal(c.record.holder, '@second');
  const before = calls;
  c.document.hidden = true; c.events.poll(); await settle(); assert.equal(calls, before);
  c.document.hidden = false; c.events.deactivated(); c.events.poll(); await settle(); assert.equal(calls, before);
  c.events.activated(); await settle(); assert.equal(calls, before + 1);
});

test('malformed rankings cannot replace confirmed data and failure remains retryable', async () => {
  let response = { best: 42, holder: '@winner', leaders: [{ holder: '@winner', score: 42 }] };
  const c = client({}, async () => ({ ok: true, json: async () => response }));
  await settle();
  for (const leaders of [null, Array(11).fill({ holder: '@bad', score: 1 }),
    [{ holder: '@bad', score: 43 }], [{ holder: '@bad', score: -1 }],
    [{ holder: '@bad', score: 1 }, { holder: '@bad', score: 2 }]]) {
    response = { best: 42, holder: '@winner', leaders };
    await c.events.retry();
    assert.equal(c.record.best, 42); assert.equal(c.record.leaders.length, 1);
    assert.equal(c.record.leaders[0].holder, '@winner');
    assert.equal(c.record.error, true); assert.equal(c.retry.hidden, false);
  }
  response = { best: 43, holder: '@next', leaders: [{ holder: '@next', score: 43 }] };
  await c.events.retry();
  assert.equal(c.record.error, false); assert.equal(c.record.leaders[0].holder, '@next');
  assert.equal(c.retry.hidden, true); assert.equal(c.status.hidden, true);
});

test('oversized joined-emoji names gain leaderboard wrap opportunities without altering the verified holder', async () => {
  const holder = Array(32).fill('🐦').join('\u200d');
  for (const options of [{}, { noSegmenter: true }]) {
    const c = client(options, async () => ({ ok: true, json: async () => ({ best: 42, holder, leaders: [{ holder, score: 42 }] }) }));
    await settle();
    assert.equal(c.record.holder, holder);
    assert.ok(c.record.displayName(holder).includes('\u200b'));
    assert.equal(c.record.displayName(holder).replaceAll('\u200b', ''), holder);
    assert.equal(c.record.displayName(holder, 2).replaceAll('\u200b', ''), holder);
    assert.ok(c.record.displayName(holder, 2).split('\u200b').every(part => Array.from(part).length <= 2));
    const family = '👨‍👩‍👧‍👦';
    assert.equal(c.record.displayName(family), family);
    assert.equal(c.status.hidden, true);
  }
});

test('raw Telegram launch data works without SDK; missing authorization never becomes personal BEST', async () => {
  const c = client({ noSdk: true, hash: '#tgWebAppData=raw-signed-data' }, async (_, options) => {
    assert.equal(JSON.parse(options.body).initData, 'raw-signed-data');
    return { ok: true, json: async () => ({ best: 9, holder: 'Марія', leaders: [] }) };
  });
  await settle(); assert.equal(c.record.best, 9); assert.equal(c.record.holder, 'Марія');
  const broken = client({ authorized: false, hash: '#tgWebAppPlatform=ios&tgWebAppData=' }, async () => ({ ok: false }));
  await settle(); assert.equal(broken.record.active, true); assert.equal(broken.record.best, null);
  assert.match(broken.status.textContent, /недоступний/);
  const ordinary = client({ noSdk: true }, () => { throw new Error('Must stay offline'); });
  assert.equal(ordinary.record.active, false); assert.match(ordinary.status.textContent, /Особистий BEST/);
});
