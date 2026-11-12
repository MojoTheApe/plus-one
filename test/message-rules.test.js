import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { matchMessageRule, validateMessageRules, ruleDecision, claimRuleAction, finishRuleAction } from '../src/message-rules.js';
import { openSetupStore } from '../src/setup-store.js';
import { assignGroupProfile } from '../src/setup-profiles.js';
import { createRuleEditor } from '../src/setup-rules.js';

const rule = { id: 'night', phrase: 'Night. Shift. Seven.', access: 'owner', action: { type: 'persona', profile: 'alternate' }, announcement: 'Ready.' };
const message = { chat: { id: -7, type: 'supergroup' }, from: { id: 88 }, message_id: 10, text: 'NIGHT,\nSHIFT: SEVEN!' };

test('rules match the whole original message and never execute quoted, forwarded or bot content', () => {
  assert.equal(matchMessageRule([rule], message)?.id, 'night');
  for (const changes of [
    { text: 'The phrase is Night. Shift. Seven.' }, { text: '"Night. Shift. Seven."' },
    { text: '> Night. Shift. Seven.' }, { text: 'Night. Shift. Seven.', entities: [{ type: 'code', offset: 0, length: 5 }] },
    { forward_origin: { type: 'user' } }, { via_bot: { id: 1 } }, { from: { id: 88, is_bot: true } },
    { chat: { id: 88, type: 'private' } }, { text: undefined, caption: rule.phrase },
  ]) assert.equal(matchMessageRule([rule], { ...message, ...changes }), null);
  assert.equal(matchMessageRule([{ ...rule, enabled: false }], message), null);
  const dated = { ...rule, createdAt: '2026-11-11T12:00:00Z' };
  const date = Date.parse(dated.createdAt) / 1000;
  assert.equal(matchMessageRule([dated], { ...message, date: date - 1 }), null);
  assert.equal(matchMessageRule([dated], { ...message, date })?.id, rule.id);
});

test('rule configuration rejects ambiguous phrases and unsafe actions', () => {
  assert.equal(validateMessageRules([rule]).length, 1);
  assert.throws(() => validateMessageRules([rule, { ...rule, id: 'other', phrase: 'night shift seven' }]), /duplicate/);
  for (const changes of [
    { access: 'members' }, { phrase: '...' }, { action: { type: 'shell', command: 'anything' } },
    { action: { type: 'assemble', game: '../../unknown' } }, { action: { type: 'animation' } },
    { phrase: '/start' }, { phrase: '"quoted trigger"' }, { phrase: 'line\n> quoted' },
    { createdAt: 'not a date' }, { enabled: 'false' },
  ]) assert.throws(() => validateMessageRules([{ ...rule, ...changes }]));
  assert.deepEqual(ruleDecision({ ...rule, action: { type: 'assemble', game: 'global' } }), { action: 'assemble', gameIds: ['global'] });
  assert.deepEqual(ruleDecision({ ...rule, action: { type: 'judge', scope: 'all' } }), { action: 'judge', judgeScope: 'all' });
});

test('character and replay receipt persist together even when an announcement fails', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rule-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'setup.sqlite');
  let store = await openSetupStore('88', filename);
  store.change(state => {
    state.profiles.base = { name: 'Base', personality: 'Quiet.', language: 'en', locale: 'en' };
    state.profiles.alternate = { name: 'Alternate', personality: 'Playful.', language: 'en', locale: 'en' };
    state.defaultProfile = 'base';
    state.groups[-7] = { configured: true, rules: [rule], modes: { memory: 'manual' } };
  });
  assert.equal(claimRuleAction(store, { ...message, from: { id: 99 } }, rule), false);
  assert.equal(claimRuleAction(store, message, rule), true);
  finishRuleAction(store, message, rule, 'failed');
  const revision = store.group(-7).character.revision;
  store.close();
  store = await openSetupStore('88', filename);
  try {
    assert.equal(store.profile(-7).displayName, 'Alternate');
    assert.equal(claimRuleAction(store, message, rule), false);
    assert.equal(claimRuleAction(store, { ...message, message_id: 11 }, rule), true);
    assert.equal(store.group(-7).character.revision, revision);
    assert.deepEqual(store.group(-7).modes, { memory: 'manual' });
    store.change(state => assignGroupProfile(state, '-7', 'base', 'new-assignment'));
    assert.equal(store.group(-7).character, undefined);
    assert.equal(store.profile(-7).displayName, 'Base');
  } finally { store.close(); }
});

test('rule capacity is recoverable and a confirmed replacement retains its identity', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rule-capacity-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await openSetupStore('88', path.join(directory, 'setup.sqlite'));
  t.after(() => store.close());
  store.change(state => {
    state.groups[-7] = { title: 'Alpha', rules: Array.from({ length: 32 }, (_, i) => ({
      id: 'rule-' + i, phrase: 'Phrase ' + i, access: 'owner', action: { type: 'judge' },
    })) };
  });
  const editor = createRuleEditor({ store, games: [], targetPrompt: () => '', resolveTarget: async () => null });
  const draft = { kind: 'rule', group: '-7', phrase: 'One more', action: { type: 'judge' }, access: 'owner', announcement: '' };
  assert.match(await editor.handle(draft, 'save', null, {}, 'en', true), /already has 32 rules/);
  assert.equal(store.group(-7).rules.length, 32);
  assert.match(await editor.handle({ ...draft, phrase: 'PHRASE: 0!' }, 'save', null, {}, 'en', true), /rules saved/);
  assert.equal(store.group(-7).rules.length, 32);
  assert.equal(store.group(-7).rules.find(item => item.phrase === 'PHRASE: 0!').id, 'rule-0');
});
