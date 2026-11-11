import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { once } from 'node:events';
import { duelReply } from '../src/duel.js';
import { createDuelServer } from '../scripts/serve-duel.mjs';

const bot = { id: 77, username: 'FixtureGroupBot' };
const message = text => ({ text, chat: { id: -123, type: 'supergroup' } });
test('only deliberate Duel commands launch, respecting other bots and forwarded content', () => {
  for (const text of ['/duel', '/Duel@FixtureGroupBot', 'Duel', 'duel!']) {
    assert.equal(duelReply(message(text), bot, 'https://example.com/duel/').reply_markup.inline_keyboard[0][0].url, 'https://t.me/FixtureGroupBot?startapp=duel');
  }
  for (const text of ['/duel@OtherBot', '/duel delete', 'I like Duel', '/other', '> Duel']) assert.equal(duelReply(message(text), bot, 'https://example.com/duel/'), null);
  assert.equal(duelReply({ ...message('/duel'), forward_origin: {} }, bot, 'https://example.com/duel/'), null);
  assert.match(duelReply(message('/duel'), bot, 'http://unsafe/').text, /ще не підключено/);
});

test('Main Mini App routes Duel lobby and invitation while preserving raw launch context', async () => {
  const source = await fs.readFile(new URL('../web/flappy-bird/src/game-router.js', import.meta.url), 'utf8');
  for (const start of ['duel', 'duel_AB234', 'flappy', 'duel_BAD', 'duel_../x', 'duel_IIIII']) {
    const hash = '#' + new URLSearchParams({ tgWebAppData: new URLSearchParams({ start_param: start, signature: 'unchanged' }).toString() });
    const calls = [], location = { hash, search: '?tgWebAppVersion=9', replace: x => calls.push(x) };
    vm.runInNewContext(source, { window: { location }, document: { documentElement: { style: {} } }, URLSearchParams });
    assert.deepEqual(calls, ['duel', 'duel_AB234'].includes(start) ? ['/duel/' + location.search + hash] : []);
  }
});

test('isolated static service serves configured public identity and only the game', async t => {
  assert.throws(() => createDuelServer('', { botUsername: 'invalid<script>' }), /Invalid public/);
  const server = createDuelServer('<h1>Duel</h1><script>/* BOT_RUNTIME_CONFIG */</script>', { botUsername: bot.username });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/duel/`;
  const first = await fetch(url); assert.equal(first.status, 200);
  assert.equal(await first.text(), '<h1>Duel</h1><script>globalThis.PLUS_ONE_BOT_URL="https://t.me/FixtureGroupBot";</script>');
  assert.equal((await fetch(url, { headers: { 'If-None-Match': first.headers.get('etag') } })).status, 304);
  assert.equal(await (await fetch(url, { method: 'HEAD' })).text(), '');
  assert.equal((await fetch(url + '../../private/bot.env')).status, 404);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
});
