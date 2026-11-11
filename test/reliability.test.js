import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCodexEvents } from "../src/codex-backend.js";
import { taskResolutionPolicy, parseLanguageDecision, languageDecisionInstruction, publicLinks } from "../src/request-policy.js";
import { MediaOperations, mediaFailure, failureMessage, isMediaRetryText } from "../src/media-operations.js";
import { prepareMediaForTelegram } from "../src/media-preparation.js";

test("recovered stream error does not discard a successful final answer", () => {
  const value = parseCodexEvents([
    { type: "error", message: "reconnecting" }, { type: "item.completed", item: { type: "agent_message", phase: "final_answer", text: "Готово" } }, { type: "turn.completed" },
  ].map(JSON.stringify).join("\n"));
  assert.equal(value.failed, false); assert.equal(value.completed, true); assert.equal(value.text, "Готово"); assert.equal(value.transientErrors, 1);
});

test('replay: socket-timeout command option cannot turn an unsupported Threads URL into a timeout',()=>{
  const error=Object.assign(new Error('Command failed: yt-dlp --socket-timeout 20 --dump-single-json https://www.threads.com/share/example\nERROR: Unsupported URL: https://www.threads.com/@person/post/example'),{stderr:'ERROR: Unsupported URL: https://www.threads.com/@person/post/example'});
  const failure=mediaFailure(error);
  assert.equal(failure.code,'UNSUPPORTED'); assert.equal(failure.retryable,false);
  error.stderr='ERROR: Unsupported URL: https://www.threads.com/login/';
  assert.equal(mediaFailure(error).code,'AUTH_REQUIRED');
});


test("terminal failure and missing completion are distinguishable from success", () => {
  assert.equal(parseCodexEvents(JSON.stringify({ type: "turn.failed", error: { message: "failed" } })).failed, true);
  assert.equal(parseCodexEvents([{ type: "turn.failed" }, { type: "turn.completed" }].map(JSON.stringify).join("\n")).failed, true);
  assert.equal(parseCodexEvents(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "partial" } })).completed, false);
});
test("general source resolution keeps an arbitrary service and original task", () => {
  const p = taskResolutionPolicy("чи справжній цей запис?", "https://unknown-public-service.example/item/abc");
  assert.equal(p.requiresResearch, false); assert.equal(p.links.length, 1);
  assert.match(p.instruction, /ORIGINAL question/); assert.match(p.instruction, /other public sources/);
  assert.equal(taskResolutionPolicy("дякую", "https://example.org").requiresResearch, false);
  assert.deepEqual(publicLinks("https://127.0.0.1/x https://user:secret@example.org/private https://example.org/a"), ["https://example.org/a"]);
});
test("only a confident Russian decision permits a language reminder", () => {
  for (const language of ["uk", "mixed", "neutral", "unclear"]) assert.match(languageDecisionInstruction({ language, confident: true }), /Do not demand a rewrite/);
  assert.match(languageDecisionInstruction({ language: "ru", confident: false }), /Do not demand a rewrite/);
  assert.match(languageDecisionInstruction({ language: "ru", confident: true }), /existing short Ukrainian/);
  assert.deepEqual(parseLanguageDecision("garbage"), { language: "unclear", confident: false });
});

test("failure reasons distinguish duration, upload, auth, temporary and unknown failures", () => {
  const duration = mediaFailure(Object.assign(new Error("longer than limit"), { code: "SOCIAL_VIDEO_DURATION_LIMIT", actualDurationSeconds: 324 }));
  assert.match(duration.reason, /5:24/); assert.match(duration.reason, /5:00/); assert.equal(duration.retryable, false);
  const large = mediaFailure(Object.assign(new Error("Request Entity Too Large"), { status: 413 }), { stage: "upload" });
  assert.equal(large.code, "SIZE_LIMIT"); assert.match(large.reason, /надсилання/);
  assert.equal(mediaFailure(new Error("timeout")).retryable, true);
  assert.equal(mediaFailure(new Error("login required")).retryable, false);
  assert.equal(mediaFailure(new Error("unexplained")).code, "UNKNOWN");
  assert.equal(mediaFailure(Object.assign(new Error("duration unavailable"), { code: "MEDIA_DURATION_UNKNOWN" })).code, "METADATA");
  assert.match(failureMessage(duration, "case-id"), /case-id/);
});
test("media retries are exact commands, and persisted operations are chat/topic scoped", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-ops-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "ops.json"), store = new MediaOperations(file);
  await store.record({ chatId: -123, threadId: 9, userId: 88, sourceMessageId: 10, errorMessageId: 11, url: "https://example.org", status: "failed", failure: { code: "TIMEOUT", retryable: true } });
  const again = new MediaOperations(file);
  const message = { chat: { id: -123, is_forum:true }, is_topic_message:true, from: { id: 88 }, message_thread_id: 9, reply_to_message: { message_id: 11 } };
  assert.ok(await again.find(message));
  assert.equal(await again.find({ ...message, message_thread_id: 10 }), null);
  assert.equal(await again.find({ ...message, chat: { id: -999 } }), null);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await store.record({ chatId: -123, threadId: 9, userId: 88, sourceMessageId: 12, status: "running" });
  assert.equal((await again.find({ ...message, reply_to_message: undefined }, true)).status, "running");
  for (const text of ["Repeat", "@TestBot спробуй ще раз", "повтори будь ласка"]) assert.equal(isMediaRetryText(text, "TestBot"), true);
  assert.equal(isMediaRetryText("someone said Repeat yesterday", "TestBot"), false);
});
test("all downloaded videos, including fallback files, are rejected above five minutes", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-fit-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "video.mp4"); await fs.writeFile(file, "fixture");
  await assert.rejects(prepareMediaForTelegram([{ filePath: file, mediaKind: "video" }], {
    execute: async () => ({ stdout: JSON.stringify({ format: { duration: 301 }, streams: [{ codec_type: "video" }] }) }),
  }), error => error.code === "SOCIAL_VIDEO_DURATION_LIMIT" && error.actualDurationSeconds === 301);
  await assert.rejects(prepareMediaForTelegram([{ filePath: file, mediaKind: "video" }], {
    execute: async () => ({ stdout: JSON.stringify({ format: {}, streams: [{ codec_type: "video" }] }) }),
  }), error => error.code === "MEDIA_DURATION_UNKNOWN");
});
