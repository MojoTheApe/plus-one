import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { validFlappyLaunch, validFlappyNotice, readFlappyNotices } from './flappy-records.js';

async function readJson(filename, fallback) {
  try {
    const text = await fs.readFile(filename, 'utf8');
    if (text.length > 1_000_000) throw new Error('Flappy state too large');
    return JSON.parse(text);
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function saveJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = filename + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(temporary, filename);
}

function validTarget(target) {
  return Number.isSafeInteger(target?.chat_id) && target.chat_id < 0
    && (target.message_thread_id === undefined || (Number.isSafeInteger(target.message_thread_id) && target.message_thread_id > 0));
}

export function flappyNoticePayload(notice, target) {
  if (!validFlappyNotice(notice) || !validTarget(target)) throw new Error('Invalid Flappy notice');
  const prefix = '🏆 Новий рекорд у Flappy Bird!\n';
  const form = new Intl.PluralRules('uk').select(notice.score);
  const points = { one: 'очко', few: 'очки', many: 'очок', other: 'очка' }[form];
  return { ...target, text: `${prefix}${notice.holder} — ${notice.score} ${points}.`,
    // Native Telegram entities mention the authenticated ID and treat the label as plain text.
    entities: [{ type: 'text_mention', offset: prefix.length, length: notice.holder.length,
      user: { id: notice.userId, is_bot: false, first_name: notice.holder } }] };
}

// Only the bot writes bindings/checkpoints. The isolated game writes its own record/outbox.
export class FlappyNotices {
  constructor({ recordFile, runtimeDir, send, onError = () => {} }) {
    this.recordFile = recordFile;
    this.bindingsFile = path.join(runtimeDir, 'flappy-launches.json');
    this.cursorFile = path.join(runtimeDir, 'flappy-notice-cursor.json');
    this.send = send;
    this.onError = onError;
    this.pendingLaunch = Promise.resolve();
    this.draining = false;
  }

  async bindings() {
    const state = await readJson(this.bindingsFile, { version: 1, targets: {} });
    if (state.version !== 1 || !state.targets || typeof state.targets !== 'object' || Array.isArray(state.targets)
        || Object.keys(state.targets).length > 1000
        || Object.entries(state.targets).some(([token, target]) => !validFlappyLaunch(token) || !validTarget(target))) {
      throw new Error('Invalid Flappy launch bindings');
    }
    return state;
  }

  launch(message) {
    if (!['group', 'supergroup'].includes(message.chat?.type)) return Promise.resolve('flappy');
    const target = { chat_id: message.chat.id,
      ...(message.is_topic_message && message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}) };
    if (!validTarget(target)) return Promise.reject(new Error('Invalid Flappy group'));
    const result = this.pendingLaunch.catch(() => {}).then(async () => {
      const state = await this.bindings();
      const existing = Object.entries(state.targets).find(([, value]) => value.chat_id === target.chat_id
        && value.message_thread_id === target.message_thread_id);
      if (existing) return existing[0];
      if (Object.keys(state.targets).length >= 1000) throw new Error('Flappy launch limit');
      const token = 'flappy_' + randomBytes(16).toString('hex');
      state.targets[token] = target;
      await saveJson(this.bindingsFile, state);
      return token;
    });
    this.pendingLaunch = result;
    return result;
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      const notices = await readFlappyNotices(this.recordFile);
      if (!notices.length) return;
      const cursor = await readJson(this.cursorFile, { version: 1, score: 0 });
      if (cursor.version !== 1 || !Number.isSafeInteger(cursor.score) || cursor.score < 0 || cursor.score > 1_000_000) {
        throw new Error('Invalid Flappy notice checkpoint');
      }
      const bindings = await this.bindings();
      for (const notice of notices.filter(value => value.score > cursor.score)) {
        // Persist the attempt before sending: Telegram has no sendMessage idempotency key.
        // A crash/unknown network result must not replay an already delivered group notice.
        await saveJson(this.cursorFile, { version: 1, score: notice.score });
        const target = bindings.targets[notice.launch];
        if (!target) continue; // Never send to a caller-supplied or unknown chat.
        try { await this.send(flappyNoticePayload(notice, target)); }
        catch (error) { this.onError(error); }
      }
    } finally { this.draining = false; }
  }
}
