import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MediaCache } from "../src/media-cache.js";

test("cache binds source and sent IDs, survives restart and keeps forum topics isolated", async t => {
  const directory = await temporaryDirectory(t), filePath = path.join(directory, "source.mp4");
  await fs.writeFile(filePath, "media");
  const cacheRoot = path.join(directory, "cache"), cache = new MediaCache(cacheRoot);
  const stored = await cache.put({ chatId: -1, topicId: null, sourceMessageId: 10, sourceUrl: "https://example.org/reel", files: [{ filePath, mediaKind: "video", mimeType: "video/mp4" }] });
  assert.equal(stored.complete, true);
  await cache.bind(stored.id, [11, 12]);
  await fs.rm(filePath);
  const restored = new MediaCache(cacheRoot);
  for (const messageId of [10, 11, 12]) {
    const entry = await restored.get({ chatId: -1, messageId });
    assert.equal(entry.sourceUrl, "https://example.org/reel");
    assert.equal(await fs.readFile(entry.files[0].filePath, "utf8"), "media");
    assert.equal((await fs.stat(entry.files[0].filePath)).mode & 0o777, 0o600);
    assert.equal(await restored.get({ chatId: -2, messageId }), null);
    assert.equal(await restored.get({ chatId: -1, topicId: 55, messageId }), null);
  }
  assert.equal((await fs.stat(path.join(cacheRoot, "index.json"))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(cacheRoot)).mode & 0o777, 0o700);
});

test("cache expires old media, evicts oldest to total budget and skips oversize input", async t => {
  const directory = await temporaryDirectory(t), filePath = path.join(directory, "source.mp4");
  await fs.writeFile(filePath, Buffer.alloc(6));
  let now = 0;
  const cache = new MediaCache(path.join(directory, "cache"), { now: () => now, ttlMs: 1000, maxTotalBytes: 10, maxFileBytes: 8 });
  const first = await cache.put({ chatId: 1, sourceMessageId: 1, files: [{ filePath }] });
  now = 1;
  const second = await cache.put({ chatId: 1, sourceMessageId: 2, files: [{ filePath }] });
  assert.equal(await cache.get({ chatId: 1, messageId: 1 }), null);
  assert.ok(await cache.get({ chatId: 1, messageId: 2 }));
  await assert.rejects(fs.stat(first.files[0].filePath), error => error.code === "ENOENT");
  await fs.writeFile(filePath, Buffer.alloc(9));
  assert.equal(await cache.put({ chatId: 1, sourceMessageId: 3, files: [{ filePath }] }), null);
  assert.equal((await cache.compact()).bytes, 6);
  now = 1001;
  assert.equal(await cache.get({ chatId: 1, messageId: 2 }), null);
  await assert.rejects(fs.stat(second.files[0].filePath), error => error.code === "ENOENT");
});

test("cache removes missing files and reports partial cached albums", async t => {
  const directory = await temporaryDirectory(t), filePath = path.join(directory, "source.mp4"), large = path.join(directory, "large.mp4");
  await fs.writeFile(filePath, "a"); await fs.writeFile(large, "oversized");
  const cache = new MediaCache(path.join(directory, "cache"), { maxFileBytes: 2 });
  const stored = await cache.put({ chatId: 1, sourceMessageId: 1, files: [{ filePath }, { filePath: large }] });
  assert.equal(stored.files.length, 1);
  assert.equal(stored.complete, false);
  await fs.rm(stored.files[0].filePath);
  assert.equal(await cache.get({ chatId: 1, messageId: 1 }), null);
});

test("corrupt paths and symlinks cannot read or remove files outside the cache", async t => {
  const directory = await temporaryDirectory(t), outside = path.join(directory, "outside");
  await fs.mkdir(outside);
  const important = path.join(outside, "keep.txt"); await fs.writeFile(important, "keep");
  const root = path.join(directory, "cache"), cache = new MediaCache(root);
  await cache.compact();
  const id = randomUUID();
  await fs.symlink(outside, path.join(root, id));
  await fs.writeFile(path.join(root, "index.json"), JSON.stringify({ version: 1, entries: [
    { id, createdAt: Date.now(), chatId: 1, sourceMessageId: 1, files: [{ name: "1.txt" }] },
    { id: "../outside", createdAt: 0, chatId: 1, files: [{ name: "keep.txt" }] },
  ] }));
  assert.equal(await cache.get({ chatId: 1, messageId: 1 }), null);
  assert.equal(await fs.readFile(important, "utf8"), "keep");
  const linkedRoot = path.join(directory, "linked-cache"); await fs.symlink(outside, linkedRoot);
  await assert.rejects(new MediaCache(linkedRoot).compact(), /regular directory/);
});

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "media-cache-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
