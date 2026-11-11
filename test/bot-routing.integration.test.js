import '../test-support/isolated-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function fixture(t, autoReply = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-routing-'));
  const previous = { ...process.env };
  const previousFetch = globalThis.fetch;
  const previousListeners = Object.fromEntries(['SIGINT','SIGTERM','exit'].map(event => [event, process.listeners(event)]));
  Object.assign(process.env, {
    TELEGRAM_BOT_TOKEN: '000000:LOCAL_TEST_ONLY', ANSWER_BACKEND: 'openai', OPENAI_API_KEY: 'local-fixture',
    DUEL_URL: 'https://games.example.com/duel/',
    FLAPPY_BIRD_URL: 'https://games.example.com/flappy-bird/',
    FLAPPY_RECORD_FILE: root + '/flappy/shared-record-v3.json',
    OCCUPIERS_URL: 'https://games.example.com/occupiers/', OCCUPIERS_ROOMS_FILE: root + '/occupiers/rooms.json',
    MEMORY_DIR: root + '/memory', MEMORY_AUTO_CAPTURE: 'false',
    BOT_LOCK_FILE: root + '/runtime/bot.pid', ASSEMBLE_STATE_FILE: root + '/runtime/assemble-state.json',
    ASSEMBLE_MEMBERS_FILE: root + '/runtime/assemble-members.json', ASSEMBLE_GAMES_FILE: path.resolve('test-support/assemble-games.json'),
    ASSEMBLE_GAME_ASSET_DIR: root + '/assets/games',
    VOICE_TRANSCRIPTION_ENABLED: 'false', VOICE_GROUP_AUTO_REPLY: String(autoReply),
    SOCIAL_VIDEO_ENABLED: 'false', INSULT_REPLY_ENABLED: 'false',
  });
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.openai.com') return new Response(JSON.stringify({ output_text: 'Готово, відповідаю.' }));
    assert.equal(url.hostname, 'api.telegram.org', 'Unexpected network destination');
    const method = url.pathname.split('/').at(-1);
    assert.ok(['sendMessage', 'sendChatAction'].includes(method), 'No polling or other real Telegram operations in this fixture');
    calls.push({ method, payload: JSON.parse(options.body || '{}') });
    return new Response(JSON.stringify({ ok: true, result: true }));
  };
  t.after(async () => {
    for (const [event, listeners] of Object.entries(previousListeners)) {
      for (const listener of process.listeners(event)) if (!listeners.includes(listener)) process.removeListener(event, listener);
    }
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(root + '/src');
  for (const file of await fs.readdir('src')) if (file !== 'bot.js') await fs.symlink(path.resolve('src', file), root + '/src/' + file);
  let source = await fs.readFile('src/bot.js', 'utf8');
  const start = source.indexOf('main().catch((error) => {');
  const end = source.indexOf('\nasync function main()', start);
  assert.ok(start > 0 && end > start, 'Locate and disable only application autostart');
  source = source.slice(0, start) + source.slice(end);
  source += '\nexport async function init(){botInfo={id:77,username:"RoutingTestBot"};await ensureMemoryVault();await ensureSettingsVault();}\nexport {handleUpdate,telegram};\n';
  source += '\nexport function runStartup(drain){flappyNotices.drain=drain;checkStartupDependencies=async()=>{};return main();}\nexport function stopStartup(){shuttingDown=true;clearInterval(flappyNoticeTimer);if(releaseProcessLock)releaseProcessLock();}\n';
  await fs.writeFile(root + '/src/bot.mjs', source);
  const app = await import(root + '/src/bot.mjs');
  await app.init();
  const message = (extra = {}) => ({ message_id: 10, date: Math.floor(Date.now() / 1000), chat: { id: -123, type: 'supergroup' }, from: { id: 88, first_name: 'Fixture', is_bot: false }, ...extra });
  return { handle: (extra) => app.handleUpdate({ update_id: 1, message: message(extra) }), calls, root,
    sendNotice: payload => app.telegram('sendMessage', payload, { retry: false }),
    runStartup: app.runStartup, stopStartup: app.stopStartup };
}

test('Flappy private, addressed voice and forum commands bypass AI and keep supported launch targets', async (t) => {
  const f = await fixture(t);
  await f.handle({text:'/flappy',chat:{id:123,type:'private'}});
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].payload.reply_markup.inline_keyboard[0][0].web_app.url,'https://games.example.com/flappy-bird/');
  f.calls.length=0;
  await f.handle({voice:{file_id:'fixture'},_voiceTranscript:'Відкрий Flappy Bird',reply_to_message:{message_id:9,from:{id:77,is_bot:true}}});
  assert.equal(f.calls.length,1);
  assert.match(f.calls[0].payload.reply_markup.inline_keyboard[0][0].url,/^https:\/\/t\.me\/RoutingTestBot\?startapp=flappy_[a-f0-9]{32}$/);
  f.calls.length=0;
  await f.handle({text:'/flappy',chat:{id:-123,type:'supergroup',is_forum:true},message_thread_id:55,is_topic_message:true});
  assert.equal(f.calls[0].payload.message_thread_id,55);
  const token = new URL(f.calls[0].payload.reply_markup.inline_keyboard[0][0].url).searchParams.get('startapp');
  const bindings = JSON.parse(await fs.readFile(f.root + '/runtime/flappy-launches.json', 'utf8'));
  assert.deepEqual(bindings.targets[token], { chat_id: -123, message_thread_id: 55 });
});

test('group voice reply reaches the normal answer handler after transcription', async (t) => {
  const f = await fixture(t);
  await f.handle({ voice: { file_id: 'fixture' }, _voiceTranscript: 'Привіт', reply_to_message: { message_id: 9, from: { id: 77, is_bot: true }, text: 'Привіт' } });
  assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 1);
  assert.match(f.calls.at(-1).payload.text, /відповідаю/);
});

test('Occupiers group command uses the existing transport and same room across topics, without invoking AI', async t => {
  const f = await fixture(t);
  await f.handle({ text: '/occupiers' });
  assert.equal(f.calls.length, 1);
  const first = f.calls[0].payload.reply_markup.inline_keyboard[0][0].url;
  assert.match(first, /^https:\/\/t\.me\/RoutingTestBot\?startapp=occupiers_[a-f0-9]{32}$/);
  f.calls.length = 0;
  await f.handle({ text: '/occupiers', is_topic_message: true, message_thread_id: 55 });
  assert.equal(f.calls[0].payload.message_thread_id, 55);
  assert.equal(f.calls[0].payload.reply_markup.inline_keyboard[0][0].url, first);
  f.calls.length = 0;
  await f.handle({ text: '/occupiers', chat: { id: 88, type: 'private' } });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'sendMessage');
  assert.equal(f.calls[0].payload.chat_id, 88);
  assert.equal(f.calls[0].payload.reply_markup.inline_keyboard[0][0].text, 'Тренуватись');
  assert.notEqual(f.calls[0].payload.reply_markup.inline_keyboard[0][0].url, first);
});

test('record notice transport makes one bounded attempt instead of retrying an uncertain Telegram send', async t => {
  const f = await fixture(t);
  let attempts = 0;
  globalThis.fetch = async (_input, options) => {
    attempts++;
    assert.ok(options.signal instanceof AbortSignal);
    throw new Error('Unknown network result');
  };
  await assert.rejects(f.sendNotice({ chat_id: -123, text: 'Fixture only' }), /Unknown network result/);
  assert.equal(attempts, 1);
});

test('recovered slow record notices do not block bot startup and normal Telegram polling', async t => {
  const f = await fixture(t);
  let releaseNotice, releasePoll, sawPoll, sawNotice, timeout;
  const blockedNotice = new Promise(resolve => { releaseNotice = resolve; });
  const blockedPoll = new Promise(resolve => { releasePoll = resolve; });
  const polled = new Promise(resolve => { sawPoll = resolve; });
  const noticeStarted = new Promise(resolve => { sawNotice = resolve; });
  globalThis.fetch = async (input) => {
    const method = new URL(String(input)).pathname.split('/').at(-1);
    if (method === 'getUpdates') { sawPoll(); return blockedPoll; }
    assert.ok(['getMe', 'setMyCommands'].includes(method));
    return new Response(JSON.stringify({ ok: true, result: method === 'getMe' ? { id: 77, username: 'RoutingTestBot' } : true }));
  };
  const running = f.runStartup(() => { sawNotice(); return blockedNotice; });
  try {
    await noticeStarted;
    await Promise.race([polled, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Polling blocked by pending notices')), 1000); })]);
    assert.ok(true, 'getUpdates is reached while notification delivery is still unresolved');
  } finally {
    clearTimeout(timeout); f.stopStartup(); releaseNotice();
    releasePoll(new Response(JSON.stringify({ ok: true, result: [] })));
    await running; f.stopStartup();
  }
});

test('group audio mention reaches the answer handler', async (t) => {
  const f = await fixture(t);
  await f.handle({ audio: { file_id: 'fixture' }, caption: '@RoutingTestBot', _voiceTranscript: 'Привіт' });
  assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 1);
});

test('untriggered transcribed group voice remains context-only when auto reply is disabled', async (t) => {
  const f = await fixture(t);
  await f.handle({ voice: { file_id: 'fixture' }, _voiceTranscript: 'Привіт' });
  assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 0);
});

test('enabled group auto reply responds to a transcribed voice note', async (t) => {
  const f = await fixture(t, true);
  await f.handle({ voice: { file_id: 'fixture' }, _voiceTranscript: 'Привіт' });
  assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 1);
});

test('failed voice transcription replies to a triggered group message', async (t) => {
  const f = await fixture(t);
  await f.handle({ voice: { file_id: 'fixture' }, _voiceTranscriptionError: 'fixture decoding failure', reply_to_message: { message_id: 9, from: { id: 77, is_bot: true }, text: 'Привіт' } });
  assert.match(f.calls.at(-1).payload.text, /could not transcribe/);
});


test('Duel uses the existing transport, preserves forum topic and bypasses AI', async t => {
  const f = await fixture(t);
  await f.handle({ text: '/duel', is_topic_message: true, message_thread_id: 55 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].payload.message_thread_id, 55);
  assert.equal(f.calls[0].payload.reply_markup.inline_keyboard[0][0].url, 'https://t.me/RoutingTestBot?startapp=duel');
  f.calls.length = 0;
  await f.handle({ text: 'Duel', chat: { id: 88, type: 'private' } });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].payload.reply_markup.inline_keyboard[0][0].web_app.url, 'https://games.example.com/duel/');
});
