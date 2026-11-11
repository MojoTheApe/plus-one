import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const activeMember = (member) => ["creator", "administrator", "member"].includes(member.status) || (member.status === "restricted" && member.is_member === true);

export class MemberRoster {
  constructor({ stateFile, telegram }) { Object.assign(this, { stateFile, telegram }); this.state = null; }

  async load() {
    if (this.state) return;
    try {
      const state = JSON.parse(await fs.readFile(this.stateFile, "utf8"));
      if (!state || !state.chats || Array.isArray(state.chats) || typeof state.chats !== "object") throw new Error("Invalid member roster");
      for (const chat of Object.values(state.chats)) {
        if (!chat.users || typeof chat.users !== "object" || Array.isArray(chat.users)) throw new Error("Invalid member roster users");
        for (const [key, entry] of Object.entries(chat.users)) {
          const user = entry.user;
          if (typeof entry.active !== "boolean" || !user || typeof user.is_bot !== "boolean" || (user.id != null && (!Number.isSafeInteger(user.id) || user.id <= 0)) || (user.username && !/^[A-Za-z0-9_]{5,32}$/.test(user.username)) || (!user.id && !user.username)) throw new Error("Invalid roster member");
          if (key !== (user.id ? String(user.id) : "name:" + user.username.toLowerCase())) throw new Error("Invalid roster identity key");
        }
      }
      this.state = state;
    } catch (error) { if (error.code !== "ENOENT") throw error; this.state = { chats: {} }; }
  }

  async save() {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const tmp = this.stateFile + "." + randomUUID() + ".tmp";
    try { await fs.writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 }); await fs.rename(tmp, this.stateFile); }
    finally { await fs.rm(tmp, { force: true }); }
  }

  upsert(chatId, user, active) {
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return false;
    const chat = this.state.chats[String(chatId)] ||= { users: {} };
    // Convert a UI-verified username seed to the real ID when Telegram supplies it.
    for (const [key, entry] of Object.entries(chat.users)) if (!entry.user.id && user.username && entry.user.username?.toLowerCase() === user.username.toLowerCase()) delete chat.users[key];
    const entry = { user: { id: user.id, is_bot: Boolean(user.is_bot), first_name: String(user.first_name || "Учасник").slice(0, 80), ...(user.last_name ? { last_name: String(user.last_name).slice(0, 80) } : {}), ...(user.username ? { username: user.username } : {}) }, active };
    if (JSON.stringify(chat.users[user.id]) === JSON.stringify(entry)) return false;
    chat.users[user.id] = entry;
    return true;
  }

  async observe(update) {
    const member = update.chat_member;
    const message = update.message;
    const chat = member?.chat || message?.chat;
    if (!chat || !["group", "supergroup"].includes(chat.type)) return;
    await this.load();
    let changed = false;
    if (member) changed = this.upsert(chat.id, member.new_chat_member.user, activeMember(member.new_chat_member));
    else {
      if (!message.sender_chat) changed = this.upsert(chat.id, message.from, true) || changed;
      for (const user of message.new_chat_members || []) changed = this.upsert(chat.id, user, true) || changed;
      if (message.left_chat_member) changed = this.upsert(chat.id, message.left_chat_member, false) || changed;
    }
    if (changed) await this.save();
  }

  async all(chat, bot) {
    await this.load();
    this.upsert(chat.id, bot, true);
    const record = this.state.chats[String(chat.id)];
    const entries = Object.values(record.users);
    for (let offset = 0; offset < entries.length; offset += 5) {
      await Promise.all(entries.slice(offset, offset + 5).filter((e) => e.user.id).map(async (entry) => {
        const current = await this.telegram("getChatMember", { chat_id: chat.id, user_id: entry.user.id });
        this.upsert(chat.id, current.user, activeMember(current));
      }));
    }
    const count = await this.telegram("getChatMemberCount", { chat_id: chat.id });
    const active = Object.values(record.users).filter((e) => e.active);
    // No API can enumerate missing existing members. Never silently call a partial roster "all".
    if (active.length !== count || active.some((e) => !e.user.id && !record.verifiedSnapshot)) {
      await this.save();
      throw new Error("The complete group roster is not configured");
    }
    record.verifiedAt = new Date().toISOString();
    await this.save();
    return active.filter((e) => !e.user.is_bot).map((e) => e.user);
  }
}

export function mentionChunks(title, users, limit = 950) {
  const chunks = [];
  let text = title + "\n", entities = [];
  for (const user of users) {
    const label = user.username ? "@" + user.username : [user.first_name, user.last_name].filter(Boolean).join(" ").replace(/[\r\n]+/g, " ").slice(0, 80) || "Учасник";
    if (text.length + label.length + 1 > limit && entities.length) { chunks.push({ text: text.trimEnd(), entities }); text = ""; entities = []; }
    entities.push({ type: user.username ? "mention" : "text_mention", offset: text.length, length: label.length, ...(!user.username ? { user: { id: user.id, is_bot: false, first_name: user.first_name || "Учасник" } } : {}) });
    text += label + " ";
  }
  chunks.push({ text: text.trimEnd(), entities });
  return chunks;
}
