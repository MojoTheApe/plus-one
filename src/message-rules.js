import { randomUUID } from "node:crypto";
import { availableRuleAction } from './group-commands.js';

export const ruleActions = ["judge", "assemble", "animation", "message", "persona"];
export const ruleRequest = /(?:create|add|configure|list|show|delete|remove).*(?:rule|trigger)|(?:созда|добав|настро|список|покажи|выведи|перечисли|удал).*(?:правил|триггер)|(?:створи|додай|налашту|список|покажи|видал).*(?:правил|тригер)/iu;
export const normalizePhrase = text => String(text).normalize("NFKC").toLowerCase()
  .replace(/ё/gu, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const isRulePhrase = text => typeof text === "string" && text.length <= 1024 && Boolean(normalizePhrase(text)) &&
  !/^(?:[>“«„"'`]|\/)/u.test(text.trim()) && !/(?:^|\n)\s*>/u.test(text);

export function validateMessageRules(rules) {
  if (!Array.isArray(rules) || rules.length > 32) throw new Error("Use at most 32 message rules per group");
  const phrases = new Set(), ids = new Set();
  return rules.map(rule => {
    const alternatives = rule.phrases ?? [rule.phrase];
    const normalized = Array.isArray(alternatives) ? alternatives.map(normalizePhrase) : [];
    const phrase = normalizePhrase(rule?.phrase ?? "");
    if (!isRulePhrase(rule.phrase) ||
      (rule.enabled !== undefined && typeof rule.enabled !== "boolean") ||
      (rule.createdAt !== undefined && (typeof rule.createdAt !== "string" || !Number.isFinite(Date.parse(rule.createdAt)))) ||
      !ruleActions.includes(rule.action?.type) || !["owner", "members"].includes(rule.access) ||
      typeof rule.id !== "string" || !/^[\w-]{1,80}$/u.test(rule.id) || ids.has(rule.id) || phrases.has(phrase) ||
      !normalized.length || normalized.length > 16 || !normalized.includes(phrase) || alternatives.some(x => !isRulePhrase(x)) || new Set(normalized).size !== normalized.length || normalized.some(x => phrases.has(x)) ||
      (rule.match !== undefined && !['exact','contains'].includes(rule.match)) ||
      (rule.announcement !== undefined && (typeof rule.announcement !== "string" || rule.announcement.length > 2000))) {
      throw new Error("Invalid or duplicate message rule");
    }
    const action = rule.action;
    if (action.type === "persona" && (rule.access !== "owner" || typeof action.profile !== "string" || !action.profile)) throw new Error("Personality rules require an owner and a profile");
    if (action.type === "assemble" && (typeof action.game !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/u.test(action.game))) throw new Error("Unknown rule game");
    if (action.type === "animation" && (typeof action.animation !== "string" || !action.animation.trim())) throw new Error("Animation rule requires a Telegram animation");
    if (action.type === 'message' && (typeof action.text !== 'string' || !action.text.trim() || action.text.length > 2000)) throw new Error('Message rule requires text');
    if (action.type === "judge" && action.scope !== undefined && !["single", "all"].includes(action.scope)) throw new Error("Unknown judge rule scope");
    ids.add(rule.id); normalized.forEach(x => phrases.add(x));
    return structuredClone(rule);
  });
}

export function matchMessageRule(rules, message) {
  if (!["group", "supergroup"].includes(message.chat?.type) || !Number.isSafeInteger(message.from?.id) || message.from?.is_bot ||
    message.forward_origin || message.forward_from || message.forward_date || message.via_bot ||
    typeof (message.text ?? message._voiceTranscript) !== "string") return null;
  if ((message.entities ?? []).some(entity => ["blockquote", "expandable_blockquote", "pre", "code"].includes(entity.type))) return null;
  const body = (message.text ?? message._voiceTranscript).trim();
  if (/^(?:[>“«„"'`]|\/)/u.test(body) || /(?:^|\n)\s*>/u.test(body)) return null;
  const phrase = normalizePhrase(body);
  return (rules ?? []).find(rule => rule.enabled !== false &&
    (!rule.createdAt || Number.isSafeInteger(message.date) && message.date >= Math.floor(Date.parse(rule.createdAt) / 1000)) &&
    (rule.phrases ?? [rule.phrase]).some(value => rule.match === 'contains' ? ` ${phrase} `.includes(` ${normalizePhrase(value)} `) : normalizePhrase(value) === phrase)) ?? null;
}

export function ruleDecision(rule) {
  switch (rule.action.type) {
    case "judge": return { action: "judge", judgeScope: rule.action.scope ?? "single" };
    case "assemble": return { action: "assemble", gameIds: [rule.action.game] };
    case "animation": return { action: "animation", animation: rule.action.animation };
    case "message": return { action: "message", text: rule.action.text };
    case "persona": return { action: "persona", profile: rule.action.profile };
    default: throw new Error("Unknown message rule action");
  }
}

// Claim before attempting an external action. A persisted high-water mark avoids
// replaying a summon/announcement after a crash or an uncertain Telegram result.
// Personality selection and its receipt commit in the same SQLite transaction.
export function claimRuleAction(store, message, rule) {
  const group = store.group(message.chat.id);
  if (!availableRuleAction(group, rule, store.state.profiles) || !Number.isSafeInteger(message.from?.id) || !Number.isSafeInteger(message.message_id) ||
    !group.rules?.some(item => item.id === rule.id && item.enabled !== false) ||
    (rule.access === "owner" && message.from.id !== store.ownerId)) return false;
  if (group.ruleReceipts?.[rule.id]?.messageId >= message.message_id) return false;
  const profile = rule.action.type === "persona" ? store.state.profiles[rule.action.profile] : null;
  if (rule.action.type === "persona" && (!profile || message.from.id !== store.ownerId)) return false;
  store.change(state => {
    const target = state.groups[message.chat.id];
    target.ruleReceipts ??= {};
    target.ruleReceipts[rule.id] = { messageId: message.message_id, status: "attempted" };
    if (profile) {
      const { settings: ignored, ...persona } = profile;
      if (target.character?.profile !== rule.action.profile || JSON.stringify(target.character.persona) !== JSON.stringify(persona)) {
        target.character = { profile: rule.action.profile, persona: structuredClone(persona), revision: randomUUID() };
      }
    }
  });
  return true;
}

export function finishRuleAction(store, message, rule, status) {
  store.change(state => {
    const receipt = state.groups[message.chat.id]?.ruleReceipts?.[rule.id];
    if (receipt?.messageId === message.message_id) receipt.status = status;
  });
}
