import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openSetupStore } from '../src/setup-store.js';
import { createSetup } from '../src/setup.js';
import { assignGroupProfile } from '../src/setup-profiles.js';

const bot = { id: 77, username: 'OnboardingFixtureBot' };
async function fixture(t, accountLocale = 'en') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onboarding-v2-'));
  const file = path.join(dir, 'setup.sqlite');
  let store = await openSetupStore('101', file), admin = true, unavailable = new Set(['minigames']);
  const calls = [], classified = [];
  let turn = input => ({ intent: input.kind === 'menu' ? 'setup' : 'answer', ownerName: null, botName: null });
  let memberWait, sendError = false;
  const telegram = async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'getChatMember' && memberWait) await memberWait(payload);
    if (sendError && ['sendMessage','editMessageText'].includes(method)) throw new Error('fixture delivery failure');
    if (method === 'getChatMember') return { status: payload.user_id === 77 && !admin ? 'member' : 'administrator', can_restrict_members: true };
    return { message_id: calls.length + 100 };
  };
  const make = () => createSetup({ store, telegram, games: [],
    featureMode: (id, key) => unavailable.has(key) ? 'unavailable' : ['chat','search','judge','history','memory','voice','analysis','download','minigames'].includes(key) ? store.group(id)?.modes?.[key] ?? (key === 'memory' ? 'manual' : 'on') : undefined,
    classifyTurn: async input => { classified.push(input); return JSON.stringify(await turn(input)); } });
  store.bind(bot.id);
  let setup = make();
  const dm = text => setup.handle({ message_id: 1, chat: { id: 101, type: 'private' }, from: { id: 101, language_code: accountLocale }, text }, bot);
  const panel = () => calls.filter(c => ['sendMessage','editMessageText'].includes(c.method)).at(-1)?.payload;
  const click = async (name, saved = panel()) => {
    const key = saved?.reply_markup?.inline_keyboard.flat().find(b => b.text.includes(name));
    assert.ok(key, 'Missing control ' + name + ': ' + JSON.stringify(saved?.reply_markup));
    return setup.handleCallback({ id: 'callback', data: key.callback_data, from: { id: 101, language_code: accountLocale }, message: { message_id: 999, chat: { id: 101, type: 'private' } } }, bot);
  };
  t.after(async () => { store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, get setup() { return setup; }, calls, classified, dm, panel, click,
    setTurn(fn) { turn = fn; }, setAdmin(value) { admin = value; }, setUnavailable(...keys) { unavailable = new Set(keys); },
    setMemberWait(fn) { memberWait = fn; }, setSendError(value) { sendError = value; },
    restart: async () => { store.close(); store = await openSetupStore('101', file); setup = make(); },
    seed() { store.change(s => { s.locale = 'en'; s.defaultProfile = 'base'; s.profiles.base = { name: 'Marina', language: 'en', locale: 'en', personality: 'Calm' }; }); } };
}

test('three questions use operator wake-up, names then language then character, without Back/Cancel', async t => {
  const f = await fixture(t);
  await f.dm('/start');
  assert.match(f.panel().text, /connection open[\s\S]*Who’s on the other end/);
  assert.deepEqual(f.panel().reply_markup.inline_keyboard, []);
  await f.dm('Я Дима, тебя зовут Марина');
  assert.equal(f.store.state.session.ownerName, 'Дима');
  assert.equal(f.store.state.session.name, 'Марина');
  assert.match(f.panel().text, /Before we go further/);
  assert.equal(f.panel().reply_markup.inline_keyboard.flat().length, 4);
  await f.click('Русский');
  assert.match(f.panel().text, /Хорошо, Дима. Я Марина/);
  assert.deepEqual(f.panel().reply_markup.inline_keyboard, []);
  await f.dm('Общительная и с юмором.');
  assert.match(f.panel().text, /<b>Вот что получилось<\/b>/);
  const labels = f.panel().reply_markup.inline_keyboard.flat().map(b => b.text);
  assert.deepEqual(labels, ['Сохранить профиль', 'Изменить']);
  assert.equal(f.store.state.defaultProfile, null);
  await f.click('Сохранить профиль');
  assert.equal(f.store.state.owner.displayName, 'Дима');
  assert.equal(f.store.state.profiles[f.store.state.defaultProfile].name, 'Марина');
  assert.equal(f.store.state.profiles[f.store.state.defaultProfile].ownerName, undefined);
  assert.match(f.panel().text, /Ты создал мой первый профиль/);
  assert.deepEqual(f.panel().reply_markup.inline_keyboard.flat().map(b => b.text), ['Добавить в группу', 'Посмотреть функции']);
});

test('missing and ambiguous names are clarified; classifier names must literally occur in an answer', async t => {
  const f = await fixture(t);
  await f.dm('/start'); await f.dm('Marina');
  assert.equal(f.store.state.session.name, undefined);
  assert.match(f.panel().text, /both names/);
  f.setTurn(() => ({ intent: 'answer', ownerName: 'Invented', botName: 'Marina' }));
  await f.dm('Please use Marina as your name.');
  assert.equal(f.store.state.session.ownerName, undefined);
  assert.equal(f.store.state.session.name, 'Marina');
  assert.match(f.panel().text, /What should I call you/);
  await f.dm('Dima');
  assert.equal(f.store.state.session.ownerName, 'Dima');
  assert.equal(f.classified.length, 3, 'one classifier turn per text reply');
});

test('owner-only replies cannot invent the bot name or consume a later character as a rename', async t => {
  const f = await fixture(t);
  await f.dm('/start');
  f.setTurn(() => ({ intent: 'answer', ownerName: 'Dmitry', botName: null }));
  await f.dm('Call me Dmitry');
  assert.equal(f.store.state.session.ownerName, 'Dmitry');
  assert.equal(f.store.state.session.name, undefined);
  await f.dm('River'); await f.click('English');
  await f.dm('Your name is River and you enjoy helping friends.');
  assert.equal(f.store.state.session.personality, 'Your name is River and you enjoy helping friends.');
  assert.equal(f.store.state.session.name, 'River');
});

test('a single Russian owner name is not also inferred as the bot name', async t => {
  const f = await fixture(t); await f.dm('/start'); await f.dm('Меня зовут Дима');
  assert.equal(f.store.state.session.ownerName, 'Дима');
  assert.equal(f.store.state.session.name, undefined);
  assert.match(f.panel().text, /What do you want to call me/);
});

test('classifier names use whole literal spans and keep the user spelling', async t => {
  const f = await fixture(t); await f.dm('/start');
  f.setTurn(() => ({ intent: 'answer', ownerName: 'Ann', botName: 'river' }));
  await f.dm('My name is Joanne, your name is RIVER');
  assert.equal(f.store.state.session.ownerName, 'Joanne');
  assert.equal(f.store.state.session.name, 'RIVER');
});

test('legacy drafts keep their character-first order and saved distinct labels remain editable', async t => {
  const f = await fixture(t);
  f.store.change(s => { s.session = { kind: 'persona', name: 'River', label: 'Work', makeDefault: true, locale: 'en' }; });
  await f.dm('/setup');
  assert.match(f.panel().text, /Now tell me what I’m like/);
  assert.ok(!f.panel().reply_markup.inline_keyboard.flat().some(b => b.text === 'English'));
  await f.dm('Calm.'); await f.click('English'); await f.click('Save profile');
  let profile = f.store.state.profiles[f.store.state.defaultProfile];
  assert.equal(profile.label, 'Work');
  await f.dm('edit profile Work'); await f.click('Edit'); await f.click('My name'); await f.dm('Marina'); await f.click('Save profile');
  profile = f.store.state.profiles[f.store.state.defaultProfile];
  assert.equal(profile.name, 'Marina'); assert.equal(profile.label, 'Work');
});

test('automatic answer language uses persistent owner account locale for setup, including restart', async t => {
  const f = await fixture(t, 'uk-UA');
  await f.dm('/start'); await f.dm('My name is Alex, your name is River'); await f.click('Match');
  assert.equal(f.store.state.session.language, 'match-request');
  assert.equal(f.store.state.session.locale, 'uk');
  assert.match(f.panel().text, /Тепер опиши мене/);
  await f.restart(); await f.dm('/setup');
  assert.match(f.panel().text, /Тепер опиши мене/);
  await f.dm('Спокійний і уважний.'); await f.click('Зберегти профіль');
  assert.equal(f.store.state.locale, 'uk');
  assert.equal(f.store.profile('101').language.reply, 'match-request');
});

test('field edit/back returns to full preview, retains fields and rejects an older Save', async t => {
  const f = await fixture(t);
  await f.dm('/start'); await f.dm('My name is Alex, your name is River'); await f.click('English'); await f.dm('Calm and clear.');
  const oldPreview = structuredClone(f.panel());
  await f.click('Edit'); await f.click('My name'); await f.click('Back');
  assert.equal(f.store.state.session.name, 'River');
  await f.click('Character'); await f.dm('Funny but careful.');
  assert.equal(f.store.state.session.name, 'River');
  assert.equal(f.store.state.session.language, 'en');
  assert.match(f.panel().text, /Funny but careful/);
  await f.click('Save profile', oldPreview);
  assert.equal(f.store.state.defaultProfile, null);
  await f.click('Edit'); await f.click('My name'); await f.dm('Marina'); await f.click('Save profile');
  const profile = f.store.state.profiles[f.store.state.defaultProfile];
  assert.equal(profile.name, 'Marina'); assert.equal(profile.label, 'Marina'); assert.equal(profile.personality, 'Funny but careful.');
});

test('user fields remain literal in rich sent and edited profile previews', async t => {
  const f = await fixture(t); f.seed();
  await f.dm('edit profile Marina'); await f.click('Edit'); await f.click('Character');
  await f.dm('<b>bold</b> **stars** [link](https://example.com)');
  const text = f.panel().text;
  assert.match(text, /&lt;b&gt;bold&lt;\/b&gt;/);
  assert.ok(text.includes('**stars**'));
  assert.ok(text.includes('[link](https://example.com)'));
  assert.ok(!text.includes('<a href='));
  assert.equal(f.panel().parse_mode, 'HTML');
  await f.click('Edit');
  assert.equal(f.panel().parse_mode, 'HTML');
});

test('group guide leads to native chooser; member promotion recovers and preserves another draft', async t => {
  const f = await fixture(t); f.seed();
  await f.dm('/setup'); await f.click('Add to group');
  assert.match(f.panel().text, /Connect your first group/);
  assert.match(f.panel().reply_markup.inline_keyboard.flat()[0].url, /startgroup=setup/);
  f.store.change(s => { s.session = { kind: 'persona', name: 'OtherDraft', locale: 'en' }; });
  f.setAdmin(false);
  const event = status => ({ my_chat_member: { chat: { id: -300, title: 'Friends', type: 'supergroup' }, old_chat_member: { status: 'left' }, new_chat_member: { status } } });
  await f.setup.observe(event('member'), bot);
  assert.match(f.panel().text, /administrator/);
  assert.equal(f.store.state.session.name, 'OtherDraft');
  f.setAdmin(true);
  await f.setup.observe({ my_chat_member: { ...event('administrator').my_chat_member, old_chat_member: { status: 'member' } } }, bot);
  assert.match(f.panel().text, /connected/);
  await f.click('Use Marina');
  assert.equal(f.store.group('-300').profile, 'base');
  assert.equal(f.store.state.session.resume.name, 'OtherDraft');
  assert.match(f.panel().text, /Settings for/);
  assert.match(f.panel().text, /Game calls — <b>inactive · set up first/);
  assert.ok(!f.panel().text.includes('Would you like to configure'));
});

test('group observations cannot edit an unrelated callback message while access is being checked', async t => {
  const f = await fixture(t); f.seed();
  f.store.change(s => {
    s.groups['-300'] = { title: 'Alpha', active: true, configured: false };
    assignGroupProfile(s, '-300', 'base', 'fixture');
  });
  await f.dm('/setup'); await f.click('My groups');
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.setMemberWait(async payload => { if (payload.chat_id === -300) { entered(); await gate; } });
  const viewing = f.click('-300'); await started;
  const observing = f.setup.observe({ my_chat_member: { chat: { id: -400, title: 'Beta', type: 'supergroup' }, old_chat_member: { status: 'left' }, new_chat_member: { status: 'administrator' } } }, bot);
  release(); await Promise.all([viewing, observing]);
  const notice = f.calls.find(c => c.payload.text?.includes('Group “Beta” connected'));
  assert.equal(notice.method, 'sendMessage');
  assert.match(f.panel().text, /Beta/);
});

test('failed promotion notices are throttled and a group-bound user retry recovers them', async t => {
  const f = await fixture(t); f.seed(); f.setAdmin(false);
  const update = (oldStatus, status) => ({ my_chat_member: { chat: { id: -400, title: 'Beta', type: 'supergroup' }, old_chat_member: { status: oldStatus }, new_chat_member: { status } } });
  await f.setup.observe(update('left','member'), bot);
  assert.equal(f.store.group('-400').notificationStage, 'admin');
  f.setSendError(true); f.setAdmin(true);
  await f.setup.observe(update('member','administrator'), bot);
  const attempted = f.calls.filter(c => ['sendMessage','editMessageText'].includes(c.method)).length;
  await f.setup.observe(update('administrator','administrator'), bot);
  assert.equal(f.calls.filter(c => ['sendMessage','editMessageText'].includes(c.method)).length, attempted);
  f.setSendError(false); await f.dm('/setup'); await f.click('My groups'); await f.click('-400');
  assert.equal(f.store.group('-400').notificationStage, 'profile');
  assert.match(f.panel().text, /connected/);
});

test('overview separates configured-off, missing data, unavailable connections and failed attempts', async t => {
  const f = await fixture(t); f.seed();
  f.store.change(s => {
    s.groups['-300'] = { title: '**Unsafe** <b>group</b>', active: true, configured: false };
    assignGroupProfile(s, '-300', 'base', 'fixture');
    s.groups['-300'].modes.voice = 'off';
    s.groups['-300'].featureChecks = { download: { ok: false } };
    s.groups['-300'].moderation = { userIds: [101] };
    s.groups['-300'].disabled = { moderation: true };
  });
  f.setUnavailable('search','minigames');
  await f.dm('/setup'); await f.click('My groups'); await f.click('-300');
  const text = f.panel().text;
  assert.match(text, /Voice messages — <b>inactive<\/b>/);
  assert.match(text, /Moderation — <b>inactive<\/b>/);
  assert.match(text, /Web search — <b>inactive · needs connection/);
  assert.match(text, /Media downloads[^\n]*last attempt failed/);
  assert.ok(text.includes('**Unsafe** &lt;b&gt;group&lt;/b&gt;'));
  assert.ok(!text.includes('<b>Unsafe</b>'));
  assert.equal(f.panel().reply_markup.inline_keyboard.flat().at(-1).text, 'Later');
});
