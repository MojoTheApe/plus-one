import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openSetupStore } from '../src/setup-store.js';
import { assignGroupProfile, initialProfileSettings } from '../src/setup-profiles.js';
import { createSetup } from '../src/setup.js';
import { createSetupControls } from '../src/setup-controls.js';

const bot = { id: 77, username: 'FixtureSetupBot' };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'group-setup-'));
  const file = path.join(dir, 'setup.sqlite');
  let store = await openSetupStore('101', file);
  const calls = [];
  let admin = true;
  let restrict = true, operatorAdmin = true;
  const telegram = async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'getChatMember') return { status: (payload.user_id === bot.id ? admin : operatorAdmin) ? 'administrator' : 'member', can_restrict_members: admin && restrict };
    if (method === 'getChatAdministrators') return [{ status: 'administrator', user: { id: 101, first_name: 'Owner', is_bot: false } }];
    return { message_id: calls.length + 100 };
  };
  const make = () => createSetup({ store, games: [{ id: 'fortnite', name: 'Fortnite', aliases: ['fort'] }], telegram,
    featureMode: (id, feature) => feature === 'minigames' ? 'unavailable' : store.group(id)?.modes?.[feature] ?? 'on' });
  store.bind(bot.id);
  let setup = make();
  t.after(async () => { store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const dm = text => setup.handle({ message_id: 9, chat: { id: 101, type: 'private' }, from: { id: 101 }, text }, bot);
  const click = async (label, from = 101, message) => {
    const payload = message ?? calls.filter(call => call.payload.reply_markup).at(-1)?.payload;
    const key = payload?.reply_markup.inline_keyboard.flat().find(button => button.text.includes(label));
    assert.ok(key, 'Missing button: ' + label);
    return setup.handleCallback({ id: 'callback', data: key.callback_data, from: { id: from },
      message: { message_id: 999, chat: { id: 101, type: 'private' } } }, bot);
  };
  const seed = () => store.change(state => {
    state.locale = 'en'; state.defaultProfile = 'base';
    state.profiles.base = { name: 'Base', personality: 'Calm', language: 'en', locale: 'en' };
    state.profiles.other = { name: 'Other', personality: 'Funny', language: 'en', locale: 'en' };
    state.groups['-300'] = { title: 'Alpha', active: true, configured: false };
    state.groups['-400'] = { title: 'Beta', active: true, configured: false };
  });
  return { get store() { return store; }, get setup() { return setup; }, calls, dm, click, seed,
    setAdmin(value) { admin = value; }, setRestrict(value) { restrict = value; }, setOperatorAdmin(value) { operatorAdmin = value; }, restart: async () => { store.close(); store = await openSetupStore('101', file); setup = make(); } };
}

test('personality assignment seeds group defaults once and preserves all group data on switches', async t => {
  const f = await fixture(t); f.seed();
  f.store.change(state => assignGroupProfile(state, '-300', 'base', 'first'));
  assert.equal(f.store.group('-300').modes.voice, 'on');
  assert.equal(f.store.group('-300').modes.download, 'on');
  f.store.change(state => {
    state.groups['-300'].modes.download = 'off';
    state.groups['-300'].assemble = { games: [{ id: 'fortnite', players: ['PlayerOne'] }] };
    state.groups['-300'].rules = [{ id: 'rule', phrase: 'hello' }];
    state.groups['-300'].legacyMemory = { chatFile: 'original.md' };
    state.profiles.other.settings = { modes: { download: 'on' }, assemble: { games: [] } };
    assignGroupProfile(state, '-300', 'other', 'second');
    assignGroupProfile(state, '-400', 'other', 'third');
  });
  assert.equal(f.store.group('-300').modes.download, 'off');
  assert.deepEqual(f.store.group('-300').assemble.games[0].players, ['PlayerOne']);
  assert.equal(f.store.group('-300').rules.length, 1);
  assert.equal(f.store.group('-300').legacyMemory.chatFile, 'original.md');
  assert.equal(f.store.group('-400').assemble, undefined);
  f.store.change(state => { state.profiles.other.personality = 'Updated shared personality'; });
  assert.match(f.store.profile('-300').instructions, /Updated shared personality/);
  assert.match(f.store.profile('-400').instructions, /Updated shared personality/);
});

test('no group or saved-profile feature request can change a personality template', async t => {
  const f = await fixture(t);
  f.store.change(state => { state.defaultProfile = 'base'; state.profiles.base = { name: 'Base', personality: 'Calm', language: 'en', locale: 'en' }; });
  await f.dm('configure voice in profile Base');
  assert.match(f.calls.at(-1).payload.text, /Features belong to a group/);
  assert.equal(f.store.state.profiles.base.settings, undefined);
  assert.equal(f.store.state.session, null);
});

test('native group navigation toggles immediately, retains values, checks owner and survives restart', async t => {
  const f = await fixture(t); f.seed();
  f.store.change(state => assignGroupProfile(state, '-300', 'base', 'first'));
  await f.dm('/setup');
  await f.click('My groups'); await f.click('Alpha'); await f.click('Media downloads');
  const oldCard = structuredClone(f.calls.filter(call => call.payload.reply_markup).at(-1).payload);
  await f.click('Disable', 202);
  assert.equal(f.store.group('-300').modes.download, 'on');
  await f.click('Disable', 101, oldCard);
  assert.equal(f.store.group('-300').modes.download, 'off');
  await f.restart();
  await f.click('Enable');
  assert.equal(f.store.group('-300').modes.download, 'on');
  const count = f.calls.length;
  await f.click('Disable', 101, oldCard);
  assert.equal(f.store.group('-300').modes.download, 'on');
  assert.equal(f.calls.length, count + 1, 'expired callback only acknowledges');
  assert.match(f.calls.at(-1).payload.text, /expired/);
});

test('feature writes recheck bot administrator rights without mutating settings', async t => {
  const f = await fixture(t); f.seed();
  f.store.change(state => assignGroupProfile(state, '-300', 'base', 'first'));
  await f.dm('/setup'); await f.click('My groups'); await f.click('Alpha'); await f.click('Media downloads');
  f.setAdmin(false);
  await f.click('Disable');
  assert.equal(f.store.group('-300').modes.download, 'on');
  assert.match(f.calls.at(-1).payload.text, /administrator/);
});

test('separate joining notifications select their original groups without overwriting another draft', async t => {
  const f = await fixture(t); f.seed();
  f.store.change(state => { state.session = { kind: 'persona', name: 'Unfinished', locale: 'en' }; });
  for (const id of [-500, -600]) await f.setup.observe({ my_chat_member: { chat: { id, title: 'Same title', type: 'supergroup' }, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' } } });
  const notices = f.calls.filter(call => call.payload.text?.includes('Which profile should I use'));
  assert.equal(notices.length, 2);
  assert.equal(f.store.state.session.name, 'Unfinished');
  await f.click('Base', 101, notices[0].payload);
  assert.equal(f.store.group('-500').profile, 'base');
  assert.equal(f.store.group('-600').configured, false);
  assert.equal(f.store.state.session.resume.name, 'Unfinished');
  assert.match(f.calls.at(-1).payload.text, /Settings for/);
  await f.click('Other', 101, notices[1].payload);
  assert.equal(f.store.group('-600').profile, 'other');
});

test('ordinary owner voice is never consumed by a menu or a text-entry draft', async t => {
  const f = await fixture(t); f.seed();
  await f.dm('/setup');
  const voice = { chat: { id: 101, type: 'private' }, from: { id: 101 }, voice: { file_id: 'voice', duration: 5 } };
  assert.equal(await f.setup.handle(voice, bot), false);
  f.store.change(state => { state.session = { kind: 'persona', name: 'Draft', locale: 'en' }; });
  assert.equal(await f.setup.handle(voice, bot), false);
  assert.equal(f.store.state.session.name, 'Draft');
});

test('stale save cannot become valid again after pausing and resuming the same draft', async t => {
  const f = await fixture(t); f.seed();
  f.store.change(state => { state.session = { kind: 'persona', name: 'Draft', personality: 'Nice', language: 'en', locale: 'en' }; });
  const controls = createSetupControls({ store: f.store, telegram: async () => ({}) });
  const markup = controls.markup([[{ text: 'Save', action: { type: 'input', input: 'save' } }]], { draft: true });
  const original = structuredClone(f.store.state.session);
  f.store.change(state => { state.session.paused = true; });
  f.store.change(state => { state.session = original; });
  const result = await controls.consume({ data: markup.inline_keyboard[0][0].callback_data, id: 'cb', from: { id: 101 }, message: { chat: { id: 101, type: 'private' } } });
  assert.equal(result.invalid, true);
});

test('moderation picks real administrators and saves a group-specific allowlist only on confirmation', async t => {
  const f = await fixture(t); f.seed();
  f.store.change(state => assignGroupProfile(state, '-300', 'base', 'first'));
  await f.dm('/setup'); await f.click('My groups'); await f.click('Alpha'); await f.click('Moderation');
  await f.click('Add or configure'); await f.click('Owner');
  assert.equal(f.store.group('-300').moderation, undefined);
  await f.click('Save');
  assert.deepEqual(f.store.group('-300').moderation, { userIds: [101] });
  assert.equal(f.store.group('-400').moderation, undefined);
});

test('voice-mode migration preserves explicit off and never restores reply-to-all', async t => {
  const f = await fixture(t); f.seed();
  f.store.change(state => {
    state.groups['-300'].modes = { voice: 'auto', download: 'off' };
    state.groups['-400'].modes = { voice: 'off' };
  });
  await f.restart();
  assert.equal(f.store.group('-300').modes.voice, 'on');
  assert.equal(f.store.group('-300').modes.download, 'off');
  assert.equal(f.store.group('-400').modes.voice, 'off');
});

test('reenabling moderation verifies current restriction rights and administrator operators', async t => {
  const f = await fixture(t); f.seed();
  f.store.change(state => {
    assignGroupProfile(state, '-300', 'base', 'first');
    state.groups['-300'].moderation = { userIds: [101] };
    state.groups['-300'].disabled = { moderation: true };
  });
  await f.dm('/setup'); await f.click('My groups'); await f.click('Alpha'); await f.click('Moderation');
  f.setRestrict(false); await f.click('Enable');
  assert.equal(f.store.group('-300').disabled.moderation, true);
  assert.match(f.calls.at(-1).payload.text, /restriction permissions/);
  f.setRestrict(true); f.setOperatorAdmin(false); await f.click('Enable');
  assert.equal(f.store.group('-300').disabled.moderation, true);
  f.setOperatorAdmin(true); await f.click('Enable');
  assert.equal(f.store.group('-300').disabled.moderation, false);
});

test('group home shows direct states and memory modes apply immediately', async t => {
  const f=await fixture(t);f.seed();f.store.change(s=>assignGroupProfile(s,'-300','base','first'));
  await f.dm('/setup');await f.click('My groups');await f.click('Alpha');
  const keys=f.calls.at(-1).payload.reply_markup.inline_keyboard.flat();
  assert.ok(keys.some(x=>x.text==='Game calls · set up first'));
  assert.ok(keys.some(x=>x.text==='Moderation · set up first'));
  await f.click('Memory');await f.click('Off');assert.equal(f.store.group('-300').modes.memory,'off');
  assert.ok(!f.calls.at(-1).payload.reply_markup.inline_keyboard.flat().some(x=>x.text==='Save'));
});

test('parameter-only game editing preserves both feature and individual disables', async t => {
  const f = await fixture(t); f.seed();
  f.store.change(state => {
    assignGroupProfile(state, '-300', 'base', 'first');
    state.groups['-300'].assemble = { games: [{ id: 'fortnite', name: 'Fortnite', players: ['Old'], enabled: false }] };
    state.groups['-300'].disabled = { assemble: true };
  });
  await f.dm('/setup'); await f.click('My groups'); await f.click('Alpha'); await f.click('Game calls'); await f.click('Fortnite');
  await f.click('Edit'); await f.dm('show fields'); await f.click('players'); await f.dm('@NewPlayer'); await f.click('Save');
  assert.equal(f.store.group('-300').disabled.assemble, true);
  assert.equal(f.store.group('-300').assemble.games[0].enabled, false);
  assert.deepEqual(f.store.group('-300').assemble.games[0].players, ['NewPlayer']);
});

test('editing players preserves an existing animation and disabling a game retains its roster', async t => {
  const f = await fixture(t); f.seed();
  f.store.change(state => {
    assignGroupProfile(state, '-300', 'base', 'first');
    state.groups['-300'].assemble = { games: [{ id: 'fortnite', name: 'Fortnite', aliases: ['fort'], players: ['OldPlayer'], animationReference: 'saved-gif' }] };
  });
  await f.dm('/setup'); await f.click('My groups'); await f.click('Alpha'); await f.click('Game calls'); await f.click('Fortnite');
  await f.click('Edit'); await f.dm('show fields'); await f.click('players'); await f.dm('@NewPlayer'); await f.click('Save');
  assert.deepEqual(f.store.group('-300').assemble.games[0].players, ['NewPlayer']);
  assert.equal(f.store.group('-300').assemble.games[0].animationReference, 'saved-gif');
  await f.click('Disable gathering');
  assert.equal(f.store.group('-300').assemble.games[0].enabled, false);
  assert.deepEqual(f.store.group('-300').assemble.games[0].players, ['NewPlayer']);
  assert.ok(f.calls.filter(call=>call.method==='sendAnimation').every(call=>call.payload.chat_id===101),'media previews stay private');
});

test('long duplicate group names receive distinct private menu labels without exposing IDs',async t=>{
 const f=await fixture(t);f.seed();f.store.change(s=>{for(const g of Object.values(s.groups))g.title='A'.repeat(200);});
 await f.dm('/setup');await f.click('My groups');const keys=f.calls.at(-1).payload.reply_markup.inline_keyboard.flat();
 assert.ok(keys.some(x=>x.text.startsWith('1. ')));assert.ok(keys.some(x=>x.text.startsWith('2. ')));
 assert.ok(keys.every(x=>!/-300|-400/.test(x.text)));
 assert.notEqual(f.store.group('-300').menuLabel,f.store.group('-400').menuLabel);
});

test('direct return guards a single-field edit and preserves its saved GIF after restart',async t=>{
 const f=await fixture(t);f.seed();f.store.change(s=>{assignGroupProfile(s,'-300','base','first');s.groups['-300'].assemble={games:[{id:'fortnite',name:'Fortnite',aliases:['fort'],players:['OldPlayer'],animationReference:'old-gif'}]};});
 await f.dm('/setup');await f.click('My groups');await f.click('Alpha');await f.click('Game calls');await f.click('Fortnite');
 await f.click('Edit');await f.dm('show fields');await f.click('players');await f.dm('@NewPlayer');await f.click('All features');
 assert.equal(f.store.group('-300').assemble.games[0].animationReference,'old-gif');assert.deepEqual(f.store.group('-300').assemble.games[0].players,['OldPlayer']);
 await f.restart();await f.click('Continue editing');await f.click('Save');
 assert.equal(f.store.group('-300').assemble.games[0].animationReference,'old-gif');assert.deepEqual(f.store.group('-300').assemble.games[0].players,['NewPlayer']);
});

test('default-linked groups are included in shared-profile preview and show the edited identity', async t => {
  const f = await fixture(t); f.seed();
  f.store.change(state => {
    assignGroupProfile(state, '-300', 'base', 'first');
    assignGroupProfile(state, '-400', null, 'second');
  });
  await f.dm('edit profile Base');
  assert.match(f.calls.at(-1).payload.text, /Updates personality in: Alpha, Beta/);
  await f.dm('change name'); await f.dm('Updated'); await f.dm('save'); await f.dm('/setup');
  await f.click('My groups'); await f.click('Beta');
  assert.match(f.calls.at(-1).payload.text, /Profile: <b>Updated/);
  assert.equal(f.store.profile('-400').displayName, 'Updated');
});
