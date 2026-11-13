import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const safeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const safeName = /^\d{1,2}\.[a-z0-9]{1,6}$/;

export class MediaCache {
  constructor(directory, { ttlMs = 48 * 3600000, maxTotalBytes = 256 * 1024 * 1024,
    maxFileBytes = 48 * 1024 * 1024, maxEntries = 300, now = Date.now } = {}) {
    this.directory = path.resolve(directory);
    Object.assign(this, { ttlMs, maxTotalBytes, maxFileBytes, maxEntries, now });
    this.index = path.join(this.directory, "index.json");
    this.queue = Promise.resolve();
  }

  async put({ chatId, topicId = null, sourceMessageId, sourceUrl = "", source = null, files = [] }) {
    return this.lock(async () => {
      const state = await this.read();
      await this.trim(state);
      const id = randomUUID(), destination = path.join(this.directory, id);
      const entry = { id, chatId, topicId, sourceMessageId, sourceUrl: String(sourceUrl).slice(0, 4096),
        source, sentMessageIds: [], bindings: [], createdAt: this.now(), files: [], sourceFileCount: files.length };
      await fs.mkdir(destination, { mode: 0o700 });
      try {
        let bytes = 0;
        for (const [index, file] of files.slice(0, 20).entries()) {
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
          entry.files.push({ name, index, mediaKind: file.mediaKind, mimeType: file.mimeType,
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

  async bind(entryId, sentMessageIds, { startIndex = 0 } = {}) {
    return this.lock(async () => {
      const state = await this.read();
      await this.trim(state);
      const entry = state.entries.find(item => item.id === entryId);
      if (entry) {
        entry.sentMessageIds = [...new Set([...entry.sentMessageIds, ...sentMessageIds.filter(Number.isSafeInteger)])].slice(-50);
        for (const [offset, messageId] of sentMessageIds.entries()) {
          const index = startIndex + offset;
          if (!Number.isSafeInteger(messageId) || messageId <= 0 || !entry.files.some(file => file.index === index)) continue;
          entry.bindings = [...entry.bindings.filter(binding => binding.messageId !== messageId), { messageId, index }].slice(-50);
        }
      }
      await this.write(state);
      return entry ? this.expose(entry) : null;
    });
  }

  async get({ chatId, topicId = null, messageId, wholePublication = false }) {
    return this.lock(async () => {
      const state = await this.read();
      await this.trim(state);
      const entry = state.entries.slice().reverse().find(item => String(item.chatId) === String(chatId)
        && item.topicId === topicId && (item.sourceMessageId === messageId || item.sentMessageIds.includes(messageId)));
      await this.write(state);
      if (!entry) return null;
      if (messageId === entry.sourceMessageId || wholePublication) return this.expose(entry);
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
      if (!indexStat.isFile() || indexStat.isSymbolicLink() || indexStat.size > 4 * 1024 * 1024) throw new Error("Invalid media cache index file");
      const state = JSON.parse(await fs.readFile(this.index, "utf8"));
      if (state.version !== 1 || !Array.isArray(state.entries)) throw new Error("Invalid media cache index");
      return { version: 1, entries: state.entries.filter(entry => entry && safeId.test(entry.id)
        && Number.isFinite(entry.createdAt) && Array.isArray(entry.files)).map(entry => ({ ...entry,
          topicId: entry.topicId ?? null, sentMessageIds: Array.isArray(entry.sentMessageIds) ? entry.sentMessageIds.filter(Number.isSafeInteger).slice(-50) : [],
          bindings: Array.isArray(entry.bindings) ? entry.bindings.filter(binding => Number.isSafeInteger(binding?.messageId) && binding.messageId > 0 && Number.isSafeInteger(binding.index) && binding.index >= 0 && binding.index < entry.sourceFileCount).slice(-50) : [],
          files: entry.files.filter(file => file && safeName.test(file.name)).slice(0, 20)
            .map(file => ({ ...file, index: Number.parseInt(file.name, 10) - 1 })) })) };
    } catch (error) { if (error.code === "ENOENT") return { version: 1, entries: [] }; throw error; }
  }

  async trim(state) {
    const retained = [];
    for (const entry of state.entries) {
      const directory = path.join(this.directory, entry.id);
      const stat = await fs.lstat(directory).catch(() => null);
      if (this.now() - entry.createdAt >= this.ttlMs || !stat?.isDirectory() || stat.isSymbolicLink()) { await this.removeEntry(entry.id); continue; }
      const available = [];
      for (const file of entry.files) {
        const filePath = path.join(directory, file.name), current = await fs.lstat(filePath).catch(() => null);
        if (current?.isFile() && !current.isSymbolicLink() && current.size <= this.maxFileBytes) available.push({ ...file, size: current.size });
        else if (current && !current.isDirectory()) await fs.unlink(filePath);
      }
      entry.files = available;
      if (available.length) retained.push(entry);
      else await this.removeEntry(entry.id);
    }
    retained.sort((a, b) => a.createdAt - b.createdAt);
    let bytes = retained.reduce((sum, entry) => sum + entry.files.reduce((n, file) => n + file.size, 0), 0);
    while (retained.length > this.maxEntries || bytes > this.maxTotalBytes) {
      const removed = retained.shift();
      bytes -= removed.files.reduce((sum, file) => sum + file.size, 0);
      await this.removeEntry(removed.id);
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
    const temporary = path.join(this.directory, `index-${randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" }); await fs.rename(temporary, this.index); }
    finally { await fs.rm(temporary, { force: true }); }
  }

  expose(entry) {
    return { ...entry, complete: entry.files.length === entry.sourceFileCount, selection: "publication",
      files: entry.files.map(({ name, ...file }) => ({ ...file, filePath: path.join(this.directory, entry.id, name) })) };
  }
}
