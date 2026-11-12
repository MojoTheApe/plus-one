import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { parseBotCommandText } from "./helpers.js";

const none = () => ({ action: "none", game: null });
const normalize = (text) => String(text || "").normalize("NFKC").trim().toLowerCase();

export const assembleForumThread = (message) => (message?.chat?.is_forum || message?.is_topic_message) ? (message.message_thread_id || null) : null;

export function actionableAssembleText(message, fallback) {
  const original = message.text ?? message.caption;
  if (typeof original !== "string") return String(fallback || "").trim();
  const entities = message.text != null ? message.entities : message.caption_entities;
  let current = original;
  // Telegram entity offsets use UTF-16, just like String.slice. Mask spans without moving offsets.
  for (const entity of entities || []) {
    if (!["blockquote", "expandable_blockquote", "pre", "code"].includes(entity.type) || !Number.isSafeInteger(entity.offset) || !Number.isSafeInteger(entity.length) || entity.offset < 0 || entity.length <= 0) continue;
    const end = Math.min(original.length, entity.offset + entity.length);
    if (entity.offset >= end) continue;
    current = current.slice(0, entity.offset) + " ".repeat(end - entity.offset) + current.slice(end);
  }
  return [current.trim(), String(message._voiceTranscript || "").trim()].filter(Boolean).join("\n");
}

export function normalizeGamePlayers(players, id) {
  if (!Array.isArray(players) || !players.length || players.some(player => typeof player !== "string" || !/^@?[A-Za-z0-9_]{5,32}$/.test(player))) {
    throw new Error("Invalid assemble players: " + id);
  }
  const seen = new Set();
  return players.map(player => player.replace(/^@/, "")).filter(player => {
    const key = player.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validateGames(games) {
  const ids = ["fortnite", "rocket-league", "arc-riders", "helldivers-2"];
  if (!Array.isArray(games) || games.length !== ids.length) throw new Error("Invalid assemble game configuration");
  return ids.map((id) => {
    const matches = games.filter((g) => g.id === id);
    const game = matches[0];
    if (matches.length !== 1 || typeof game.name !== "string" || !game.name || !Array.isArray(game.aliases) || !game.aliases.length || game.aliases.some((a) => typeof a !== "string" || !a.trim())) throw new Error("Invalid assemble game: " + id);
    if (game.media != null && ![id + ".gif", id + ".mp4"].includes(game.media)) throw new Error("Invalid assemble media: " + id);
    if (!Array.isArray(game.players)) throw new Error("Invalid assemble players: " + id);
    return { ...game, players: game.players.length ? normalizeGamePlayers(game.players, id) : [] };
  });
}

export function isAssembleCandidate(text, acceptRussian = false, games = []) {
  const value = normalize(text);
  if (!value || value.length > 4096 || value.split(/\s+/u).length > 700 || value.startsWith("/")) return false;
  if (games.some(game => [game.name, game.commandName, ...(game.aliases ?? [])].filter(Boolean).some(name => value.includes(normalize(name))))) return true;
  const tokens = value.match(/[\p{L}\p{N}]+/gu) || [];
  if (acceptRussian && tokens.some(token => /^(?:собер[иём]|созов[иём]|играть|поигра\p{L}*)$/u.test(token))) return true;
  return tokens.some((t) => /^(?:fort\p{L}*|форт\p{L}*|rocket\p{L}*|рокет\p{L}*|ракет\p{L}*|rl|рл|fn|arc|ark|арк\p{L}*|арочк\p{L}*|raiders|riders|рейдер\p{L}*|райдер\p{L}*|helldiver\p{L}*|hell|хел+дайвер\p{L}*|дайвер\p{L}*|демократ\p{L}*|жук\p{L}*|жуків|жучк\p{L}*|hd|hd2|хв|хд|хд2|all|everyone|everybody|announcement\p{L}*|увага|всі|всіх|всім|всех|всем|усі|усіх|усім|оголошенн\p{L}*|объявлен\p{L}*|тег\p{L}*|пінг\p{L}*|зібр\p{L}*|збер\p{L}*)$/u.test(t)) ||
    tokens.some((t) => /^(?:go|play|game|games|gaming|join|assemble|squad|gather|ping|invite|tag|го|збір|збира\p{L}*|катн\p{L}*|ката\p{L}*|катк\p{L}*|каток|каточ\p{L}*|покат\p{L}*|погра\p{L}*|зігра\p{L}*|грати|граємо|грат\p{L}*|сыгра\p{L}*|позов\p{L}*|поклич\p{L}*|клич\p{L}*|скли\p{L}*)$/u.test(t));
}

export function parseAssembleIntent(text, games, acceptRussian = false) {
  let result;
  try { result = JSON.parse(text); } catch { return none(); }
  if (!result || Array.isArray(result) || Object.keys(result).sort().join(",") !== "action,confident,game,language" || result.confident !== true) return none();
  if (!["ukrainian", "english", "mixed", "ambiguous"].includes(result.language) &&
      !(acceptRussian && result.language === "russian")) return none();
  if (result.action === "call" && games.some((g) => g.id === result.game)) return { action: "call", game: result.game };
  if (result.action === "choose" && result.game === null) return { action: "choose", game: null };
  if (result.action === "global" && result.game === null) return { action: "global", game: null };
  return none();
}

export class AssembleRouter {
  constructor({ games, classify, stateFile, sendCall, sendGlobal, sendMenu, sendNotice, answerCallback, clearMenu, canChoose, getContext = async () => ({}), now = Date.now, cooldownMs = 60000, acceptRussian = false, getGroupAssembly, chooseOnCommand = false }) {
    this.games = validateGames(games);
    if (typeof canChoose !== "function") throw new Error("Missing game-picker membership check");
    Object.assign(this, { classify, stateFile, sendCall, sendGlobal, sendMenu, sendNotice, answerCallback, clearMenu, canChoose, getContext, now, cooldownMs, acceptRussian, getGroupAssembly, chooseOnCommand });
    this.state = null;
  }

  async load() {
    if (this.state) return;
    try {
      const state = JSON.parse(await fs.readFile(this.stateFile, "utf8"));
      if (!state || typeof state.calls !== "object" || !state.calls || Array.isArray(state.calls) || typeof state.menus !== "object" || !state.menus || Array.isArray(state.menus) || Object.values(state.calls).some((n) => !Number.isFinite(n))) throw new Error("Invalid assemble state");
      if (Object.entries(state.menus).some(([token, m]) => !/^[a-f0-9]{24}$/.test(token) || !m || !Number.isSafeInteger(m.chatId) || !Number.isSafeInteger(m.userId) || !Number.isSafeInteger(m.messageId) || !Number.isFinite(m.expiresAt) || (m.threadId !== null && !Number.isSafeInteger(m.threadId)) || (m.menuMessageId != null && (!Number.isSafeInteger(m.menuMessageId) || m.menuMessageId <= 0)))) throw new Error("Invalid assemble menus");
      this.state = state;
    } catch (error) { if (error.code !== "ENOENT") throw error; this.state = { calls: {}, menus: {} }; }
  }

  async save() {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const tmp = this.stateFile + "." + randomUUID() + ".tmp";
    try { await fs.writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 }); await fs.rename(tmp, this.stateFile); }
    finally { await fs.rm(tmp, { force: true }); }
  }

  assemblyForChat(chatId) {
    if (this.getGroupAssembly) return this.getGroupAssembly(chatId);
    const games = this.games.filter(game => game.players.length);
    return games.length ? { games } : undefined;
  }

  async handleMessage(message, username, text, acceptRussian = this.acceptRussian) {
    if (message.forward_origin || message.forward_date || message.forward_from || message.via_bot) return false;
    const value = actionableAssembleText(message, text);
    if (!value) return false;
    const command = parseBotCommandText(value, username) || /^assemble(?:\s+([\s\S]+))?$/iu.exec(value);
    const assembly = this.assemblyForChat(message.chat.id);
    if (command && (!command.name || command.name === "assemble") && !assembly) {
      await this.sendNotice(message, "Збір не налаштовано для цього чату.");
      return true;
    }
    const games = assembly?.games ?? [];
    const gameOptions = this.getGroupAssembly ? { availableGames: games.map(({ id, name, commandName, aliases }) => ({ id, name, commandName, aliases })) } : {};
    let intent, menuToken = null;
    if (command) {
      if (command.name && command.name !== "assemble") return false;
      if (!assembly) {
        await this.sendNotice(message, "Збір не налаштовано для цього чату.");
        return true;
      }
      const arg = normalize(command.args ?? command[1]);
      const matches = game => [game.id, game.name, game.commandName, ...(game.aliases ?? [])].filter(Boolean).some(alias => normalize(alias) === arg);
      const game = games.find(matches);
      if (!arg) {
        // Removing a quoted game argument must never turn a longer message into a global call.
        if (normalize(text) !== normalize(value)) return false;
        intent = { action: this.chooseOnCommand ? "choose" : "global", game: null };
      }
      else if (game) intent = { action: "call", game: game.id };
      else if (this.getGroupAssembly && this.games.some(matches)) {
        await this.sendNotice(message, "Цю гру не налаштовано для цього чату.");
        return true;
      } else intent = parseAssembleIntent(await this.classify(JSON.stringify({ message: "Assemble " + arg, quotedReply: "", ...gameOptions })), games, acceptRussian);
    } else {
      if (!assembly) return false;
      // This broad, bounded prefilter only avoids classifying unrelated chat. AI decides intent.
      const otherMentions = (value.match(/@[A-Za-z0-9_]{5,32}/g) || []).filter((m) => m.slice(1).toLowerCase() !== username.toLowerCase());
      if (otherMentions.length || !isAssembleCandidate(value, acceptRussian, games)) return false;
      const reply = (message.reply_to_message?.text || message.reply_to_message?.caption || "").slice(0, 400);
      const ownMention = new RegExp("@" + username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "ig");
      const context = await this.getContext(message);
      await this.load();
      const references = new Set([message.reply_to_message?.message_id, ...(context.replyChain || []).map(item => item.messageId)]);
      const menu = Object.entries(this.state.menus).find(([, item]) => item.chatId === message.chat.id &&
        item.threadId === assembleForumThread(message) && item.expiresAt > this.now() &&
        (references.has(item.menuMessageId) || references.has(item.messageId)));
      const selectedGame = menu && games.find(game => [game.id, game.name, game.commandName, ...(game.aliases ?? [])].filter(Boolean).some(alias => normalize(alias) === normalize(value)));
      if (selectedGame && await this.canChoose(message.chat.id, message.from.id)) {
        menuToken = menu[0];
        intent = { action: "call", game: selectedGame.id };
      } else {
        const result = await this.classify(JSON.stringify({ message: value.replace(ownMention, "").trim(), quotedReply: reply,
          ...context, ...gameOptions, pendingMenu: menu ? { messageId: menu[1].messageId, games: games.map(game => ({id:game.id,name:game.name})) } : null }));
        intent = parseAssembleIntent(result, games, acceptRussian);
        if (menu && intent.action === "call") menuToken = menu[0];
      }
    }
    if (intent.action === "none") return false;
    if (!["group", "supergroup"].includes(message.chat.type)) {
      await this.sendNotice(message, "Збір гравців працює в групі.");
      return true;
    }
    await this.load();
    if (intent.action === "choose") {
      if (games.length) await this.menu(message, games);
      else await this.sendNotice(message, "Для цього чату ще не налаштовано жодної гри.");
    } else {
      const id = intent.action === "global" ? "global" : intent.game;
      const wait = await this.call(message, id, menuToken);
      if (wait) await this.sendNotice(message, `Цей збір уже був. Повторний виклик через ${wait} с.`);
    }
    return true;
  }

  async menu(message, games) {
    const now = this.now();
    for (const [token, menu] of Object.entries(this.state.menus)) if (menu.expiresAt <= now) delete this.state.menus[token];
    for (const key of Object.keys(this.state.calls)) if (this.state.calls[key] + this.cooldownMs <= now) delete this.state.calls[key];
    const keys = Object.keys(this.state.menus);
    if (keys.length >= 200) delete this.state.menus[keys[0]];
    const token = randomBytes(12).toString("hex");
    const sent = await this.sendMenu(message, token, games);
    if (!Number.isSafeInteger(sent?.message_id) || sent.message_id <= 0) throw new Error("Game picker delivery did not return a message ID");
    this.state.menus[token] = { chatId: message.chat.id, userId: message.from.id, messageId: message.message_id, menuMessageId: sent.message_id, threadId: assembleForumThread(message), expiresAt: this.now() + 300000 };
    await this.save();
  }

  async call(message, gameId, consumedToken = null) {
    const assembly = this.assemblyForChat(message.chat.id);
    const game = assembly?.games.find(item => item.id === gameId);
    if (!assembly || (gameId !== "global" && !game)) return null;
    const key = `${message.chat.id}:${gameId}`;
    const wait = Math.ceil(((this.state.calls[key] ?? -Infinity) + this.cooldownMs - this.now()) / 1000);
    if (wait > 0) return wait;
    if (gameId === "global") await this.sendGlobal(message, assembly);
    else await this.sendCall(message, game);
    this.state.calls[key] = this.now();
    if (consumedToken) delete this.state.menus[consumedToken];
    await this.save();
    return 0;
  }

  async handleCallback(query) {
    if (!String(query.data || "").startsWith("assemble:")) return false;
    if (!query.from || query.from.is_bot) return true;
    const match = /^assemble:([a-f0-9]{24}):([A-Za-z0-9_-]{1,24})$/.exec(query.data);
    await this.load();
    const menu = match && this.state.menus[match[1]];
    const forum = Boolean(query.message?.chat?.is_forum || query.message?.is_topic_message);
    const correctMessage = menu && (menu.menuMessageId ? query.message?.message_id === menu.menuMessageId : query.message?.reply_to_message?.message_id === menu.messageId);
    if (!menu || menu.expiresAt <= this.now() || menu.chatId !== query.message?.chat?.id || !correctMessage || (forum && (menu.threadId || null) !== assembleForumThread(query.message))) {
      await this.answerCallback(query.id, "Цей вибір уже неактивний. Відкрий новий список: /assemble.");
      return true;
    }
    if (!this.assemblyForChat(menu.chatId)?.games.some(game => game.id === match[2])) {
      await this.answerCallback(query.id, "Цю гру не налаштовано для цього чату.");
      return true;
    }
    let member;
    try { member = await this.canChoose(menu.chatId, query.from.id); }
    catch { await this.answerCallback(query.id, "Не вдалося перевірити участь у чаті. Спробуй ще раз."); return true; }
    if (!member) {
      await this.answerCallback(query.id, "Обрати гру можуть учасники цього чату.");
      return true;
    }
    await this.answerCallback(query.id, "");
    const message = { chat: query.message.chat, from: query.from, message_id: menu.messageId, ...(forum && menu.threadId ? { message_thread_id: menu.threadId, is_topic_message: true } : {}) };
    const wait = await this.call(message, match[2], match[1]);
    if (wait) await this.sendNotice(message, `Повторний збір у цю гру через ${wait} с.`);
    else {
      await this.clearMenu(query.message).catch(() => {});
    }
    return true;
  }
}
