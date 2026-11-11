import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FlappyNotices, flappyNoticePayload } from '../src/flappy-notices.js';
import { openSharedRecord } from '../src/flappy-records.js';

async function fixture(t, send) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flappy-notices-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const recordFile = path.join(directory, 'game/shared-record-v3.json');
  const runtimeDir = path.join(directory, 'private');
  const sent = [], errors = [];
  const options = { recordFile, runtimeDir, send: send || (async payload => { sent.push(payload); }), onError: error => errors.push(error) };
  return { notices: new FlappyNotices(options), records: await openSharedRecord(recordFile), options, sent, errors };
}
const group = (id = -123, topic) => ({ chat: { id, type: 'supergroup' },
  ...(topic ? { is_topic_message: true, message_thread_id: topic } : {}) });

test('group bindings are opaque, stable across concurrent commands/restart and isolate forum topics', async t => {
  const f = await fixture(t);
  const [first, repeated, other, topic] = await Promise.all([
    f.notices.launch(group()), f.notices.launch(group()), f.notices.launch(group(-456)), f.notices.launch(group(-123, 55)),
  ]);
  assert.match(first, /^flappy_[a-f0-9]{32}$/);
  assert.equal(first, repeated); assert.notEqual(first, other); assert.notEqual(first, topic);
  assert.equal(await new FlappyNotices(f.options).launch(group()), first);
  assert.equal(await f.notices.launch({ ...group(), message_thread_id: 99 }), first, 'Ordinary reply is not a forum topic');
  assert.equal(await f.notices.launch({ chat: { id: 123, type: 'private' } }), 'flappy');
});

test('persisted maxima notify only their origin group/topic once, including after restart', async t => {
  const f = await fixture(t);
  const launch = await f.notices.launch(group(-123, 55));
  const other = await f.notices.launch(group(-456));
  await Promise.all([f.records.update(7, '@first', { id: 88, launch }),
    f.records.update(42, 'Марія 🐦', { id: 99, launch: other }), f.records.update(9, '@lower', { id: 88, launch })]);
  await Promise.all([f.notices.drain(), f.notices.drain()]);
  await new FlappyNotices(f.options).drain();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].chat_id, -123); assert.equal(f.sent[0].message_thread_id, 55);
  assert.equal(f.sent[1].chat_id, -456); assert.equal(f.sent[1].message_thread_id, undefined);
  assert.match(f.sent[0].text, /7 очок/); assert.match(f.sent[1].text, /42 очки/);
  const entity = f.sent[1].entities[0];
  assert.equal(entity.user.id, 99);
  assert.equal(f.sent[1].text.slice(entity.offset, entity.offset + entity.length), 'Марія 🐦');
  assert.deepEqual(await f.records.get(), { score: 42, holder: 'Марія 🐦', leaders: [
    { userId: 99, holder: 'Марія 🐦', score: 42 }, { userId: 88, holder: '@lower', score: 9 },
  ] });
});

test('unknown launch bindings never send and private/old buttons still save the shared record', async t => {
  const f = await fixture(t);
  await f.records.update(3, '@unknown', { id: 88, launch: 'flappy_' + 'f'.repeat(32) });
  await f.records.update(4, '@private', { id: 88, launch: 'flappy' });
  await f.notices.drain();
  assert.equal(f.sent.length, 0); assert.equal((await f.records.get()).score, 4);
});

test('an unconfirmed send is not replayed on restart and never rolls back BEST; later records still notify', async t => {
  let attempts = 0;
  const f = await fixture(t, async () => { attempts++; if (attempts === 1) throw new Error('Unknown network outcome'); });
  const launch = await f.notices.launch(group());
  await f.records.update(1, '@winner', { id: 88, launch });
  await f.notices.drain();
  await new FlappyNotices(f.options).drain();
  assert.equal(attempts, 1); assert.equal(f.errors.length, 1);
  assert.equal((await f.records.get()).score, 1);
  await f.records.update(2, '@winner', { id: 88, launch });
  await f.notices.drain(); assert.equal(attempts, 2);
});

test('failed checkpoint persistence and malformed bindings/outbox fail closed before a send', async t => {
  const f = await fixture(t);
  const launch = await f.notices.launch(group());
  await f.records.update(5, '@winner', { id: 88, launch });
  await fs.mkdir(f.notices.cursorFile + '.tmp');
  await assert.rejects(f.notices.drain()); assert.equal(f.sent.length, 0);
  await fs.rmdir(f.notices.cursorFile + '.tmp');
  await fs.writeFile(f.notices.bindingsFile, '{damaged');
  await assert.rejects(f.notices.drain()); assert.equal(f.sent.length, 0);
  await fs.writeFile(f.options.recordFile, JSON.stringify({ version: 3, notices: [{ score: 6 }] }));
  await assert.rejects(f.notices.drain()); assert.equal(f.sent.length, 0);
});

test('Ukrainian point forms and hostile/Unicode labels remain literal with correct mention ranges', () => {
  for (const [score, expected] of [[1, 'очко'], [2, 'очки'], [5, 'очок'], [11, 'очок'], [21, 'очко'], [112, 'очок']]) {
    const holder = '🐦 <b>Ім’я & Тест</b>';
    const payload = flappyNoticePayload({ score, holder, userId: 88, launch: 'flappy_' + 'a'.repeat(32) }, { chat_id: -123 });
    assert.match(payload.text, new RegExp(`${score} ${expected}\\.`));
    assert.equal(payload.parse_mode, undefined);
    const entity = payload.entities[0];
    assert.equal(payload.text.slice(entity.offset, entity.offset + entity.length), holder);
    assert.equal(entity.user.id, 88);
  }
});
