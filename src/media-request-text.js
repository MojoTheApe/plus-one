import { say } from "./helpers.js";
import { failureMessage } from "./media-operations.js";

const platforms = new Map([["instagram", "Instagram"], ["tiktok", "TikTok"], ["threads", "Threads"]]);

function baseLanguage(locale) {
  return locale?.split("-")[0].toLowerCase();
}

export function mediaPreparingText(locale) {
  return say(baseLanguage(locale), "Preparing media…", "Готовлю медиа…", "Готую медіа…");
}

function requestReason({ provider, failure }, locale, multipleFailures, grouped = false) {
  const t = (en, ru, uk) => say(locale, en, ru, uk);
  const site = platforms.get(provider);
  if (failure.code === "UPLOAD_UNKNOWN") return failureMessage(failure, locale);
  if (failure.telegramRejected && failure.code !== "SIZE_LIMIT") {
    if (grouped) return t("Telegram declined the files.", "Telegram отклонил файлы.", "Telegram відхилив файли.");
    return t("Telegram declined the file.", "Telegram отклонил файл.", "Telegram відхилив файл.");
  }
  switch (failure.code) {
    case "SOURCE_RETRY_EXHAUSTED":
    case "RATE_LIMIT":
      if (failure.stage === "upload" && failure.confirmedRateLimit) {
        return t("Telegram temporarily limited sending.", "Telegram временно ограничил отправку.", "Telegram тимчасово обмежив надсилання.");
      }
      if (site && (failure.confirmedRateLimit || failure.code === "SOURCE_RETRY_EXHAUSTED")) {
        return t(`${site} temporarily limited downloads.`, `${site} временно ограничил скачивание.`, `${site} тимчасово обмежив завантаження.`);
      }
      return t("Downloads are temporarily paused.", "Скачивание временно приостановлено.", "Завантаження тимчасово призупинено.");
    case "AUTH_REQUIRED":
      if (grouped) return t("I don’t have access to these posts.", "У меня нет доступа к этим публикациям.", "Не маю доступу до цих публікацій.");
      return t("I don’t have access to this post.", "У меня нет доступа к этой публикации.", "Не маю доступу до цієї публікації.");
    case "SOURCE_CONTENT_UNAVAILABLE":
      if (grouped) return t("Threads didn’t show the posts.", "Threads не показал публикации.", "Threads не показав публікації.");
      return failureMessage(failure, locale);
    case "DOWNLOAD_DISABLED":
      return t("Media downloads are turned off for this group.", "В этой группе скачивание медиа отключено.", "У цій групі завантаження медіа вимкнено.");
    case "ALREADY_VISIBLE":
      if (Number.isSafeInteger(failure.messageId) && failure.messageId > 0) {
        return t(`The file is already in message #${failure.messageId}.`, `Файл уже есть в сообщении №${failure.messageId}.`, `Файл уже є в повідомленні №${failure.messageId}.`);
      }
      return t("The file is already in this chat.", "Файл уже есть в этом чате.", "Файл уже є в цьому чаті.");
    case "ADMIN_REQUIRED":
      return t("I need admin rights in this group to send media.", "Для отправки медиа мне нужны права администратора группы.", "Щоб надсилати медіа, мені потрібні права адміністратора групи.");
    case "SOURCE_RETRY_CAPACITY":
    case "CAPACITY":
    case "IN_PROGRESS":
    case "CACHE_BUSY":
      return t("The download queue is busy.", "Очередь загрузок занята.", "Черга завантажень зайнята.");
    case "GROUP_RATE_LIMIT":
      return t("This group has reached its download limit.", "Группа исчерпала свой лимит загрузок.", "Група вичерпала свій ліміт завантажень.");
    case "URL_BACKOFF":
    case "FAILURE_COOLDOWN":
      return t("Downloads are paused after recent failures.", "После сбоя загрузка временно приостановлена.", "Після попередніх збоїв завантаження тимчасово призупинено.");
    case "DURATION_LIMIT":
      return multipleFailures
        ? t("The video exceeds the duration limit.", "Видео длиннее допустимого.", "Відео перевищує дозволену тривалість.")
        : failureMessage(failure, locale);
    case "TIMEOUT":
    case "SERVICE_ERROR":
      if (site && failure.stage === "download" && failure.code === "TIMEOUT") {
        return t(`Couldn’t download the file from ${site} in time.`, `Не удалось вовремя получить файл из ${site}.`, `Не вдалося вчасно отримати файл із ${site}.`);
      }
      if (site && failure.stage === "download") {
        return t(`Couldn’t get the file from ${site}.`, `Не удалось получить файл из ${site}.`, `Не вдалося отримати файл із ${site}.`);
      }
      return failureMessage(failure, locale);
    case "SERVER_TOOL":
    case "FORMAT":
    case "METADATA":
      return t("Couldn’t prepare this file for Telegram.", "Не удалось подготовить файл для Telegram.", "Не вдалося підготувати файл для Telegram.");
    default:
      return failureMessage(failure, locale);
  }
}

export function mediaRequestFailureText(failures, profileLocale, totalLinks) {
  const locale = baseLanguage(profileLocale);
  const groups = new Map();
  for (const item of failures) {
    const reason = requestReason(item, locale, failures.length > 1);
    if (!groups.has(reason)) groups.set(reason, { item, numbers: new Set() });
    if (Number.isSafeInteger(item.number) && item.number > 0) groups.get(reason).numbers.add(item.number);
  }
  const lines = [];
  for (const [singleReason, { numbers, item }] of groups) {
    const reason = numbers.size > 1 ? requestReason(item, locale, true, true) : singleReason;
    if (!numbers.size || totalLinks === 1) {
      lines.push(reason);
      continue;
    }
    const sorted = [...numbers].sort((a, b) => a - b);
    const indices = sorted.slice(0, 6).join(", ") + (sorted.length > 6 ? ` (+${sorted.length - 6})` : "");
    const label = sorted.length > 1 ? say(locale, "Links", "Ссылки", "Посилання") : say(locale, "Link", "Ссылка", "Посилання");
    lines.push(`${label} ${indices} — ${reason}`);
  }
  return lines.join("\n");
}
