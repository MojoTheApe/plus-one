import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MediaOperations, mediaFailure, isMediaRetryText, canRetryMediaOperation } from "../src/media-operations.js";
import { socialDownloadFailure } from "../src/social-downloader.js";

test("canonical retry fast path leaves clearly Russian requests to the language gate", () => {
  for (const value of ["повтори", "спробуй ще раз", "retry", "@ExampleBot повторити будь ласка"]) assert.equal(isMediaRetryText(value, "ExampleBot"), true);
  for (const value of ["попробуй еще раз", "повтори пожалуйста", "Я хотів розповісти, що він сказав retry"]) assert.equal(isMediaRetryText(value, "ExampleBot"), false);
});

test('only the exact legacy masked transient pattern can retry without weakening real source or upload restrictions', () => {
  const operation = { status: 'failed', downloader: 'snapinsta', source: { status: 'unverified' },
    failure: { code: 'SOURCE_UNVERIFIED', retryable: false, causes: [
      { provider: 'yt-dlp', code: 'RATE_LIMIT', retryable: true },
      { provider: 'instagram', code: 'SOURCE_UNVERIFIED', retryable: false },
    ] },
  };
  for (const code of ['RATE_LIMIT', 'NO_MEDIA', 'TIMEOUT', 'SERVICE_ERROR']) {
    const candidate = structuredClone(operation); candidate.failure.causes[0].code = code;
    assert.equal(canRetryMediaOperation(candidate), true);
  }
  for (const change of [
    { status: 'unknown' }, { sentMessageIds: [123] }, { deliveredFileCount: 1 },
    { downloader: 'threads-page' }, { source: { status: 'verified' } },
    { failure: { ...operation.failure, code: 'SOURCE_MISMATCH' } },
    { failure: { ...operation.failure, causes: [{ provider: 'yt-dlp', code: 'AUTH_REQUIRED', retryable: false }, operation.failure.causes[1]] } },
    { failure: { code: 'SOURCE_UNVERIFIED', retryable: false } },
  ]) assert.equal(canRetryMediaOperation({ ...operation, ...change }), false);
  assert.equal(canRetryMediaOperation({ failure: { retryable: true } }), true);
});

test('a disabled adapter cannot mask native missing-media or login errors; a real source mismatch remains decisive', () => {
  for (const [message, code] of [['No video formats found', 'NO_MEDIA'], ['Login required', 'AUTH_REQUIRED']]) {
    const disabled = Object.assign(new Error('unverified'), { code: 'MEDIA_SOURCE_UNVERIFIED', fallbackDisabled: true });
    const failure = mediaFailure(socialDownloadFailure(new Error(message), disabled, 'instagram'));
    assert.equal(failure.code, code);
    const mismatch = Object.assign(new Error('wrong item'), { code: 'MEDIA_SOURCE_MISMATCH' });
    assert.equal(mediaFailure(socialDownloadFailure(new Error(message), mismatch, 'tiktok')).code, 'SOURCE_MISMATCH');
  }
});

test("ordinary reply IDs are not forum scopes, and old error plus sent IDs survive retry updates", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "media-scope-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "operations.json"), operations = new MediaOperations(file);
  const first = await operations.record({ chatId: -1, topicId: null, userId: 10, sourceMessageId: 20, errorMessageId: 21, status: "failed" });
  await operations.record({ id: first.id, errorMessageId: 23, sentMessageIds: [24, 25], status: "done" });
  const restored = new MediaOperations(file);
  for (const id of [20, 21, 23, 24, 25]) {
    const message = { chat: { id: -1 }, from: { id: 99 }, message_thread_id: 21, reply_to_message: { message_id: id } };
    assert.equal((await restored.find(message))?.id, first.id);
    assert.equal(await restored.find({ ...message, is_topic_message: true }), null);
    assert.equal(await restored.find({ ...message, chat: { id: -2 } }), null);
  }
});

test("forum topics remain isolated and normalized scope is explicit", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "media-topic-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const operations = new MediaOperations(path.join(directory, "operations.json"));
  await operations.record({ chatId: -1, topicId: 100, sourceMessageId: 20, userId: 10, status: "failed" });
  const message = { chat: { id: -1 }, from: { id: 10 }, message_thread_id: 100, reply_to_message: { message_id: 20 } };
  assert.equal(await operations.find(message), null);
  assert.ok(await operations.find(message, false, { chatId: -1, topicId: 100 }));
  assert.ok(await operations.find({ ...message, is_topic_message: true }));
  assert.equal(await operations.find({ ...message, is_topic_message: true, message_thread_id: 101 }), null);
  assert.equal(await operations.find({ ...message, reply_to_message: { message_id: 999 } }, true, { topicId: 100 }), null);
});

test("download diagnosis retains both real failures without inventing throttling", () => {
  const primary = Object.assign(new Error("Command failed"), { stderr: "ERROR: This content is not available for this audience" });
  const fallback = new Error("third-party Instagram fetch returned no media");
  const error = socialDownloadFailure(primary, fallback, "instagram");
  assert.equal(error.cause, primary);
  const failure = mediaFailure(error);
  assert.equal(failure.code, "UNAVAILABLE");
  assert.deepEqual(failure.causes.map(cause => cause.code), ["UNAVAILABLE", "NO_MEDIA"]);
  assert.equal(failure.reason.includes("запитів"), false);
  assert.equal(failure.reason.includes("audience"), false);
  assert.equal(mediaFailure(Object.assign(new Error("upstream rejected request"), { status: 403 })).code, "UNAVAILABLE");
  assert.equal(mediaFailure(new Error("Log in to view this private content")).code, "AUTH_REQUIRED");
  assert.equal(mediaFailure(new Error("cookies may help improve results")).code, "UNKNOWN");
  assert.equal(mediaFailure(Object.assign(new Error("upstream busy"), { status: 429 })).code, "RATE_LIMIT");
});
