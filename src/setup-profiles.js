import { escapeRegex } from "./helpers.js";
import { ruleRequest } from "./message-rules.js";

export const profileSettingsKeys = ["assemble", "reaction", "sticker", "modes", "disabled", "rules"];
export const profileTitle = profile => profile.label || profile.name;

export const creationIntent = /(?:create (?:a )?(?:new )?profile|new profile|созда(?:й|ть) (?:новый )?профиль|новый профиль|створи (?:новий )?профіль|новий профіль)/iu;
export const profileListIntent = /(?:list(?: all)?(?: available)? profiles|(?:show|available|which|what).*profiles|спис[оа]к.*профил|(?:покажи|выведи).*(?:все|доступн).*профил|(?:покажи|выведи)\s+(?:пожалуйста\s+)?профили|(?:какие|перечисл).*профил|доступн.*профил|список.*профіл|(?:перелічи|які).*профіл|покажи\s+(?:всі\s+)?профілі)/iu;
export const assignmentIntent = /(?:assign|switch|use|turn on|назнач|переключ|используй|включи|примени|признач|перемкни|використовуй|увімкни|застосуй).*(?:profile|профил|профіл)|use default|общий профиль|загальний профіль/iu;

export function matchesProfile(text, profile) {
  const name = profileTitle(profile).normalize("NFKC").trim().toLowerCase();
  const value = String(text).normalize("NFKC").trim().toLowerCase();
  return value === name || new RegExp(`(?<![\\p{L}\\p{N}_@])${escapeRegex(name)}(?![\\p{L}\\p{N}_])`, "u").test(value);
}

export function selectProfile(profiles, text) {
  const matches = Object.entries(profiles).filter(([, record]) => matchesProfile(text, record));
  const length = Math.max(0, ...matches.map(([, record]) => profileTitle(record).length));
  const best = matches.filter(([, record]) => profileTitle(record).length === length);
  return best.length === 1 ? best[0][0] : undefined;
}

export function isSetupRequest(message) {
  const text = message.text ?? message.caption ?? "";
  return /^\/setup(?:@\w+)?(?:\s|$)/iu.test(text) || creationIntent.test(text) ||
    ruleRequest.test(text) || /(?:configure|настро|налашту).*(?:reaction|реакц)/iu.test(text) ||
    profileListIntent.test(text) || assignmentIntent.test(text) ||
    /(?:what|which|какой|какие|який|які).*(?:profile|профил|профіл|настройк|налаштуван)/iu.test(text) ||
    /(?:show|tell me|edit|configure|покажи|расскажи|измени|настро|налашту|зміни).*(?:profile|профил|профіл|internal settings|внутренн.*настрой|налаштуван.*бот)/iu.test(text);
}

export function initialProfileSettings() {
  return { modes: { memory: "manual", voice: "manual", analysis: "on", download: "off", minigames: "off" } };
}

// Assign a snapshot so edits made in one chat never mutate another chat or the
// reusable source profile. History and room data are stored outside these keys.
export function assignGroupProfile(state, id, profileId, revision) {
  const selected = state.profiles[profileId ?? state.defaultProfile];
  if (!selected) throw new Error("Unknown profile");
  const group = state.groups[id];
  if (!group) throw new Error("Unknown group");
  for (const key of profileSettingsKeys) delete group[key];
  delete group.character;
  Object.assign(group, structuredClone(selected.settings ?? initialProfileSettings()));
  const { settings: ignored, ...persona } = selected;
  Object.assign(group, { persona: structuredClone(persona), profile: profileId, profileRevision: revision, configured: true, awaitingProfile: false });
  releaseInactiveStickerBindings(state, id, group);
}

export function stickerConflict(state, groupId, settings) {
  if (!settings.sticker || settings.disabled?.sticker) return false;
  const name = settings.sticker.packName.toLowerCase();
  return Object.entries(state.groups).some(([id, group]) => id !== String(groupId) &&
    group.active !== false && group.configured !== false &&
    !group.disabled?.sticker && group.sticker?.packName.toLowerCase() === name);
}

// A departed group can keep its settings, but cannot reclaim a pack that the
// owner has since confirmed for another group when the bot rejoins it.
export function releaseInactiveStickerBindings(state, groupId, settings) {
  if (!settings.sticker || settings.disabled?.sticker) return;
  const name = settings.sticker.packName.toLowerCase();
  for (const [id, group] of Object.entries(state.groups)) {
    if (id !== String(groupId) && (group.active === false || group.configured === false) &&
      group.sticker?.packName.toLowerCase() === name) {
      group.disabled ??= {};
      group.disabled.sticker = true;
    }
  }
}
