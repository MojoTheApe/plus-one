import fs from "node:fs";
import path from "node:path";
import { normalizeGamePlayers } from "./assemble.js";
import { validateStickerBinding } from "./stickers.js";
import { validateMessageRules } from "./message-rules.js";

function checkFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key))) {
    throw new Error(`Invalid group settings: ${label}`);
  }
}

function animationPath(directory, value, label) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/\.(gif|mp4)$/i.test(value)) {
    throw new Error(`Invalid group settings animation file: ${label}`);
  }
  const resolved = path.resolve(directory, value);
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Missing group settings animation file: ${label}`);
  }
  return resolved;
}

export function loadGroupSettings(file, games) {
  if (!file) return null;
  let document;
  try { document = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("BOT_GROUP_SETTINGS_FILE must be a readable JSON file"); }
  checkFields(document, ["version", "chats"], "catalog");
  if (document.version !== 1 || !document.chats || typeof document.chats !== "object" || Array.isArray(document.chats)) {
    throw new Error("Invalid group settings catalog version or chats");
  }

  const directory = path.dirname(file);
  const gamesById = new Map(games.map(game => [game.id, game]));
  const chats = new Map();
  const stickerBindings = {};
  const usedPacks = new Set();

  for (const [key, settings] of Object.entries(document.chats)) {
    const chatId = Number(key);
    if (!/^-[1-9]\d*$/.test(key) || !Number.isSafeInteger(chatId)) throw new Error("Invalid group settings chat ID");
    checkFields(settings, ["assemble", "insultReply", "stickerPack", "title", "modes", "rules", "legacyMemory"], key);
    if (settings.title !== undefined && (typeof settings.title !== "string" || !settings.title)) throw new Error("Invalid group title");
    if (settings.modes !== undefined) {
      checkFields(settings.modes, ["memory", "voice", "analysis", "download", "minigames"], key + ".modes");
      for (const [feature, mode] of Object.entries(settings.modes)) {
        if (!(feature === "memory" || feature === "voice" ? ["off", "manual", "auto"] : ["on", "off"]).includes(mode)) throw new Error("Invalid group mode");
      }
    }
    if (settings.legacyMemory !== undefined) {
      checkFields(settings.legacyMemory, ["chatFile"], key + ".legacyMemory");
      const file = settings.legacyMemory.chatFile;
      if (typeof file !== "string" || !file.endsWith(".md") || file !== path.basename(file) || file.includes("\\")) throw new Error("Invalid legacy memory scope");
    }
    const rules = settings.rules === undefined ? undefined : validateMessageRules(settings.rules);

    let assemble;
    if (settings.assemble !== undefined) {
      const config = settings.assemble;
      checkFields(config, ["games", "globalAnimation"], `${key}.assemble`);
      const configured = config.games === undefined ? {} : config.games;
      checkFields(configured, [...gamesById.keys()], `${key}.assemble.games`);
      assemble = {
        animationPath: animationPath(directory, config.globalAnimation, `${key}.assemble.globalAnimation`),
        games: Object.entries(configured).map(([id, game]) => {
          checkFields(game, ["players", "animation"], `${key}.assemble.games.${id}`);
          return {
            ...gamesById.get(id),
            players: normalizeGamePlayers(game.players, id),
            animationPath: animationPath(directory, game.animation, `${key}.assemble.games.${id}`),
          };
        }),
      };
    }

    let insultReply;
    if (settings.insultReply !== undefined) {
      const config = settings.insultReply;
      checkFields(config, ["terms", "extraTerms", "animation", "animationFile"], `${key}.insultReply`);
      if ((config.animation === undefined) === (config.animationFile === undefined) ||
          (config.animation !== undefined && (typeof config.animation !== "string" || !config.animation.trim())) ||
          [config.terms, config.extraTerms].some(terms => terms !== undefined && (!Array.isArray(terms) ||
            terms.some(term => typeof term !== "string" || !/[\p{L}\p{N}_@]/u.test(term))))) {
        throw new Error(`Invalid group insult reply: ${key}`);
      }
      insultReply = {
        terms: config.terms,
        extraTerms: config.extraTerms,
        animation: config.animation?.trim(),
        mediaPath: animationPath(directory, config.animationFile, `${key}.insultReply.animationFile`),
      };
    }

    if (settings.stickerPack !== undefined) {
      checkFields(settings.stickerPack, ["packName", "ownerId"], `${key}.stickerPack`);
      validateStickerBinding(key, settings.stickerPack);
      const name = settings.stickerPack.packName.toLowerCase();
      if (usedPacks.has(name)) throw new Error("A sticker pack can only be assigned to one group");
      usedPacks.add(name);
      stickerBindings[key] = settings.stickerPack;
    }
    chats.set(chatId, { assemble, insultReply, rules, modes: settings.modes, legacyMemory: settings.legacyMemory, title: settings.title });
  }
  return { chats, stickerBindings };
}
