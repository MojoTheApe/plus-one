import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore, conversationThreadId, mergeConversationItem, scopedItems, replyChain } from '../src/conversation-store.js';

async function temporaryStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-merge-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new ConversationStore(directory);
}

test('a later quoted voice snapshot preserves transcript, original event and media across restart and compaction', async t => {
  const store = await temporaryStore(t), now = Date.now();
  await store.record({ chatId: -123, messageId: 10, date: now - 2000, text: 'Початкове питання', isForum: false });
  const voice = {
    chatId: -123, messageId: 11, date: now - 1000, userId: 5, sender: '@speaker', username: '@speaker', isBot: false,
    text: '[voice transcript] Повтори завантаження цього відео.', replyToMessageId: 10,
    isForum: false, messageThreadId: null, sourceUrl: 'https://example.com/video',
    mediaType: 'voice', media: { kind: 'voice', fileId: 'private-file-handle', mimeType: 'audio/ogg', duration: 8, size: 12000 },
  };
  await store.record(voice);
  const snapshot = { ...voice, date: now, userId: 0, sender: 'unknown', username: '', text: '[voice без тексту]', replyToMessageId: null, messageThreadId: 999, sourceUrl: '', media: { kind: 'voice', duration: null } };
  const recreated = new ConversationStore(store.directory);
  const recorded = await recreated.record(snapshot, { partial: true });
  assert.deepEqual(recorded, voice);
  await recreated.compact();
  const items = await new ConversationStore(store.directory).read(-123);
  assert.deepEqual(items.find(i => i.messageId === 11), voice);
  assert.deepEqual(replyChain(items, 11).map(i => i.messageId), [10, 11]);
});

test('legacy append logs retain rich text on ordinary replay and compaction even without snapshot markers', async t => {
  const store = await temporaryStore(t), now = Date.now();
  const original = { chatId: -123, messageId: 7, date: now - 2000, userId: 8, isBot: false, sender: '@speaker', text: '[voice transcript] Голосове збережене повністю.', replyToMessageId: 6, media: { kind: 'voice', fileId: 'voice-file', duration: 6 } };
  await store.record(original);
  await fs.appendFile(store.file(-123), JSON.stringify({ ...original, date: now, sender: 'unknown', text: '[voice transcription failed]', replyToMessageId: null, media: { kind: 'voice' } }) + '\n');
  assert.deepEqual((await store.read(-123))[0], original);
  await store.compact();
  assert.deepEqual((await new ConversationStore(store.directory).read(-123))[0], original);
});

test('partial snapshots enrich missing evidence without replacing original metadata', () => {
  const original = { chatId: -123, messageId: 7, date: 1000, userId: 8, isBot: false, sender: '@speaker', text: '[voice без тексту]', isForum: true, messageThreadId: 42 };
  const enriched = mergeConversationItem(original, { ...original, text: '[voice transcript] Збережений голос.', messageThreadId: 99, media: { kind: 'voice', fileId: 'saved' } }, { partial: true });
  assert.equal(enriched.text, '[voice transcript] Збережений голос.');
  assert.equal(enriched.messageThreadId, 42);
  assert.equal(enriched.media.fileId, 'saved');
  assert.equal(mergeConversationItem({ ...original, text: 'Важливий підпис' }, { ...original, text: '[voice transcript] Голосове пояснення' }, { partial: true }).text, 'Важливий підпис\n[voice transcript] Голосове пояснення');
  assert.equal(mergeConversationItem({ ...original, text: 'Довге початкове повідомлення' }, { ...original, text: 'Довге' }).text, 'Довге початкове повідомлення');
});

test('actual forum flags define topic scope while ordinary reply ids do not', () => {
  assert.equal(conversationThreadId({ chat: { is_forum: false }, message_thread_id: 42 }), null);
  assert.equal(conversationThreadId({ message_thread_id: 42 }), null);
  assert.equal(conversationThreadId({ chat: { is_forum: true }, message_thread_id: 42 }), 42);
  assert.equal(conversationThreadId({ is_topic_message: true, message_thread_id: 42 }), 42);
  assert.equal(conversationThreadId({ chat: { is_forum: true }, message_thread_id: -1 }), null);
});

test('trusted ordinary scope repairs legacy reply ids and retains snapshot and known forum boundaries', () => {
  const rows = [
    { messageId: 1, messageThreadId: null },
    { messageId: 2, messageThreadId: 1, replyToMessageId: 1 },
    { messageId: 3, isForum: false, messageThreadId: null, replyToMessageId: 2 },
    { messageId: 4, isForum: true, messageThreadId: 1 },
    { messageId: 5, isForum: true, messageThreadId: 99 },
    { messageId: 10, messageThreadId: 1 },
  ].map(i => ({ chatId: -123, date: 1000, text: 'message', ...i }));
  rows.push({ ...rows[0], messageId: 6, date: 1001 });
  rows.push({ ...rows[0], messageId: 7, chatId: -999 });
  const scope = { chatId: -123, messageId: 10, date: 1000, isForum: false, threadId: 1 };
  const ordinary = scopedItems(rows, scope);
  assert.deepEqual(ordinary.map(i => i.messageId), [1, 2, 3]);
  assert.deepEqual(replyChain(ordinary, 3).map(i => i.messageId), [1, 2, 3]);
  assert.deepEqual(scopedItems(rows, { ...scope, isForum: true }).map(i => i.messageId), [2, 4]);
  assert.deepEqual(scopedItems(rows, { ...scope, isForum: true, threadId: 99 }).map(i => i.messageId), [5]);
});
