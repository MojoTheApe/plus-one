import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MediaOperations, mediaFailure, isMediaRetryText } from "../src/media-operations.js";
import { socialDownloadFailure } from "../src/social-downloader.js";

test("canonical retry fast path leaves clearly Russian requests to the language gate", () => {
  for (const value of ["повтори", "спробуй ще раз", "retry", "@ExampleBot повторити будь ласка"]) assert.equal(isMediaRetryText(value, "ExampleBot"), true);
  for (const value of ["попробуй еще раз", "повтори пожалуйста", "Я хотів розповісти, що він сказав retry"]) assert.equal(isMediaRetryText(value, "ExampleBot"), false);
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
