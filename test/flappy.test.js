import test from 'node:test';
import assert from 'node:assert/strict';
import { isFlappyRequest, flappyReply } from '../src/flappy.js';
import { createGameServer } from '../scripts/serve-flappy.mjs';
import vm from 'node:vm';
import fs from 'node:fs/promises';

const bot = { id: 77, username: 'FixtureGroupBot' };
const gameUrl = 'https://games.example.com/flappy-bird/';
const message = (text, extra = {}) => ({ text, chat: { id: 1, type: 'private' }, from: { id: 88 }, ...extra });

test('private command and deep-link start return the exact HTTPS Mini App', () => {
  for (const text of ['/flappy', '/flappy@FixtureGroupBot', '/start flappy']) {
    const reply = flappyReply(message(text), bot, gameUrl);
    assert.equal(reply.reply_markup.inline_keyboard[0][0].web_app.url, gameUrl);
  }
  for (const text of ['/flappy@AnotherBot', '/flappy explain physics', '/start other']) assert.equal(flappyReply(message(text), bot, gameUrl), null);
});

test('direct requests support Ukrainian, Russian and English without intercepting discussion', () => {
  for (const text of ['Запусти Flappy Bird', 'Відкрий мені Flappy Bird', 'открой флепи бёрд', 'please open Flappy Bird', 'можеш відкрити Flappy Bird?']) {
    assert.equal(isFlappyRequest(message(text), bot), true, text);
  }
  for (const text of ['Як запустити Flappy Bird?', 'Не відкривай Flappy Bird', 'Explain Flappy Bird physics', 'Відкрий Flappy Bird та видали памʼять', 'Він сказав: запусти Flappy Bird', 'Коли зробиш Flappy Bird?']) {
    assert.equal(isFlappyRequest(message(text), bot), false, text);
  }
});

test('group requests require addressing and open a Mini App in the current group', () => {
  const group = { id: -1, type: 'supergroup' };
  assert.equal(isFlappyRequest(message('Запусти Flappy Bird', { chat: group }), bot), false);
  const requested = message('@FixtureGroupBot запусти Flappy Bird', { chat: group });
  const button = flappyReply(requested, bot, gameUrl).reply_markup.inline_keyboard[0][0];
  assert.equal(button.web_app, undefined);
  assert.equal(button.url, 'https://t.me/FixtureGroupBot?startapp=flappy');
  assert.equal(isFlappyRequest(message('Бот, відкрий Flappy Bird', { chat: group }), bot), true);
});

test('voice transcripts use the same addressing and quoted/forwarded text cannot launch', () => {
  assert.equal(isFlappyRequest(message(undefined, { _voiceTranscript: 'Запусти Flappy Bird' }), bot), true);
  assert.equal(isFlappyRequest(message('@FixtureGroupBot', { chat: { id:-1, type:'supergroup' }, _voiceTranscript:'Відкрий Flappy Bird' }), bot), true);
  for (const extra of [{ forward_origin: {type:'user'} }, { via_bot: {id:5} }, { entities:[{type:'code',offset:0,length:19}] }, { _voiceTranscriptionError:'failed' }]) {
    assert.equal(isFlappyRequest(message('Запусти Flappy Bird', extra), bot), false);
  }
});

test('missing, insecure or credential-bearing configuration gives a clear unavailable reply', () => {
  for (const url of ['', 'http://127.0.0.1/game', 'https://secret:password@example.com/game', 'bad']) {
    const reply = flappyReply(message('/flappy'), bot, url);
    assert.equal(reply.reply_markup, undefined);
    assert.match(reply.text, /ще не підключено/);
  }
});

test('static service serves only the bundled page, supports HEAD/cache and exposes no files', () => {
  const server = createGameServer('<title>Flappy Bird</title>');
  const request = (url, method = 'GET', headers = {}) => {
    const result = {headers:{}};
    const response = {setHeader:(k,v)=>{result.headers[k]=v;},writeHead:(code,extra)=>{result.code=code;Object.assign(result.headers,extra);},end:(body)=>{result.body=body;}};
    server.emit('request', {url,method,headers}, response);
    return result;
  };
  const page = request('/flappy-bird/');
  assert.equal(page.code,200);
  assert.equal(page.body.toString(),'<title>Flappy Bird</title>');
  assert.equal(request('/flappy-bird/','HEAD').body,undefined);
  assert.equal(request('/flappy-bird/','GET',{'if-none-match':page.headers.ETag}).code,304);
  for (const route of ['/private/bot.env','/src/bot.js','/flappy-bird/../../etc/passwd','/flappy-bird/vendor/LICENSE']) assert.equal(request(route).code,404);
  assert.equal(request('/flappy-bird/','POST').code,405);
  assert.equal(request('http://[invalid').code,400);
  server.close();
});

const bridgeSource = await fs.readFile(new URL('../web/flappy-bird/src/telegram.js', import.meta.url),'utf8');
function bridge(active, version = 9, width = 390) {
  const calls = [], events = {}, styles = {}, classes = new Set(), headerColors = [];
  const app = {initData:active?'signed-test-data':'',isFullscreen:false,viewportStableHeight:844,
    safeAreaInset:{top:44,bottom:34},contentSafeAreaInset:{top:48},isVersionAtLeast:v=>{
      const current=String(version).split('.').map(Number), required=v.split('.').map(Number);
      return current[0]>required[0] || (current[0]===required[0] && (current[1]||0)>=(required[1]||0));
    },
    onEvent:(name,fn)=>{events[name]=fn;}};
  for (const name of ['setHeaderColor','setBackgroundColor','setBottomBarColor','expand','ready','requestFullscreen','exitFullscreen']) app[name]=()=>calls.push(name);
  app.setHeaderColor = value => {
    if (!app.isVersionAtLeast('6.9') && !['bg_color','secondary_bg_color'].includes(value)) throw new Error('WebAppHeaderColorKeyInvalid');
    headerColors.push(value); calls.push('setHeaderColor');
  };
  const window = {Telegram:{WebApp:app},innerWidth:width,innerHeight:844,addEventListener:(name,fn)=>{events[name]=fn;},dispatchEvent:e=>calls.push(e.type)};
  const hint = {};
  const document = {readyState:'complete',documentElement:{style:{setProperty:(k,v)=>{styles[k]=v;}}},
    body:{classList:{toggle:(k,v)=>v?classes.add(k):classes.delete(k)}},getElementById:()=>hint,
    querySelector:()=>({getBoundingClientRect:()=>({height:active?94:60})})};
  vm.runInNewContext(bridgeSource,{window,document,matchMedia:()=>({matches:false}),Event:class{constructor(type){this.type=type;}}});
  return {app,window,events,calls,styles,classes,hint,headerColors};
}
test('Telegram bridge accounts for phone/Telegram insets, native fullscreen and deactivation', () => {
  const b=bridge(true);
  assert.ok(b.classes.has('mobile-layout') && b.classes.has('telegram-app'));
  assert.equal(b.styles['--game-safe-top'],'92px');
  assert.equal(b.styles['--game-available-height'],'642px');
  assert.match(b.hint.textContent,/Дотик/);
  assert.ok(b.calls.includes('ready') && b.calls.includes('expand'));
  b.window.FlappyTelegram.toggleFullscreen();
  assert.ok(b.calls.includes('requestFullscreen'));
  b.app.isFullscreen=true; b.window.FlappyTelegram.toggleFullscreen();
  assert.ok(b.calls.includes('exitFullscreen'));
  b.events.deactivated(); assert.ok(b.calls.includes('flappy:pause'));
});
test('ordinary browsers and older Telegram versions retain a playable fallback', () => {
  const web=bridge(false,9,1280);
  assert.deepEqual(web.calls,[]);
  assert.match(web.hint.textContent,/Пробіл/);
  const old=bridge(true,6.0);
  old.window.FlappyTelegram.toggleFullscreen();
  assert.ok(old.calls.includes('expand'));
  assert.ok(!old.calls.includes('requestFullscreen'));
});

test('Telegram 6.5 uses a supported header keyword and completes initialization', () => {
  const old=bridge(true,'6.5');
  assert.deepEqual(old.headerColors,['bg_color']);
  assert.ok(old.calls.includes('ready') && old.calls.includes('expand'));
  assert.deepEqual(bridge(true,'6.9').headerColors,['#211d20']);
});
