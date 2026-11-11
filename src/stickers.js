import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { actionableAssembleText } from "./assemble.js";
import { parseBotCommandText } from "./helpers.js";

const noun = /(?:ст[іи]кер|sticker|\bpack\b|(?:^|[^\p{L}])пак(?:у|а)?(?:$|[^\p{L}]))/iu;
const wholePack = /(?:^|[^\p{L}])(?:весь|все|всі|усі|цілий|whole|entire|all)\s+(?:(?:the|our|наші|ці|эти)\s+)?(?:(?:ст[іи]кер\p{L}*|stickers?)\s*[- ]?\s*(?:пак\p{L}*|pack)|(?:пак\p{L}*|pack|ст[іи]кер\p{L}*|stickers?))/iu;
const deletePack = /^(?:удали|удалить|видали|видалити|прибери|remove|delete)\s+(?:(?:цей|наш|этот|this|our|the)\s+)?(?:ст[іи]керпак\p{L}*|sticker\s+pack|пак\p{L}*|pack)(?:$|[\s?!.,])/iu;
const mutationRequest = /^(?:(?:не|як|как|how|чи|можна|don't|do not)(?:\s|[,!:])[^\n]{0,80}?)?(?:додай|додати|додавай|добав\p{L}*|удал\p{L}*|видал\p{L}*|прибери|прибрати|add|adding|delete|deleting|remove|removing)(?:$|[\s?!.,])/iu;
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const isStickerPackText = (text) => noun.test(String(text || "").normalize("NFKC").replace(/@[A-Za-z0-9_]+/g, ""));

export function stickerIntent(message, bot, aliasPrefix) {
  if (message.forward_origin || message.forward_date || message.forward_from || message.via_bot) return null;
  const raw = message.text ?? message.caption ?? "";
  const text = actionableAssembleText(message, raw).normalize("NFKC").trim();
  if (!text || text.length > 4096) return null;
  const command = parseBotCommandText(text, bot.username);
  if (command) {
    const action = { stickeradd: "add", stickerdel: "delete", stickers: "help" }[command.name];
    return action ? { action: action !== "help" && wholePack.test(command.args) ? "unsupported" : action, text: command.args } : null;
  }
  if (text.startsWith("/")) return null;
  const mention = new RegExp(`@${escape(bot.username)}\\b`, "iu");
  const named = aliasPrefix || /^(?:бот|bot)[,:\s]+/iu;
  if (!mention.test(text) && !named.test(text) && message.reply_to_message?.from?.id !== bot.id) return null;
  const value = text.replace(new RegExp(`@${escape(bot.username)}\\b`, "giu"), "")
    .replace(named, "")
    .replace(/^[\s,:]+/u, "")
    .replace(/^(?:пожалуйста|будь ласка|please)[,:\s]+/iu, "")
    .replace(/^(?:можешь|можеш|can you|could you)[,:\s]+/iu, "")
    .replace(/^(?:пожалуйста|будь ласка|please)[,:\s]+/iu, "");
  if (!isStickerPackText(value)) return null;
  if (!mutationRequest.test(value)) return null;
  if (wholePack.test(value) || deletePack.test(value)) return { action: "unsupported", text: value };
  if (/^(?:добавь|добави|додай|додати|добавить|add)(?:\s|[,!:])/iu.test(value)) return { action: "add", text: value };
  if (/^(?:удали|удалить|видали|видалити|прибери|remove|delete)(?:\s|[,!:])/iu.test(value)) return { action: "delete", text: value };
  // Unsupported mutation requests must not fall through into user moderation.
  return { action: "unsupported", text: value };
}

export function stickerMedia(message) {
  const image = (m) => m?.sticker ? { kind: "sticker", ...m.sticker } :
    m?.photo?.length ? { kind: "image", ...m.photo.at(-1) } :
    m?.document?.file_id && /^image\/(?:jpeg|png|webp)$/i.test(m.document.mime_type || "") ? { kind: "image", ...m.document } : null;
  return image(message) || image(message.reply_to_message);
}

function emojiFrom(text, fallback = "😂") {
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text || "")) {
    if (/\p{Extended_Pictographic}/u.test(segment)) return segment;
  }
  return fallback;
}

export function validateStickerBinding(chatId, item) {
  if (!/^-\d+$/.test(chatId) || !item || !Number.isSafeInteger(item.ownerId) || item.ownerId <= 0 ||
      typeof item.packName !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(item.packName)) {
    throw new Error("Invalid sticker binding");
  }
}

export class StickerRouter {
  constructor({ bindingsFile, configuredBindings, stateFile, telegram, telegramMultipart, prepareImage, aliasPrefix, log = () => {} }) {
    Object.assign(this, { bindingsFile, configuredBindings, stateFile, telegram, telegramMultipart, prepareImage, aliasPrefix, log });
    this.queue = Promise.resolve();
  }

  async bindings() {
    if (typeof this.configuredBindings === "function") return this.configuredBindings();
    if (this.configuredBindings) return this.configuredBindings;
    let bindings;
    try { bindings = JSON.parse(await fs.readFile(this.bindingsFile, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
    if (bindings.version !== 1 || !bindings.chats || Array.isArray(bindings.chats)) throw new Error("Invalid sticker bindings");
    for (const [chatId, item] of Object.entries(bindings.chats)) validateStickerBinding(chatId, item);
    return bindings.chats;
  }

  async loadState() {
    try {
      const state = JSON.parse(await fs.readFile(this.stateFile, "utf8"));
      if (state.version !== 1 || !state.jobs || Array.isArray(state.jobs) || typeof state.jobs !== "object") throw new Error("Invalid sticker action state");
      return state;
    } catch (error) { if (error.code !== "ENOENT") throw error; return { version: 1, jobs: {} }; }
  }

  async saveState(state) {
    // Keep pending mutations for recovery. Bound completed history per service.
    const completed = Object.entries(state.jobs).filter(([, job]) => job.status === "done").sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    for (const [key] of completed.slice(2000)) delete state.jobs[key];
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await fs.rename(temporary, this.stateFile); }
    finally { await fs.rm(temporary, { force: true }); }
  }

  async reply(message, text) {
    await this.telegram("sendMessage", { chat_id: message.chat.id, text, reply_to_message_id: message.message_id,
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}), disable_web_page_preview: true });
  }

  async handleMessage(message, bot, aliasPrefix = this.aliasPrefix) {
    const intent = stickerIntent(message, bot, aliasPrefix);
    if (!intent) return false;
    const run = this.queue.then(() => this.process(message, bot, intent));
    this.queue = run.catch(() => {});
    try { await run; }
    catch (error) {
      this.log("sticker_action_failed", error, { chat: message.chat.id, messageId: message.message_id, action: intent.action });
      await this.reply(message, "Не вдалося змінити стікерпак. Перевір права бота й спробуй ще раз.").catch(() => {});
    }
    return true;
  }

  async process(message, bot, intent) {
    if (intent.action === "unsupported") {
      await this.reply(message, "Працюю з окремими стікерами: відповідай на зображення з /stickeradd або на стікер із нашого пака з /stickerdel. Змінювати чи видаляти весь пак цими командами не можна."); return;
    }
    if (!["group", "supergroup"].includes(message.chat.type)) {
      await this.reply(message, "Керування стікерами працює в групі, до якої прив'язаний пак."); return;
    }
    const binding = (await this.bindings())[String(message.chat.id)];
    if (!binding) { await this.reply(message, "Для цієї групи ще не підключено стікерпак."); return; }
    if (!binding.packName.toLowerCase().endsWith(`_by_${bot.username.toLowerCase()}`)) throw new Error("Sticker pack belongs to another bot");
    const link = `https://t.me/addstickers/${binding.packName}`;
    if (intent.action === "help") {
      await this.reply(message, `${link}\nАдміністратор може відповісти на зображення: @${bot.username} додай у стікери.\nДля видалення відповідай на стікер із цього пака: @${bot.username} видали цей стікер.\nКоманди: /stickeradd, /stickerdel. Фото й PNG/JPEG/WebP перетворюються на статичний стікер.`); return;
    }
    if (message.sender_chat || !Number.isSafeInteger(message.from?.id)) {
      await this.reply(message, "Для зміни пака напиши від свого акаунта, без анонімного режиму адміністратора."); return;
    }
    const member = await this.telegram("getChatMember", { chat_id: message.chat.id, user_id: message.from.id });
    if (!["creator", "administrator"].includes(member.status)) {
      await this.reply(message, "Додавати й видаляти стікери можуть лише адміністратори цієї групи."); return;
    }
    const media = stickerMedia(message);
    if (!media || (intent.action === "delete" && media.kind !== "sticker")) {
      await this.reply(message, intent.action === "add" ? "Прикріпи фото або PNG/JPEG/WebP, або відповідай на зображення чи готовий стікер." : "Відповідай на конкретний стікер із нашого нового пака, який треба видалити."); return;
    }
    if (intent.action === "delete" && media.set_name !== binding.packName) {
      await this.reply(message, "Цей стікер належить іншому паку. Надішли його саме з нашого нового пака."); return;
    }
    const state = await this.loadState();
    const key = `${message.chat.id}:${message.message_id}:${intent.action}`;
    let job = state.jobs[key];
    if (job && (job.packName !== binding.packName || job.ownerId !== binding.ownerId || job.userId !== message.from.id)) throw new Error("Sticker action binding changed");
    if (job?.status === "done") { await this.reply(message, `Цей запит уже виконано.\n${link}`); return; }
    const pack = await this.telegram("getStickerSet", { name: binding.packName });
    if (pack.sticker_type !== "regular") throw new Error("Only regular group sticker packs are supported");
    if (intent.action === "add") {
      if (!job) {
        if (media.kind === "sticker" && media.set_name === binding.packName) { await this.reply(message, `Цей стікер уже є в нашому паку.\n${link}`); return; }
        if (pack.stickers.length >= 120) { await this.reply(message, "У паку вже 120 стікерів. Спершу видали непотрібний."); return; }
        const previous = Object.values(state.jobs).find(j => j.status === "done" && j.action === "add" && j.packName === binding.packName && j.sourceUniqueId === media.file_unique_id && j.resultFileId && pack.stickers.some(s => s.file_id === j.resultFileId));
        if (previous) { await this.reply(message, `Це зображення вже додано.\n${link}`); return; }
        let fileId = media.file_id;
        if (media.kind === "image") {
          const image = await this.prepareImage(media);
          const form = new FormData();
          form.set("user_id", String(binding.ownerId)); form.set("sticker_format", "static");
          form.set("sticker", new Blob([image.buffer], { type: "image/webp" }), "sticker.webp");
          fileId = (await this.telegramMultipart("uploadStickerFile", form)).file_id;
        }
        const format = media.kind === "image" ? "static" : media.is_video ? "video" : media.is_animated ? "animated" : "static";
        job = state.jobs[key] = { action: "add", status: "prepared", packName: binding.packName, ownerId: binding.ownerId,
          userId: message.from.id, sourceUniqueId: media.file_unique_id, fileId, format,
          emoji: emojiFrom(intent.text, media.emoji || "😂"), beforeIds: pack.stickers.map(s => s.file_unique_id), updatedAt: Date.now() };
        await this.saveState(state);
      }
      // Retry the same uploaded file after a crash. Telegram ignores exact duplicates.
      await this.telegram("addStickerToSet", { user_id: binding.ownerId, name: binding.packName,
        sticker: { sticker: job.fileId, format: job.format, emoji_list: [job.emoji] } });
      const after = await this.telegram("getStickerSet", { name: binding.packName });
      const added = after.stickers.filter(s => !job.beforeIds.includes(s.file_unique_id));
      job.resultFileId = added.length === 1 ? added[0].file_id : null;
      job.status = "done"; job.updatedAt = Date.now();
      await this.saveState(state);
      await this.reply(message, `${added.length ? "Додано стікер" : "Стікер уже є в паку"}. У паку ${after.stickers.length} стікерів.\n${link}`);
      if (job.resultFileId) await this.telegram("sendSticker", { chat_id: message.chat.id, sticker: job.resultFileId,
        reply_to_message_id: message.message_id, ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}) }).catch(error => this.log("sticker_preview_failed", error));
    } else {
      const existing = pack.stickers.find(s => s.file_unique_id === media.file_unique_id);
      if (!existing) {
        if (job) { job.status = "done"; job.updatedAt = Date.now(); await this.saveState(state); }
        await this.reply(message, `Цього стікера вже немає в паку.\n${link}`); return;
      }
      if (pack.stickers.length <= 1) { await this.reply(message, "Не видалятиму останній стікер, щоб зберегти пак. Спершу додай інший."); return; }
      if (!job) {
        job = state.jobs[key] = { action: "delete", status: "prepared", packName: binding.packName, ownerId: binding.ownerId,
          userId: message.from.id, fileId: existing.file_id, updatedAt: Date.now() };
        await this.saveState(state);
      }
      await this.telegram("deleteStickerFromSet", { sticker: existing.file_id });
      const after = await this.telegram("getStickerSet", { name: binding.packName });
      if (after.stickers.some(s => s.file_unique_id === media.file_unique_id)) throw new Error("Sticker deletion was not applied");
      job.status = "done"; job.updatedAt = Date.now(); await this.saveState(state);
      await this.reply(message, `Стікер видалено. У паку ${after.stickers.length} стікерів.\n${link}`);
    }
  }
}
