import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkAI, checkTelegram, checkPortable, checkMedia } from '../scripts/check-portable.mjs';

test('AI-only check needs no Telegram token, owner or setup database', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-check-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = { ANSWER_BACKEND: 'codex', CODEX_HOME: dir, AI_AGENT_DIR: dir, BOT_PROFILE_FILE: path.resolve('src/profiles.example.json'), BOT_PROFILE: 'neutral' };
  let calls = 0;
  const result = await checkPortable({ phase: 'ai', env,
    ai: args => checkAI({ ...args, createBackend: () => ({ ask: async () => { calls++; } }) }),
    telegram: async () => { throw new Error('Telegram must not be contacted'); },
    media: async () => { throw new Error('Unrequested media check'); } });
  assert.equal(result.ai, 'Codex'); assert.equal(calls, 1);
});

test('full preflight checks AI before any Telegram access and stops on AI error', async () => {
  const sequence = [];
  const env = { BOT_SETUP_FILE: path.join(os.tmpdir(), 'fixture.sqlite') };
  await checkPortable({ env, ai: async () => { sequence.push('ai'); return 'Codex'; },
    media: async () => { sequence.push('media'); }, telegram: async () => { sequence.push('telegram'); return {}; } });
  assert.deepEqual(sequence, ['ai','media','telegram']);
  await assert.rejects(checkPortable({ env, ai: async () => { throw new Error('AI unavailable'); },
    media: async () => assert.fail('must stop'), telegram: async () => assert.fail('must stop') }), /AI unavailable/);
});

test('Telegram verification requires numeric ownership and group reception settings', async () => {
  const env = { TELEGRAM_BOT_TOKEN: '0:FAKE', BOT_OWNER_ID: '88' };
  const response = result => async () => new Response(JSON.stringify({ ok: true, result }));
  await assert.rejects(checkTelegram({ env: { ...env, BOT_OWNER_ID: '@Owner' }, fetchImpl: async () => assert.fail() }), /numeric/);
  await assert.rejects(checkTelegram({ env, fetchImpl: response({ username: 'Fixture', can_join_groups: false }) }), /Group Joining/);
  await assert.rejects(checkTelegram({ env, fetchImpl: response({ username: 'Fixture', can_join_groups: true }) }), /Group Privacy/);
  assert.equal((await checkTelegram({ env, fetchImpl: response({ username: 'Fixture', can_join_groups: true, can_read_all_group_messages: true }) })).username, 'Fixture');
});

test('media readiness loads Whisper rather than merely checking Python version', async () => {
  const calls = [];
  await checkMedia({ env: {}, run: async (command, args) => { calls.push({ command, args }); } });
  assert.equal(calls.length, 4);
  assert.match(calls[3].args[1], /WhisperModel/);
  assert.ok(!calls.some(call => call.command.includes('telegram')));
  await assert.rejects(checkMedia({ env: { SOCIAL_VIDEO_ENABLED: 'false' }, run: async () => { throw new Error('model download failed'); } }), /speech model/);
});
