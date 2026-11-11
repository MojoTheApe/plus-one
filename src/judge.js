import { conversationThreadId } from './conversation-store.js';

function sanitizeSessionPart(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "unknown";
}

export function judgeThreadId(message) {
  return conversationThreadId(message);
}

export function filterJudgeCandidatesForThread(items, threadId) {
  const expected = Number.isSafeInteger(threadId) && threadId > 0 ? threadId : null;
  return (items || []).filter((item) => {
    const actual = Number.isSafeInteger(item.messageThreadId) && item.messageThreadId > 0
      ? item.messageThreadId
      : null;
    return actual === expected;
  });
}

export function buildJudgeCaseSessionKey(chatId, version, messageId, options = {}) {
  const thread = Number.isSafeInteger(options.threadId) && options.threadId > 0
    ? `t${options.threadId}`
    : "tmain";
  const phase = sanitizeSessionPart(options.phase || "verdict");
  const attempt = Number.isSafeInteger(options.attempt) && options.attempt > 1
    ? `-r${options.attempt}`
    : "";
  return [
    "telegram",
    sanitizeSessionPart(chatId),
    sanitizeSessionPart(version),
    "judge",
    thread,
    `m${sanitizeSessionPart(messageId)}`,
    `${phase}${attempt}`,
  ].join("-");
}

export function parseJudgeScopeText(text, validMessageIds = []) {
  const object = parseFirstJsonObject(text);
  const allowedIds = new Set(
    (validMessageIds || []).filter((value) => Number.isSafeInteger(value) && value > 0),
  );
  const status = ["ready", "ambiguous", "insufficient"].includes(object?.status)
    ? object.status
    : "ready";
  const messageIds = uniquePositiveIntegers(object?.messageIds)
    .filter((value) => allowedIds.size === 0 || allowedIds.has(value));
  const materialPublicClaims = (Array.isArray(object?.materialPublicClaims)
    ? object.materialPublicClaims
    : [])
    .map(normalizeClaim)
    .filter((claim) => claim.claim);

  return {
    status,
    topic: cleanText(object?.topic, 500),
    messageIds,
    materialPublicClaims,
    clarificationQuestion: cleanText(object?.clarificationQuestion, 700),
    reason: cleanText(object?.reason, 700),
  };
}

export function parseJudgeScopesText(text, validMessageIds = [], multiple = false) {
  const parsed = parseFirstJsonObject(text);
  if (multiple && !Array.isArray(parsed.disputes)) throw new Error("Multi-dispute extraction requires a disputes array");
  const entries = multiple ? parsed.disputes : [parsed];
  return entries.map(value => parseJudgeScopeText(JSON.stringify(value), validMessageIds));
}

export function selectRelevantJudgeMessages(candidates, messageIds, anchorMessageId) {
  const items = Array.isArray(candidates) ? candidates : [];
  const validIds = new Set(items.map((item) => item.messageId));
  const selected = new Set(
    uniquePositiveIntegers(messageIds).filter((messageId) => validIds.has(messageId)),
  );
  if (validIds.has(anchorMessageId)) selected.add(anchorMessageId);
  if (selected.size === 0) return [...items];

  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (selected.has(item.messageId) && validIds.has(item.replyToMessageId) && !selected.has(item.replyToMessageId)) {
        selected.add(item.replyToMessageId);
        changed = true;
      }
      if (selected.has(item.replyToMessageId) && !selected.has(item.messageId)) {
        selected.add(item.messageId);
        changed = true;
      }
    }
  }

  return items.filter((item) => selected.has(item.messageId));
}

export function buildJudgeHistoryExcerpt(items, maxChars, options = {}) {
  const formatter = typeof options.formatter === "function"
    ? options.formatter
    : (item) => String(item?.text || "");
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 24000;
  const source = Array.isArray(items) ? items : [];
  if (source.length === 0) return { text: "", includedItems: [], omittedCount: 0 };

  const maxLineChars = Math.max(300, Math.min(4000, Math.floor(limit / 3)));
  const lines = source.map((item) => trimLine(formatter(item), maxLineChars));
  const newestIndex = source.length - 1;
  const anchorIndex = source.findIndex((item) => item.messageId === options.anchorMessageId);
  const priority = [];
  if (anchorIndex >= 0) priority.push(anchorIndex);
  if (!priority.includes(newestIndex)) priority.push(newestIndex);
  for (let index = newestIndex - 1; index >= 0; index -= 1) {
    if (!priority.includes(index)) priority.push(index);
  }

  const selected = new Set();
  let used = 0;
  for (const index of priority) {
    const separator = selected.size > 0 ? 1 : 0;
    if (used + separator + lines[index].length > limit) continue;
    selected.add(index);
    used += separator + lines[index].length;
  }

  if (selected.size === 0) {
    selected.add(newestIndex);
    lines[newestIndex] = trimLine(lines[newestIndex], limit);
  }

  const indexes = [...selected].sort((a, b) => a - b);
  return {
    text: indexes.map((index) => lines[index]).join("\n"),
    includedItems: indexes.map((index) => source[index]),
    omittedCount: source.length - indexes.length,
  };
}

function parseFirstJsonObject(value) {
  const text = String(value || "").trim();
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error("Judge scope selection did not return valid JSON");
}

function uniquePositiveIntegers(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
}

function normalizeClaim(value) {
  if (typeof value === "string") return { claim: cleanText(value, 700), speaker: "" };
  return {
    claim: cleanText(value?.claim, 700),
    speaker: cleanText(value?.speaker, 200),
  };
}

function cleanText(value, maxChars) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function trimLine(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 4)).trimEnd()} ...`;
}
