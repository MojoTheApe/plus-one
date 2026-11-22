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

test("album file bindings survive missing neighbours and legacy albums never guess a selected file",async t=>{
  const directory=await temporaryDirectory(t),files=[];
  for(let index=0;index<3;index++){
    const filePath=path.join(directory,`input-${index}.jpg`);await fs.writeFile(filePath,String(index));files.push({filePath,mediaKind:'image',mimeType:'image/jpeg'});
  }
  const root=path.join(directory,'cache'),cache=new MediaCache(root);
  const stored=await cache.put({chatId:-1,sourceMessageId:10,files});await cache.bind(stored.id,[11,12,13]);
  await fs.rm(stored.files[0].filePath);
  const restored=new MediaCache(root),selected=await restored.get({chatId:-1,messageId:12});
  assert.equal(selected.files.length,1);assert.equal(await fs.readFile(selected.files[0].filePath,'utf8'),'1');assert.equal(selected.complete,true);
  assert.equal((await restored.get({chatId:-1,messageId:10})).complete,false);
  assert.equal(await restored.get({chatId:-1,messageId:11}),null);
  const index=JSON.parse(await fs.readFile(path.join(root,'index.json'),'utf8'));delete index.entries[0].bindings;
  await fs.writeFile(path.join(root,'index.json'),JSON.stringify(index));
  assert.equal(await new MediaCache(root).get({chatId:-1,messageId:12}),null);
  assert.equal((await new MediaCache(root).get({chatId:-1,messageId:12,wholePublication:true})).files.length,2);
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

test("acknowledged Telegram files survive disk eviction but remain isolated by bot, chat and topic", async t => {
  const directory = await temporaryDirectory(t), filePath = path.join(directory, "photo.jpg");
  await fs.writeFile(filePath, "media");
  const root = path.join(directory, "cache"), cache = new MediaCache(root);
  const entry = await cache.put({ chatId: -1, topicId: 9, sourceMessageId: 10, sourceUrl: "https://www.instagram.com/p/BA/?igsh=first",
    files: [{ filePath, mediaKind: "image", mimeType: "image/jpeg" }] });
  await cache.bind(entry.id, [11], { botId: 77, items: [{ photo: [{ file_id: "acknowledged-photo" }] }] });
  await fs.rm(entry.files[0].filePath);
  const restored = new MediaCache(root), scope = { chatId: -1, topicId: 9, botId: 77, sourceUrl: "https://www.instagram.com/reel/BA/?igsh=second" };
  const reused = await restored.forDelivery(scope);
  assert.equal(reused.complete, true); assert.equal(reused.files[0].telegramFileId, "acknowledged-photo");
  assert.equal((await restored.forDelivery({ ...scope, botId: 78 })).complete, false);
  assert.equal(await restored.forDelivery({ ...scope, chatId: -2 }), null);
  assert.equal(await restored.forDelivery({ ...scope, topicId: 10 }), null);
  await restored.invalidateReceipts(entry.id, [0]);
  assert.equal(await restored.forDelivery(scope), null);
});

test("unfinished albums reserve disk space rather than losing their remaining files to a new job", async t => {
  const directory = await temporaryDirectory(t), filePath = path.join(directory, "photo.jpg");
  await fs.writeFile(filePath, Buffer.alloc(6));
  const cache = new MediaCache(path.join(directory, "cache"), { maxTotalBytes: 10 });
  const pending = await cache.put({ chatId: 1, sourceMessageId: 1, files: [{ filePath }], pending: true });
  await assert.rejects(cache.put({ chatId: 2, sourceMessageId: 2, files: [{ filePath }], pending: true }), { code: "MEDIA_CACHE_CAPACITY" });
  assert.equal((await cache.get({ chatId: 1, messageId: 1 })).complete, true);
  await cache.release(pending.id);
  const next = await cache.put({ chatId: 2, sourceMessageId: 2, files: [{ filePath }], pending: true });
  assert.equal(next.complete, true);
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

test('verified complete references last 30 days, while local bytes and incomplete/legacy records expire at 48 hours', async t => {
  const { verifiedMediaSource } = await import('../src/media-source.js');
  const directory = await temporaryDirectory(t), filePath = path.join(directory, 'photo.png');
  await fs.writeFile(filePath, 'media');
  let now = 0; const hour = 3600000, root = path.join(directory, 'cache');
  const cache = new MediaCache(root, { now: () => now });
  const url = 'https://www.instagram.com/p/BA/';
  const source = verifiedMediaSource(url, { provider: 'instaloader', id: 'BA', owner: 'fixture' });
  const file = { filePath, sourceItemId: 'native:64', mediaKind: 'image', mimeType: 'image/png' };
  const complete = await cache.put({ chatId: -1, topicId: 9, sourceMessageId: 1, sourceUrl: url, source, files: [file], pending: true });
  await cache.bind(complete.id, [11], { botId: 77, items: [{ photo: [{ file_id: 'known' }] }] });
  await cache.release(complete.id);
  const legacy = await cache.put({ chatId: -1, sourceMessageId: 2, sourceUrl: url, source, files: [{ ...file, sourceItemId: undefined }] });
  await cache.bind(legacy.id, [12], { botId: 77, items: [{ photo: [{ file_id: 'old' }] }] });
  await cache.put({ chatId: -2, sourceMessageId: 3, sourceUrl: url, source, files: [file], pending: true });
  now = 48 * hour;
  const restored = new MediaCache(root, { now: () => now });
  const scope = { chatId: -1, topicId: 9, botId: 77, sourceUrl: url };
  const found = await restored.forDelivery(scope);
  assert.equal(found.complete, true); assert.equal(found.files[0].telegramFileId, 'known');
  assert.equal(found.files[0].sourceItemId, 'native:64'); assert.equal(found.files[0].filePath, undefined);
  await assert.rejects(fs.stat(complete.files[0].filePath), { code: 'ENOENT' });
  assert.equal(await restored.get({ chatId: -1, messageId: 2 }), null);
  assert.equal(await restored.get({ chatId: -2, messageId: 3 }), null);
  assert.equal((await restored.forDelivery({ ...scope, botId: 78 })).complete, false);
  assert.equal(await restored.forDelivery({ ...scope, topicId: 10 }), null);
  // Starting a repeat of a 2-day-old record gets its own bounded recovery hold.
  await restored.hold(complete.id); now += hour;
  assert.equal((await restored.forDelivery({ ...scope, entryId: complete.id })).complete, true);
  await restored.hold(complete.id); now = 96 * hour;
  assert.equal(await restored.forDelivery({ ...scope, entryId: complete.id }), null, 'retry does not extend the hold');
});

test('complete metadata expires at 30 days and entry bounds still apply', async t => {
  const { verifiedMediaSource } = await import('../src/media-source.js');
  const directory = await temporaryDirectory(t), filePath = path.join(directory, 'photo.png'); await fs.writeFile(filePath, 'media');
  let now = 0; const cache = new MediaCache(path.join(directory, 'cache'), { now: () => now, maxEntries: 1 });
  const url = 'https://www.instagram.com/p/BA/', source = verifiedMediaSource(url, { provider: 'instaloader', id: 'BA', owner: 'fixture' });
  const put = async messageId => {
    const entry = await cache.put({ chatId: -1, sourceMessageId: messageId, sourceUrl: url, source, files: [{ filePath, sourceItemId: 'native:64', mediaKind: 'image' }] });
    await cache.bind(entry.id, [messageId + 10], { botId: 77, items: [{ photo: [{ file_id: 'known' }] }] }); return entry;
  };
  await put(1); now++; const second = await put(2);
  assert.equal(await cache.get({ chatId: -1, messageId: 1 }), null);
  now += 30 * 86400000;
  assert.equal(await cache.forDelivery({ chatId: -1, entryId: second.id, botId: 77 }), null);
});

test('long-lived metadata cannot exceed the readable index bound or evict pending recovery', async t => {
  const { verifiedMediaSource } = await import('../src/media-source.js');
  const directory = await temporaryDirectory(t), filePath = path.join(directory, 'tiny.png'); await fs.writeFile(filePath, 'tiny');
  const cache = new MediaCache(path.join(directory, 'cache')), limit = 4 * 1024 * 1024;
  const url = 'https://www.instagram.com/p/BA/', source = verifiedMediaSource(url, { provider: 'instaloader', id: 'BA', owner: 'fixture' });
  const files = Array.from({ length: 20 }, (_, i) => ({ filePath, sourceItemId: `native:${i}`, mediaKind: 'image', mimeType: 'image/png', title: 'x'.repeat(1000) }));
  const pinned = await cache.put({ chatId: 1, sourceMessageId: 500, sourceUrl: url, source, title: 'x'.repeat(1000), files, pending: true });
  await cache.bind(pinned.id, Array.from({ length: 20 }, (_, i) => 600 + i), { botId: 77, items: files.map((_, i) => ({ photo: [{ file_id: `known-${i}` + 'x'.repeat(100) }] })) });
  const original = (await cache.read()).entries[0], state = { version: 1, entries: [original] };
  while (true) {
    state.entries.push({ ...structuredClone(original), id: randomUUID(), chatId: state.entries.length + 2, files: [], pending: false, createdAt: Date.now() - 49 * 3600000 });
    if (Buffer.byteLength(JSON.stringify(state)) >= limit) { state.entries.pop(); break; }
  }
  assert.ok(state.entries.length < 300);
  await fs.writeFile(cache.index, JSON.stringify(state));
  const next = await cache.put({ chatId: -1, sourceMessageId: 501, sourceUrl: url, source, title: 'x'.repeat(1000), files, pending: true });
  assert.ok((await fs.stat(cache.index)).size <= limit);
  const restored = await new MediaCache(cache.directory).read();
  assert.ok(restored.entries.some(item => item.id === pinned.id && item.pending));
  assert.ok(restored.entries.some(item => item.id === next.id));
  assert.ok(restored.entries.length <= state.entries.length, 'completed metadata was evicted to fit');
  await cache.compact();
  // When every near-limit entry protects a pending attempt, fail before writing.
  for (const item of state.entries) { item.pending = true; item.pendingSince = Date.now(); }
  while (Buffer.byteLength(JSON.stringify(state)) > limit) state.entries.pop();
  const protectedIndex = JSON.stringify(state); await fs.writeFile(cache.index, protectedIndex);
  await assert.rejects(cache.put({ chatId: -2, sourceMessageId: 502, sourceUrl: url, source, title: 'x'.repeat(1000), files, pending: true }), { code: 'MEDIA_CACHE_CAPACITY' });
  assert.equal(await fs.readFile(cache.index, 'utf8'), protectedIndex);
  assert.equal((await cache.read()).entries.length, state.entries.length);
  assert.equal(await fs.readFile(pinned.files[0].filePath, 'utf8'), 'tiny');
});

test("a document fallback preserves the message binding and clears an earlier photo or video receipt", async t => {
  const directory = await temporaryDirectory(t), filePath = path.join(directory, "file");
  await fs.writeFile(filePath, "test");
  const cacheRoot = path.join(directory, "cache"), cache = new MediaCache(cacheRoot);
  const files = ["image", "video", "document"].map(mediaKind => ({ filePath, mediaKind }));
  const entry = await cache.put({ chatId: 7, sourceMessageId: 1, files });
  await cache.bind(entry.id, [11, 12], { botId: 9, items: [{ photo: [{ file_id: "old-photo" }] }, { video: { file_id: "old-video" } }] });
  await cache.bind(entry.id, [21, 22, 23], { botId: 9, items: files.map(() => ({ document: { file_id: "document" } })) });
  const restored = new MediaCache(cacheRoot);
  const publication = await restored.forDelivery({ chatId: 7, entryId: entry.id, botId: 9 });
  assert.deepEqual(publication.files.map(f => f.telegramFileId), [undefined, undefined, "document"]);
  assert.deepEqual((await restored.get({ chatId: 7, messageId: 21 })).files.map(f => f.mediaKind), ["image"]);
});

test("legacy Threads previews and potentially truncated slides are readable by message but never reused for a fresh URL", async t => {
  const { verifiedMediaSource } = await import("../src/media-source.js");
  const directory = await temporaryDirectory(t), filePath = path.join(directory, "one.jpg");
  const cacheRoot = path.join(directory, "cache"), cache = new MediaCache(cacheRoot);
  await fs.writeFile(filePath, "first slide");
  const cases = [["threads-page", "https://www.threads.com/@u/post/abc/", "abc"], ["tiktok-api", "https://www.tiktok.com/@u/photo/1/", "1"]];
  for (const [provider, url, id] of cases) {
    const source = verifiedMediaSource(url, { provider, id, owner: "u" });
    const entry = await cache.put({ chatId: 7, sourceMessageId: 11, source, sourceUrl: url, files: [{ filePath, mediaKind: "image" }] });
    const index = await cache.read();
    delete index.entries.find(item => item.id === entry.id).orderedMediaVersion;
    await cache.write(index);
    const restored = new MediaCache(cacheRoot);
    assert.equal(await restored.forDelivery({ chatId: 7, sourceUrl: url, botId: 9 }), null);
    assert.equal((await restored.forDelivery({ chatId: 7, entryId: entry.id, botId: 9 })).complete, true);
    assert.equal((await restored.get({ chatId: 7, messageId: 11 })).complete, true);
  }
});

test("unversioned Instaloader entries require proof that a fresh URL was a single-item publication", async t => {
  const { verifiedMediaSource } = await import("../src/media-source.js");
  const directory = await temporaryDirectory(t), filePath = path.join(directory, "slide.jpg");
  await fs.writeFile(filePath, "prepared historical bytes");
  const cache = new MediaCache(path.join(directory, "cache"));
  const cases = [[undefined, undefined], [undefined], ["sha256:original"], ["native:2488"],
    ["publication:wrong"], ["publication:verified"]];
  for (const [index, ids] of cases.entries()) {
    const id = index === cases.length - 1 ? "verified" : "legacy" + index;
    const url = "https://www.instagram.com/p/" + id + "/", source = verifiedMediaSource(url, { provider:"instaloader", id, owner:"fixture" });
    const entry = await cache.put({ chatId:1, sourceMessageId:20 + index, sourceUrl:url, source,
      files:ids.map(sourceItemId => ({filePath, mediaKind:"image", sourceItemId})) });
    const old = await cache.read();
    delete old.entries.find(item => item.id === entry.id).orderedMediaVersion;
    await cache.write(old);
    const fresh = await cache.forDelivery({chatId:1, sourceUrl:url});
    assert.equal(Boolean(fresh?.complete), id === "verified", id);
    assert.equal((await cache.get({chatId:1,messageId:20 + index})).files.length, ids.length);
    assert.ok((await cache.forDelivery({chatId:1,entryId:entry.id})).complete);
  }
});

test("TikTok video and photo aliases with the same ID cannot reuse a rendered clip as source slides", async t => {
  const { verifiedMediaSource } = await import("../src/media-source.js");
  const directory = await temporaryDirectory(t), filePath = path.join(directory, "rendered.mp4");
  await fs.writeFile(filePath, "clip");
  const cache = new MediaCache(path.join(directory, "cache"));
  const video = "https://www.tiktok.com/@u/video/123/", photo = "https://www.tiktok.com/@u/photo/123/";
  const source = verifiedMediaSource(video, { provider: "yt-dlp", id: "123", owner: "u" });
  await cache.put({ chatId: 1, sourceMessageId: 10, source, sourceUrl: video, files: [{ filePath, mediaKind: "video" }] });
  assert.ok((await cache.forDelivery({ chatId: 1, sourceUrl: video })).complete);
  assert.equal(await cache.forDelivery({ chatId: 1, sourceUrl: photo }), null);
});

test('cross-message reuse binds an opaque share to the verified request and original topic', async t => {
  const { verifiedMediaSource } = await import('../src/media-source.js');
  const directory = await temporaryDirectory(t), filePath = path.join(directory, 'photo.jpg');
  await fs.writeFile(filePath, 'fixture');
  const cache = new MediaCache(path.join(directory, 'cache'));
  const share = 'https://www.threads.com/share/example/';
  const other = 'https://www.threads.com/share/other/';
  const post = 'https://www.threads.com/@example/post/ABC/';
  const record = { chatId: 1, topicId: 2, sourceMessageId: 20, sourceUrl: share,
    files: [{ filePath, mediaKind: 'image' }] };
  const scope = { chatId: 1, topicId: 2, sourceUrl: share, verifiedPublication: true };
  const from = url => verifiedMediaSource(url, { provider: 'threads-page', resolvedUrl: post, id: 'ABC', owner: 'example' });
  await cache.put({ ...record, source: from(other) });
  assert.equal(await cache.forDelivery(scope), null);
  await cache.put({ ...record, source: from(share) });
  assert.equal((await cache.forDelivery(scope)).complete, true);
  assert.equal(await cache.forDelivery({ ...scope, topicId: 3 }), null);
});
