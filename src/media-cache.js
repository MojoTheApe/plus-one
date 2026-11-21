import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertVerifiedMediaSource, isTikTokPhotoSet, mediaPublicationKey, mediaReference } from "./media-source.js";
import { assertSameMediaItems, hasMediaItemIdentity, maxPublicationItems } from "./media-items.js";

const safeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const safeName = /^\d{1,2}\.[a-z0-9]{1,6}$/;
const maxIndexBytes = 4 * 1024 * 1024;

export class MediaCache {
  constructor(directory, { ttlMs = 48 * 3600000, receiptTtlMs = 30 * 86400000, maxTotalBytes = 256 * 1024 * 1024,
    maxFileBytes = 48 * 1024 * 1024, maxEntries = 300, now = Date.now } = {}) {
    this.directory = path.resolve(directory);
    Object.assign(this, { ttlMs, receiptTtlMs, maxTotalBytes, maxFileBytes, maxEntries, now });
    this.index = path.join(this.directory, "index.json");
    this.queue = Promise.resolve();
  }

  async put({ chatId, topicId = null, sourceMessageId, sourceUrl = "", source = null, title = "", files = [], pending = false }) {
    return this.lock(async () => {
      const state = await this.read();
      await this.trim(state);
      const id = randomUUID(), destination = path.join(this.directory, id);
      const entry = { id, chatId, topicId, sourceMessageId, sourceUrl: String(sourceUrl).slice(0, 4096), orderedMediaVersion: 1,
        source, title: String(title).slice(0, 1000), sentMessageIds: [], bindings: [], receipts: [], sourceMessageIds: [sourceMessageId],
        createdAt: this.now(), pending, ...(pending ? { pendingSince: this.now() } : {}), files: [], sourceFileCount: files.length,
        manifest: files.map((file, index) => ({ index, sourceItemId: file.sourceItemId, mediaKind: file.mediaKind, mimeType: file.mimeType,
          title: String(file.title || title).slice(0, 1000), size: file.size, width: file.width, height: file.height, duration: file.duration, hasAudio: file.hasAudio })) };
      if (pending) {
        const sizes = await Promise.all(files.map(file => fs.lstat(file.filePath)));
        const required = sizes.reduce((sum, stat) => sum + stat.size, 0);
        const reserved = state.entries.filter(item => item.pending).reduce((sum, item) => sum + item.files.reduce((n, file) => n + file.size, 0), 0);
        if (files.length > maxPublicationItems || sizes.some(stat => !stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxFileBytes) || required + reserved > this.maxTotalBytes) {
          throw capacityError();
        }
      }
      await fs.mkdir(destination, { mode: 0o700 });
      try {
        let bytes = 0;
        for (const [index, file] of files.slice(0, maxPublicationItems).entries()) {
          const source = await fs.lstat(file.filePath).catch(() => null);
          if (!source?.isFile() || source.isSymbolicLink() || source.size > this.maxFileBytes
            || bytes + source.size > this.maxTotalBytes) continue;
          const extension = path.extname(file.filePath).slice(1).toLowerCase();
          const name = `${index + 1}.${/^[a-z0-9]{1,6}$/.test(extension) ? extension : "bin"}`;
          const target = path.join(destination, name);
          await fs.copyFile(file.filePath, target);
          await fs.chmod(target, 0o600);
          const copied = await fs.lstat(target);
          if (copied.size > this.maxFileBytes || bytes + copied.size > this.maxTotalBytes) { await fs.unlink(target); continue; }
          bytes += copied.size;
          entry.files.push({ name, index, sourceItemId: file.sourceItemId, mediaKind: file.mediaKind, mimeType: file.mimeType,
            title: String(file.title || "").slice(0, 1000), size: copied.size });
        }
        if (entry.files.length) state.entries.push(entry);
        else await this.removeEntry(id);
        await this.trim(state);
        await this.write(state);
        return state.entries.some(item => item.id === id) ? this.expose(entry) : null;
      } catch (error) { await this.removeEntry(id); throw error; }
    });
  }

  async bind(entryId, sentMessageIds, { startIndex = 0, items = [], botId, sourceMessageId } = {}) {
    return this.lock(async () => {
      const state = await this.read();
      await this.trim(state);
      const entry = state.entries.find(item => item.id === entryId);
      if (entry) {
        if (Number.isSafeInteger(sourceMessageId)) entry.sourceMessageIds = [...new Set([...(entry.sourceMessageIds || []), sourceMessageId])].slice(-50);
        entry.sentMessageIds = [...new Set([...entry.sentMessageIds, ...sentMessageIds.filter(Number.isSafeInteger)])].slice(-50);
        for (const [offset, messageId] of sentMessageIds.entries()) {
          const index = startIndex + offset;
          const file = (entry.manifest?.length ? entry.manifest : entry.files).find(file => file.index === index);
          if (!Number.isSafeInteger(messageId) || messageId <= 0 || !file) continue;
          const binding = entry.bindings.find(binding => binding.messageId === messageId);
          if (binding) binding.index = index;
          else entry.bindings.push({ messageId, index });
          const item = items[offset];
          if (Number.isSafeInteger(botId) && (item?.video || item?.photo || item?.document)) {
            const fileId = file.mediaKind === "image" ? item.photo?.at(-1)?.file_id :
              file.mediaKind === "video" ? item.video?.file_id : file.mediaKind === "document" ? item.document?.file_id : undefined;
            if (typeof fileId === "string" && fileId.length && fileId.length <= 1024) {
              entry.receipts = [...entry.receipts.filter(receipt => receipt.index !== index), { index, botId, fileId }];
            } else {
              entry.receipts = entry.receipts.filter(receipt => receipt.index !== index || receipt.botId !== botId);
            }
          }
        }
        entry.bindings = retainMediaBindings(entry.bindings);
      }
      await this.write(state);
      return entry ? this.expose(entry) : null;
    });
  }

  async get({ chatId, topicId = null, messageId, wholePublication = false, sourceUrl }) {
    return this.lock(async () => {
      const state = await this.read();
      await this.trim(state);
      const key = sourceUrl && mediaPublicationKey(sourceUrl);
      const entry = state.entries.slice().reverse().find(item => String(item.chatId) === String(chatId)
        && item.topicId === topicId && (!key || [item.sourceUrl, item.source?.resolved?.url].some(url => url && mediaPublicationKey(url) === key))
        && (item.sourceMessageId === messageId || item.sourceMessageIds?.includes(messageId) ||
          item.sentMessageIds.includes(messageId) || item.bindings.some(binding => binding.messageId === messageId)));
      await this.write(state);
      if (!entry) return null;
      if (messageId === entry.sourceMessageId || entry.sourceMessageIds?.includes(messageId) || wholePublication) return this.expose(entry);
      let index = entry.bindings.find(binding => binding.messageId === messageId)?.index;
      // A legacy single-file receipt is unambiguous; an old album without file
      // bindings must be read from that exact Telegram message, not guessed.
      if (index === undefined && entry.sourceFileCount === 1 && entry.files.length === 1) index = entry.files[0].index;
      const file = entry.files.find(file => file.index === index);
      const exposed = this.expose(entry);
      return file ? { ...exposed, files: exposed.files.filter(item => item.index === index),
        complete: true, selection: "item", selectedFileIndex: index } : null;
    });
  }

  async forDelivery({ chatId, topicId = null, messageId, entryId, sourceUrl, botId }) {
    return this.lock(async () => {
      const state = await this.read();
      await this.trim(state);
      const key = sourceUrl && mediaPublicationKey(sourceUrl);
      const entry = state.entries.slice().reverse().find(item => String(item.chatId) === String(chatId) && item.topicId === topicId &&
        (entryId ? item.id === entryId : messageId ? item.sourceMessageId === messageId : !item.pending && key && reusablePublication(item, sourceUrl)) &&
        (!key || [item.sourceUrl, item.source?.requested?.url, item.source?.resolved?.url].some(value => value && mediaPublicationKey(value) === key)));
      await this.write(state);
      if (!entry) return null;
      const manifest = entry.manifest?.length === entry.sourceFileCount ? entry.manifest : entry.files;
      const files = manifest.map(item => {
        const local = entry.files.find(file => file.index === item.index);
        const receipt = entry.receipts?.find(value => value.index === item.index && value.botId === botId);
        return { ...item, ...(local ? { ...local, filePath: path.join(this.directory, entry.id, local.name) } : {}),
          ...(receipt ? { telegramFileId: receipt.fileId } : {}) };
      });
      return { ...this.expose(entry), files, complete: files.length === entry.sourceFileCount && files.every(file => file.filePath || file.telegramFileId) };
    });
  }

  async release(entryId) {
    return this.lock(async () => {
      const state = await this.read(), entry = state.entries.find(item => item.id === entryId);
      if (entry) { entry.pending = false; delete entry.pendingSince; }
      await this.write(state);
    });
  }

  async hold(entryId) {
    return this.lock(async () => {
      const state = await this.read(), entry = state.entries.find(item => item.id === entryId);
      if (entry && !entry.pending) { entry.pending = true; entry.pendingSince = this.now(); }
      await this.write(state);
    });
  }

  async invalidateReceipts(entryId, indexes) {
    return this.lock(async () => {
      const state = await this.read(), entry = state.entries.find(item => item.id === entryId);
      if (entry) entry.receipts = (entry.receipts || []).filter(receipt => !indexes.includes(receipt.index));
      await this.write(state);
    });
  }

  async copyAcknowledged(fromId, toId, { count, botId } = {}) {
    return this.lock(async () => {
      const state = await this.read(), from = state.entries.find(entry => entry.id === fromId), to = state.entries.find(entry => entry.id === toId);
      if (!from || !to || !Number.isSafeInteger(count) || count < 0 || count > to.sourceFileCount ||
          String(from.chatId) !== String(to.chatId) || from.topicId !== to.topicId ||
          mediaPublicationKey(from.sourceUrl) !== mediaPublicationKey(to.sourceUrl)) throw new Error("Invalid acknowledged media transfer");
      assertSameMediaItems(from.manifest, to.manifest, to.source?.provider);
      to.receipts = from.receipts.filter(item => item.index < count && item.botId === botId);
      to.bindings = from.bindings.filter(item => item.index < count);
      to.sentMessageIds = to.bindings.map(item => item.messageId);
      to.sourceMessageIds = [...new Set([...from.sourceMessageIds, ...to.sourceMessageIds])].slice(-50);
      await this.write(state);
    });
  }

  async compact() {
    return this.lock(async () => {
      const state = await this.read();
      await this.trim(state);
      await this.write(state);
      return { entries: state.entries.length, bytes: state.entries.reduce((sum, entry) => sum + entry.files.reduce((n, file) => n + file.size, 0), 0) };
    });
  }

  lock(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async read() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const root = await fs.lstat(this.directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Media cache directory must be a regular directory");
    await fs.chmod(this.directory, 0o700);
    try {
      const indexStat = await fs.lstat(this.index);
      if (!indexStat.isFile() || indexStat.isSymbolicLink() || indexStat.size > maxIndexBytes) throw new Error("Invalid media cache index file");
      const state = JSON.parse(await fs.readFile(this.index, "utf8"));
      if (state.version !== 1 || !Array.isArray(state.entries)) throw new Error("Invalid media cache index");
      return { version: 1, entries: state.entries.filter(entry => entry && safeId.test(entry.id)
        && Number.isFinite(entry.createdAt) && Array.isArray(entry.files)).map(entry => ({ ...entry,
          topicId: entry.topicId ?? null, sentMessageIds: Array.isArray(entry.sentMessageIds) ? entry.sentMessageIds.filter(Number.isSafeInteger).slice(-50) : [],
          sourceMessageIds: Array.isArray(entry.sourceMessageIds) ? entry.sourceMessageIds.filter(Number.isSafeInteger).slice(-50) : [],
          receipts: Array.isArray(entry.receipts) ? entry.receipts.filter(value => Number.isSafeInteger(value?.index) && value.index >= 0 && value.index < entry.sourceFileCount && Number.isSafeInteger(value.botId) &&
            typeof value.fileId === "string" && value.fileId.length > 0 && value.fileId.length <= 1024).slice(0, maxPublicationItems) : [],
          manifest: Array.isArray(entry.manifest) ? entry.manifest.slice(0, maxPublicationItems).map(file => ({ index: file.index, sourceItemId: file.sourceItemId, mediaKind: file.mediaKind,
            mimeType: file.mimeType, title: String(file.title || "").slice(0, 1000), size: file.size, width: file.width, height: file.height,
            duration: file.duration, hasAudio: file.hasAudio })) : [],
          bindings: Array.isArray(entry.bindings) ? retainMediaBindings(entry.bindings.filter(binding => Number.isSafeInteger(binding?.messageId) && binding.messageId > 0 &&
            Number.isSafeInteger(binding.index) && binding.index >= 0 && binding.index < Math.min(maxPublicationItems, entry.sourceFileCount))) : [],
          files: entry.files.filter(file => file && safeName.test(file.name)).slice(0, maxPublicationItems)
            .map(file => ({ ...file, index: Number.parseInt(file.name, 10) - 1 })) })) };
    } catch (error) { if (error.code === "ENOENT") return { version: 1, entries: [] }; throw error; }
  }

  async trim(state) {
    const retained = [];
    for (const entry of state.entries) {
      const directory = path.join(this.directory, entry.id);
      const stat = await fs.lstat(directory).catch(() => null);
      const pendingExpired = entry.pending && this.now() - (entry.pendingSince ?? entry.createdAt) >= this.ttlMs;
      const localExpired = this.now() - entry.createdAt >= this.ttlMs && !entry.pending;
      const receiptExpired = this.now() - entry.createdAt >= this.receiptTtlMs || !hasReusableReceipts(entry);
      if (pendingExpired || (localExpired && receiptExpired) || stat?.isSymbolicLink() || (stat && !stat.isDirectory())) { await this.removeEntry(entry.id); continue; }
      if (localExpired) { await this.removeEntry(entry.id); entry.files = []; }
      const available = [];
      for (const file of entry.files) {
        const filePath = path.join(directory, file.name), current = await fs.lstat(filePath).catch(() => null);
        if (current?.isFile() && !current.isSymbolicLink() && current.size <= this.maxFileBytes) available.push({ ...file, size: current.size });
        else if (current && !current.isDirectory()) await fs.unlink(filePath);
      }
      entry.files = available;
      if (available.length || entry.receipts?.length) retained.push(entry);
      else await this.removeEntry(entry.id);
    }
    retained.sort((a, b) => a.createdAt - b.createdAt);
    let bytes = retained.reduce((sum, entry) => sum + entry.files.reduce((n, file) => n + file.size, 0), 0);
    while (retained.length > this.maxEntries || bytes > this.maxTotalBytes) {
      const index = retained.findIndex(entry => !entry.pending && (retained.length > this.maxEntries || entry.files.length));
      if (index < 0) throw capacityError();
      const removed = retained[index];
      bytes -= removed.files.reduce((sum, file) => sum + file.size, 0);
      await this.removeEntry(removed.id);
      if (retained.length > this.maxEntries || !removed.receipts?.length) retained.splice(index, 1);
      else removed.files = [];
    }
    state.entries = retained;
    // Recover disk bounds after a process crash between copying and index commit.
    const owned = new Set(retained.map(entry => entry.id));
    for (const name of await fs.readdir(this.directory)) if (safeId.test(name) && !owned.has(name)) await this.removeEntry(name);
  }

  async removeEntry(id) {
    if (!safeId.test(id)) return;
    const target = path.join(this.directory, id);
    const stat = await fs.lstat(target).catch(() => null);
    if (stat?.isSymbolicLink()) await fs.unlink(target);
    else if (stat?.isDirectory()) await fs.rm(target, { recursive: true, force: true });
  }

  async write(state) {
    let serialized = JSON.stringify(state);
    // Retained metadata has a byte bound too. Every mutation must produce an
    // index the reader accepts; pending recovery may never be evicted to fit it.
    while (Buffer.byteLength(serialized) > maxIndexBytes) {
      const oldest = state.entries.filter(entry => !entry.pending).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!oldest) throw capacityError();
      await this.removeEntry(oldest.id);
      state.entries = state.entries.filter(entry => entry.id !== oldest.id);
      serialized = JSON.stringify(state);
    }
    const temporary = path.join(this.directory, `index-${randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, serialized, { mode: 0o600, flag: "wx" }); await fs.rename(temporary, this.index); }
    finally { await fs.rm(temporary, { force: true }); }
  }

  expose(entry) {
    return { ...entry, complete: entry.files.length === entry.sourceFileCount, selection: "publication",
      files: entry.files.map(({ name, ...file }) => ({ ...file, filePath: path.join(this.directory, entry.id, name) })) };
  }
}

function capacityError() {
  return Object.assign(new Error("Prepared media cache is reserved by unfinished deliveries"), { code: "MEDIA_CACHE_CAPACITY" });
}

function retainMediaBindings(bindings) {
  // Keep the first Telegram message for each slide for the life of this cache
  // entry, plus the existing recent-message window for retries and repeats.
  const first = new Set();
  return bindings.filter((binding, position) => {
    const original = !first.has(binding.index);
    first.add(binding.index);
    return original || position >= bindings.length - 50;
  });
}

function reusablePublication(entry, sourceUrl) {
  // TikTok shares a native ID between /video and /photo permalinks. A
  // rendered slideshow from the video path cannot supply the original slides.
  if (mediaReference(sourceUrl)?.kind === "photo" && !isTikTokPhotoSet(entry.source, entry.manifest)) return false;
  if (entry.orderedMediaVersion === 1) return true;
  // Before ordered selection, a cached prefix, duplicate collapse or video
  // poster could look complete. Exact message/recovery lookups retain it.
  if (entry.source?.provider === "threads-page" || entry.source?.resolved?.kind === "photo") return false;
  if (entry.source?.provider === "tiktok-api") return entry.sourceFileCount === 1 && entry.manifest?.[0]?.mediaKind === "video";
  if (entry.source?.provider === "instaloader") {
    // Old adapters could return a prefix of any length, including one slide.
    // Only the native single-item marker proves that the publication itself
    // was the sole original item. A hash or a missing child ID cannot do so.
    const id = entry.source.resolved?.id;
    return Boolean(id && entry.sourceFileCount === 1 && entry.manifest?.length === 1 &&
      entry.manifest[0].sourceItemId === `publication:${id}`);
  }
  return true;
}

function hasReusableReceipts(entry) {
  if (entry.pending || entry.manifest?.length !== entry.sourceFileCount || !hasMediaItemIdentity(entry.manifest)) return false;
  try { assertVerifiedMediaSource(entry.source, entry.source?.requested?.url); } catch { return false; }
  const botId = entry.receipts?.[0]?.botId;
  return Number.isSafeInteger(botId) && entry.manifest.every((item, index) => item.index === index &&
    entry.receipts.some(receipt => receipt.index === index && receipt.botId === botId));
}
