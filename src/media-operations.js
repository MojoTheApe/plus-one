import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mediaReference } from "./media-source.js";
import { say } from "./helpers.js";

const durationText = n => { const seconds = Math.ceil(n); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; };
export function mediaFailure(error, { maxDurationSeconds = 300, maxUploadBytes = 48 * 1024 * 1024, stage = "download" } = {}) {
  if (["MEDIA_SOURCE_UNVERIFIED", "MEDIA_SOURCE_MISMATCH"].includes(error?.code)) return {
    code: error.code === "MEDIA_SOURCE_MISMATCH" ? "SOURCE_MISMATCH" : "SOURCE_UNVERIFIED", retryable: false, stage: "download", status: null,
    reason: error.code === "MEDIA_SOURCE_MISMATCH"
      ? "Отриманий матеріал не збігається з конкретною публікацією за посиланням. Не надсилаю підміну."
      : "Завантажувач не підтвердив, що файли належать саме цій публікації. Не надсилаю неперевірений набір; можна надіслати сам потрібний файл.",
  };
  if (error?.deliveryUnknown) return { code: "UPLOAD_UNKNOWN", retryable: true, stage: "upload", status: error.status || null,
    transportCode: error.transportCode || error.cause?.code || null,
    reason: "Не отримав підтвердження від Telegram. Файл міг уже з’явитися в чаті, тому автоматично його не дублюю. Перевір чат; якщо файлу немає, попроси повторити надсилання." };
  if (error?.code === "MEDIA_RETRY_CACHE_MISSING") return { code: "RETRY_CACHE_MISSING", retryable: false, stage: "prepare", status: null,
    reason: "Частину файлів уже надіслано, але підготовлена копія решти більше недоступна. Не повторюю весь набір, щоб не дублювати вже надіслане. Потрібні відсутні файли окремо." };
  if (error?.code === "THREADS_RENDER_UNAVAILABLE") return { code: "SOURCE_CONTENT_UNAVAILABLE", retryable: true, stage: "download", status: null,
    reason: "Threads повернув сторінку без самого вмісту публікації, тому отримати файл цим способом зараз не вдалося. Це не помилка формату відео. Можна надіслати сам файл або іншу доступну копію." };
  if(error?.code === 'SOCIAL_DOWNLOAD_TIMEOUT') return {
    code:'TIMEOUT',retryable:true,stage,status:null,reason:'Вичерпано час цієї спроби; роботу зупинено. Можна повторити пізніше.',
    ...(Number.isFinite(error.elapsedSeconds)?{elapsedSeconds:error.elapsedSeconds}:{}),
    ...(error.attempts?.length?{causes:error.attempts.map(attempt=>({provider:attempt.provider,...mediaFailure(attempt.error,{maxDurationSeconds,maxUploadBytes,stage})}))}:{}),
  };
  if (Array.isArray(error?.attempts) && error.attempts.length) {
    const causes = error.attempts.slice(0, 6).map(attempt => ({ provider: String(attempt.provider || "downloader").slice(0, 32),
      ...mediaFailure(attempt.error, { maxDurationSeconds, maxUploadBytes, stage }) }));
    // Prefer the first useful cause, rather than the last, often empty, fallback.
    const selected = causes.find(cause => ["SOURCE_MISMATCH", "SOURCE_UNVERIFIED"].includes(cause.code)) || causes.find(cause => !["UNKNOWN", "NO_MEDIA"].includes(cause.code)) || causes[0];
    const { provider, ...failure } = selected;
    return { ...failure, causes, ...(Number.isFinite(error.elapsedSeconds) ? { elapsedSeconds: error.elapsedSeconds } : {}) };
  }
  // execFile's message includes the entire command. Options such as
  // --socket-timeout are not evidence that a timeout actually happened.
  const message = String(error?.stderr || error?.message || "").replace(/^Command failed:[^\n]*\n?/u, "");
  const status = error?.status || error?.statusCode;
  let code = "UNKNOWN", retryable = false, reason;
  if (error?.code === "SOCIAL_VIDEO_DURATION_LIMIT" || /longer than/i.test(message)) {
    code = "DURATION_LIMIT";
    reason = Number.isFinite(error.actualDurationSeconds)
      ? `Відео триває ${durationText(error.actualDurationSeconds)}, а дозволений максимум — ${durationText(maxDurationSeconds)}.`
      : `Відео довше за дозволений максимум ${durationText(maxDurationSeconds)}.`;
    reason += " За поточним правилом я його не надсилаю.";
  } else if (error?.code === "MEDIA_DURATION_UNKNOWN") {
    code = "METADATA"; reason = `Не вдалося визначити тривалість відео, тому я не можу перевірити ліміт ${durationText(maxDurationSeconds)}.`;
  } else if (error?.code === "MEDIA_UPLOAD_SIZE" || status === 413 || /Request Entity Too Large|Payload Too Large|max-filesize|exceeds|larger than|file is too big/i.test(message)) {
    code = "SIZE_LIMIT";
    const size = Number.isFinite(error.actualBytes) ? `Файл має розмір ${(error.actualBytes / 1024 / 1024).toFixed(1)} МіБ. ` : "";
    reason = size + (stage === "upload" || error.code === "MEDIA_UPLOAD_SIZE"
      ? `Файл перевищує допустимий розмір надсилання (робочий ліміт ${(maxUploadBytes / 1024 / 1024).toFixed(0)} МіБ). Потрібна менша версія.`
      : "Файл перевищує ліміт завантаження або сервіс відхилив завеликий запит. Потрібна менша версія.");
  } else if (error?.code === "SOCIAL_VIDEO_PROVIDER_COOLDOWN" || status === 429 || /cooling down|rate.?limit|too many requests|\b429\b/i.test(message)) {
    code = "RATE_LIMIT"; retryable = true;
    reason = "Сервіс тимчасово обмежив кількість запитів. Спробуй ще раз пізніше.";
  } else if (error?.killed || error?.name === "AbortError" || error?.code === "SOCIAL_DOWNLOAD_TIMEOUT" || /AbortError|aborted|timeout|timed out/i.test(message)) {
    code = "TIMEOUT"; retryable = true;
    reason = "Сервіс не відповів за відведений час, тому спробу зупинено. Можна повторити завантаження.";
    if (Number.isFinite(error.elapsedSeconds)) reason += ` Спроба тривала ${Math.round(error.elapsedSeconds)} с.`;
  } else if (status === 401 || /private|log[ -]?in|sign[ -]?in|authentication|login.required|cookies? (?:are )?required|use --cookies/i.test(message)) {
    code = "AUTH_REQUIRED"; reason = "Цей спосіб завантаження повідомив, що потрібен вхід в акаунт або доступ до приватного медіа. Можна надіслати сам файл.";
  } else if (/unsupported URL|no suitable extractor|unsupported site/i.test(message)) {
    code = "UNSUPPORTED"; reason = "Завантажувач не підтримує цей формат посилання. Повтор тієї самої спроби не допоможе; можна надіслати пряме посилання на допис або сам файл.";
  } else if (status === 403 || status === 404 || /deleted|not available|unavailable|not accessible|audience|geo.?restrict|\b404\b/i.test(message)) {
    code = "UNAVAILABLE"; reason = "Сервіс не повернув доступне медіа: допис міг бути видалений, обмежений або недоступний через цей спосіб завантаження.";
  } else if (/no (?:downloadable |playable )?(?:media|images|video)|empty media response|media response was empty|returned no media/i.test(message)) {
    code = "NO_MEDIA"; retryable = true; reason = "Спосіб завантаження не повернув медіафайлів. Саме по собі це не пояснює, чому допис недоступний.";
  } else if (/ENOENT|ffprobe|media validator/i.test(message)) {
    code = "SERVER_TOOL"; reason = "На сервері не вдалося запустити інструмент завантаження або перевірки медіа. Потрібна перевірка конфігурації.";
  } else if (/stream|returned HTML|media type|convert|encode/i.test(message)) {
    code = "FORMAT"; reason = "Сервіс повернув непідтримуваний або пошкоджений медіафайл; підготувати його для Telegram не вдалося.";
  } else if (status >= 500 || /ECONNRESET|fetch failed|network/i.test(message)) {
    code = "SERVICE_ERROR"; retryable = true; reason = "Сервіс завантаження або Telegram повернув тимчасову мережеву помилку. Можна повторити спробу.";
  } else {
    retryable = true;
    reason = "Точну причину поки не визначено. Діагностику збережено для перевірки; спробуй інше публічне посилання або надішли файл.";
  }
  return { code, retryable, reason, stage, status: status || null,
    ...(Number.isFinite(error?.retryAfterSeconds) ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(Number.isFinite(error.actualDurationSeconds) ? { actualDurationSeconds: error.actualDurationSeconds } : {}),
    ...(Number.isFinite(error.actualBytes) ? { actualBytes: error.actualBytes } : {}) };
}

export function failureMessage(failure, id, locale = "uk") {
  if (["SOURCE_UNVERIFIED", "SOURCE_MISMATCH"].includes(failure.code)) {
    const reason = failure.code === "SOURCE_MISMATCH" ? say(locale,
      "The retrieved material does not match the exact linked publication. I have not sent it.",
      "Полученный материал не соответствует конкретной публикации по ссылке. Я его не отправил.",
      "Отриманий матеріал не збігається з конкретною публікацією за посиланням. Я його не надіслав.") : say(locale,
      "The downloader could not confirm that the files belong to this exact publication. I have not sent the unverified files. You can attach the original file.",
      "Загрузчик не подтвердил, что файлы относятся именно к этой публикации. Непроверенные файлы не отправлены. Можно прикрепить исходный файл.",
      "Завантажувач не підтвердив, що файли належать саме цій публікації. Неперевірені файли не надіслано. Можна прикріпити оригінальний файл.");
    const nativeLogin = failure.causes?.some(cause => cause.provider === "yt-dlp" && cause.code === "AUTH_REQUIRED")
      ? " " + say(locale, "The native extractor also reported that login is required.", "Основной загрузчик также сообщил, что требуется вход в аккаунт.", "Основний завантажувач також повідомив, що потрібен вхід в акаунт.") : "";
    return `${reason}${nativeLogin}\n${failure.code}${id ? ` · ${id}` : ""}`;
  }
  const stages = { download: "отримання медіа", prepare: "перевірка й підготовка", upload: "надсилання до Telegram" };
  const title = failure.code === "UPLOAD_UNKNOWN" ? "Не вдалося підтвердити надсилання медіа" : "Не вдалося надіслати медіа";
  const causes = failure.causes?.length > 1 ? "\n" + failure.causes.map(cause => `${cause.provider}: ${cause.reason}`).join("\n") : "";
  return `${title}: ${failure.reason}${causes}\nЕтап: ${stages[failure.stage] || failure.stage}. Код: ${failure.code}${id ? ` · ${id}` : ""}.`;
}

export function isMediaRetryText(text, username = "") {
  const value = String(text || "").replace(new RegExp("@" + username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi"), "").trim();
  // A cheap path for canonical commands only; semantic routing owns other wording.
  return /^(?:(?:будь ласка|please)[,\s]+)?(?:repeat|retry|try again|повтори|повторити|спробуй(?:\s+ще)?\s+раз)(?:[,\s]+(?:будь ласка|please))?[.!?\s]*$/iu.test(value);
}

export class MediaOperations {
  constructor(file, now = Date.now) { this.file = file; this.now = now; this.queue = Promise.resolve(); }
  async read() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.operations)) throw new Error("Invalid media operations state");
      return data.operations.filter(op => this.now() - op.updatedAt < 48 * 3600 * 1000);
    } catch (error) { if (error.code !== "ENOENT") throw error; return []; }
  }
  async record(operation) {
    const work = this.queue.then(async () => {
      const all = await this.read();
      const previous = all.find(op => op.id === operation.id);
      const entry = { ...previous, ...operation, id: operation.id || randomUUID().slice(0, 8), updatedAt: this.now() };
      entry.topicId = operation.topicId !== undefined ? operation.topicId : entry.topicId ?? entry.threadId ?? null;
      entry.threadId = entry.topicId;
      entry.referenceMessageIds = [...new Set([...operationReferences(previous), ...operationReferences(entry)])].slice(-50);
      const next = [entry, ...all.filter(op => op.id !== entry.id)].slice(0, 300);
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, JSON.stringify({ version: 1, operations: next }), { mode: 0o600 }); await fs.rename(temp, this.file); }
      finally { await fs.rm(temp, { force: true }); }
      return entry;
    });
    this.queue = work.catch(() => {}); return work;
  }
  async find(message, allowLatest = false, scope = {}) {
    const chatId = scope.chatId ?? message.chat.id;
    const topicId = scope.topicId !== undefined ? scope.topicId : message.is_topic_message === true ? message.message_thread_id ?? null : null;
    const all = (await this.read()).filter(op => String(op.chatId) === String(chatId) && (op.topicId ?? op.threadId ?? null) === topicId);
    const targets = [...(scope.referenceMessageIds || [])];
    let reply = message.reply_to_message;
    for (let depth = 0; reply && depth < 8; depth++, reply = reply.reply_to_message) targets.push(reply.message_id);
    // Exact references are allowed across participants, but never across chats/topics.
    for (const target of targets) {
      const operation = all.find(op => operationReferences(op).includes(target));
      if (operation) return operation;
    }
    if (targets.length) return null;
    return allowLatest ? all.find(op => op.userId === message.from?.id && op.status !== "done") || null : null;
  }
  async evidence(message, { referenceMessageIds = [], topicId = null } = {}) {
    const references = new Set(referenceMessageIds.filter(Number.isSafeInteger));
    return (await this.read()).filter(operation => String(operation.chatId) === String(message.chat.id) &&
      (operation.topicId ?? operation.threadId ?? null) === topicId && operationReferences(operation).every(id => id < message.message_id) &&
      operationReferences(operation).some(id => references.has(id)))
      .slice(0, 4).map(operation => ({ id: operation.id, sourceMessageId: operation.sourceMessageId,
        trigger: operation.trigger || null, lastRequest: operation.lastRequest || null, requestedUrl: mediaReference(operation.url)?.url || null,
        sourceVerification: operation.source?.status || "unverified-legacy", verifiedSource: operation.source?.status === "verified" ? operation.source.resolved : null,
        downloader: operation.downloader || operation.source?.provider || "not-recorded", attempts: operation.attempts || [],
        status: operation.status, sentMessageIds: operation.sentMessageIds || [], deliveredFileCount: operation.deliveredFileCount || 0,
        failure: operation.failure ? { code: operation.failure.code, stage: operation.failure.stage, reason: operation.failure.reason, causes: operation.failure.causes || [] } : null }));
  }
}

function operationReferences(operation) {
  if (!operation) return [];
  return [operation.sourceMessageId, operation.lastRequest?.messageId, operation.trigger?.messageId, operation.errorMessageId, operation.sentMessageId,
    ...(operation.sentMessageIds || []), ...(operation.referenceMessageIds || [])].filter(Number.isSafeInteger);
}
